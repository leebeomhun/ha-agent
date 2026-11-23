"""소음 적응형 말 끝 감지(endpointing). Home Assistant 의존성 없이 순수 파이썬으로 돈다.

HA 코어 VAD는 "사람 목소리처럼 들리는가"로 판단해서, 작게 깔린 TV·대화 소리가 있으면 말이 끝나도
끝을 못 잡고 15초 제한까지 녹음한다. 여기서는 소리 크기를 기준으로,
  - 말하기 전 바닥 소음과 배경 소리(옆방 TV 등)의 큰 쪽 수준을 재고
  - 그보다 확실히 큰 소리만 사용자 말로 본 뒤
  - 사용자 말보다 충분히 작고 배경 수준 근처인 구간이 silence_ms 이어지면 끝으로 본다.
휴대폰·태블릿에 대고 말하는 보통의 상황(사용자 말이 배경보다 큼)에서 배경 대화가 있어도 말 끝을 잡는다.
"""
from __future__ import annotations

from array import array
from dataclasses import dataclass, field
import math
import sys

FRAME_MS = 20
_MIN_DB = -90.0


@dataclass
class EndpointConfig:
    enabled: bool = True
    silence_ms: int = 700           # 말이 끝난 뒤 이만큼(의 90% 이상) 조용하면 끝
    min_speech_ms: int = 250        # 이보다 짧은 소리는 말로 치지 않음(기침·딸깍 소리)
    max_seconds: float = 10.0       # 아무리 길어도 여기서 끊음(HA 기본 15초)
    no_speech_seconds: float = 6.0  # 이 시간 안에 말이 시작되지 않으면 끊음
    start_margin_db: float = 10.0   # 바닥 소음보다 이만큼 커야 말소리
    bg_margin_db: float = 6.0       # 말하기 전 배경 소리(큰 쪽)보다 이만큼 커야 말소리
    near_field_db: float = -32.0    # 배경을 아직 못 잰 첫 0.7초에는 이만큼 커야 말소리(가까이서 말함)
    end_margin_db: float = 6.0      # 바닥 소음보다 이만큼 이내면 조용함
    end_drop_db: float = 15.0       # 사용자 말 크기보다 이만큼 작으면 조용함
    end_bg_margin_db: float = 4.0   # 말하기 전 배경 소리(큰 쪽)+이만큼보다 작으면 조용함
    quiet_ratio: float = 0.9        # silence_ms 구간 중 이 비율 이상이 조용하면 끝
    preroll_ms: int = 500           # 말 시작 이만큼 전부터만 STT로 보냄(앞쪽 배경 TV 소리 제외)

    @classmethod
    def from_dict(cls, data: dict | None) -> "EndpointConfig":
        cfg = cls()
        for key, value in (data or {}).items():
            if hasattr(cfg, key) and value is not None:
                try:
                    kind = type(getattr(cfg, key))
                    setattr(cfg, key, (str(value).lower() in ("1", "true", "yes", "on")) if kind is bool and isinstance(value, str) else kind(value))
                except (TypeError, ValueError):
                    pass
        return cfg


@dataclass
class EndpointResult:
    reason: str            # silence | max | no_speech | stream_end
    cut_ms: int
    start_ms: int          # 말이 시작된 것으로 본 지점(못 잡았으면 0)
    noise_db: float
    background_db: float | None
    speech_db: float | None
    speech_ms: int


def _percentile(values: list[float], q: float) -> float:
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))]


@dataclass
class Endpointer:
    """16비트 리틀엔디언 모노 PCM을 조각조각 받아 말 끝을 판정한다.

    말하기 전: 최근 1.5초의 10백분위 = 바닥 소음, 0.3~1.3초 전 구간의 90백분위 = 배경 소리(옆방 TV 등)의 큰 쪽(0.7초부터).
    말소리 = 바닥보다 start_margin_db, 배경보다 bg_margin_db 이상 큰 프레임. 0.3초 중 0.16초 이상이면 말 시작.
    말 끝 = 최근 silence_ms 중 quiet_ratio 이상이 "바닥+end_margin / 말 크기-end_drop / 배경+end_bg_margin" 중 가장 높은 선보다 작을 때.
    """

    sample_rate: int = 16000
    config: EndpointConfig = field(default_factory=EndpointConfig)

    def __post_init__(self) -> None:
        self._frame_bytes = max(2, int(self.sample_rate * FRAME_MS / 1000) * 2)
        self._pending = bytearray()
        self._frames = 0
        self._history: list[float] = []   # 말 시작 전 프레임 크기(최근 1.5초)
        self._recent: list[bool] = []     # 최근 0.3초 말소리 여부
        self._quiet: list[bool] = []      # 말 시작 뒤 최근 silence_ms 조용함 여부
        self._noise = _MIN_DB
        self._bg: float | None = None
        self._started = False
        self._voiced = 0
        self._levels: list[float] = []    # 말 시작 뒤 말소리 프레임 크기
        self._start_frame = 0
        self._early: list[float] = []     # 배경을 재기 전(첫 0.7초) 프레임 크기 = 녹음과 동시에 말한 경우 판정용
        self._pre_quiet: list[bool] = []
        self.result: EndpointResult | None = None

    # ── 내부 계산 ──
    @staticmethod
    def _frame_db(frame: bytes) -> float:
        samples = array("h")
        samples.frombytes(frame)
        if sys.byteorder == "big":
            samples.byteswap()
        if not samples:
            return _MIN_DB
        total = 0
        for s in samples:
            total += s * s
        mean = total / len(samples) / (32768.0 * 32768.0)
        return max(_MIN_DB, 10.0 * math.log10(mean)) if mean > 0 else _MIN_DB

    def _ms(self, frames: int) -> int:
        return frames * FRAME_MS

    def _speech_level(self) -> float | None:
        return _percentile(self._levels, 0.9) if self._levels else None

    def _is_voiced(self, db: float) -> bool:
        cfg = self.config
        if db < self._noise + cfg.start_margin_db:
            return False
        if self._bg is None:
            return db >= cfg.near_field_db
        return db >= self._bg + cfg.bg_margin_db

    def _finish(self, reason: str) -> EndpointResult:
        level = self._speech_level()
        self.result = EndpointResult(
            reason=reason,
            cut_ms=self._ms(self._frames),
            start_ms=self._ms(self._start_frame),
            noise_db=round(self._noise, 1),
            background_db=round(self._bg, 1) if self._bg is not None else None,
            speech_db=round(level, 1) if level is not None else None,
            speech_ms=self._ms(self._voiced),
        )
        return self.result

    def _quiet_window(self, window: list[bool], quiet: bool) -> bool:
        """최근 silence_ms 동안 quiet_ratio 이상 조용했고 마지막 60ms가 조용하면 True."""
        cfg = self.config
        need = max(1, cfg.silence_ms // FRAME_MS)
        window.append(quiet)
        if len(window) > need:
            del window[0]
        return len(window) == need and sum(window) >= need * cfg.quiet_ratio and all(window[-3:])

    def _update_background(self, db: float) -> None:
        h = self._history
        h.append(db)
        if len(h) > 75:
            del h[0]
        self._noise = _percentile(h, 0.1) if len(h) >= 5 else min(h)
        older = h[:-15]
        self._bg = _percentile(older, 0.9) if len(older) >= 20 else None

    def _push_frame(self, db: float) -> EndpointResult | None:
        cfg = self.config
        self._frames += 1

        if not self._started:
            if self._bg is None:
                self._early.append(db)
            self._update_background(db)
            voiced = self._is_voiced(db)
            # 녹음과 동시에 말해서 배경이 사용자 목소리로 잡힌 경우: 첫 0.7초의 가까운 큰 소리를 말로 보고 그 뒤 조용해지면 끝.
            # 바닥 소음은 말 사이 틈을 본 뒤에야 맞게 잡히므로 매번 지금의 바닥 기준으로 다시 센다.
            loud = [d for d in self._early if d >= cfg.near_field_db and d >= self._noise + cfg.start_margin_db]
            if self._ms(len(loud)) >= cfg.min_speech_ms:
                line = max(self._noise + cfg.end_margin_db, _percentile(loud, 0.9) - cfg.end_drop_db)
                if self._quiet_window(self._pre_quiet, db < line):
                    self._levels = loud
                    self._voiced = len(loud)
                    self._start_frame = 0
                    return self._finish("silence")
            self._recent.append(voiced)
            if len(self._recent) > 15:
                del self._recent[0]
            if sum(self._recent) * FRAME_MS >= 160:
                self._started = True
                first = self._recent.index(True)
                self._start_frame = max(0, self._frames - len(self._recent) + first)
                self._voiced = sum(self._recent)
                self._levels = [d for d, v in zip(self._history[-len(self._recent):], self._recent) if v]
                self._quiet = []
        else:
            voiced = self._is_voiced(db)
            if voiced:
                self._voiced += 1
                self._levels.append(db)
            line = self._noise + cfg.end_margin_db
            level = self._speech_level()
            if level is not None:
                line = max(line, level - cfg.end_drop_db)
            if self._bg is not None:
                line = max(line, self._bg + cfg.end_bg_margin_db)
            if self._quiet_window(self._quiet, db < line):
                if self._ms(self._voiced) >= cfg.min_speech_ms:
                    return self._finish("silence")
                # 너무 짧았던 소리는 말이 아니었던 것으로 보고 다시 기다린다.
                self._started = False
                self._start_frame = 0
                self._voiced = 0
                self._levels = []
                self._recent = []
                self._quiet = []

        if self._ms(self._frames) >= cfg.max_seconds * 1000:
            return self._finish("max")
        if not self._started and self._ms(self._frames) >= cfg.no_speech_seconds * 1000:
            return self._finish("no_speech")
        return None

    # ── 공개 API ──
    def feed(self, chunk: bytes) -> EndpointResult | None:
        """PCM 조각을 넣는다. 끝을 판정하면 EndpointResult, 아니면 None."""
        if self.result is not None:
            return self.result
        self._pending.extend(chunk)
        fb = self._frame_bytes
        while len(self._pending) >= fb:
            frame = bytes(self._pending[:fb])
            del self._pending[:fb]
            res = self._push_frame(self._frame_db(frame))
            if res is not None:
                return res
        return None

    def keep_from_byte(self) -> int:
        """STT로 보낼 PCM 시작 위치(바이트). 말 시작 preroll_ms 전, 2바이트 경계."""
        if self.result is None or self.result.start_ms <= self.config.preroll_ms:
            return 0
        ms = self.result.start_ms - self.config.preroll_ms
        return int(self.sample_rate * ms / 1000) * 2

    def close(self) -> EndpointResult:
        """스트림이 먼저 끝났을 때(HA VAD가 끝을 잡은 경우) 통계를 남긴다."""
        return self.result or self._finish("stream_end")


def wav_data_offset(head: bytes) -> int | None:
    """RIFF/WAVE 머리면 data 시작 위치, 아니면 None(머리 없는 PCM)."""
    if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
        return None
    off = 12
    while off + 8 <= len(head):
        cid = head[off:off + 4]
        size = int.from_bytes(head[off + 4:off + 8], "little")
        if cid == b"data":
            return off + 8
        off += 8 + size + (size % 2)
    return None
