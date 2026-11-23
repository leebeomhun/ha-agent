"""Speech-to-Text entity forwarding HA Assist audio streams to ha-agent.

말 끝 감지(endpoint.py): HA 코어 VAD가 배경 TV·대화 소리 때문에 말 끝을 못 잡고 15초까지 녹음하는 문제를 막으려고,
오디오가 들어오는 동안 소리 크기 기준으로 말 끝을 직접 판정해 그 즉시 스트림 수신을 멈추고 전사를 요청한다.
설정은 ha-agent의 /api/assist/voice-config(config.json assist.voice.endpoint)에서 받아 5분 동안 캐시한다.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable
import io
import logging
import time
import wave

import aiohttp
from homeassistant.components import stt
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_TOKEN, CONF_URL
from .endpoint import EndpointConfig, Endpointer, wav_data_offset

_LOGGER = logging.getLogger(__name__)
_CONFIG_TTL = 300.0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([HaAgentSttEntity(entry)])


class HaAgentSttEntity(stt.SpeechToTextEntity):
    """Speech-to-Text entity backed by ha-agent (Gemini STT)."""

    _attr_has_entity_name = True
    _attr_name = "집 비서 STT"

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_stt"
        self._ep_config: EndpointConfig | None = None
        self._ep_config_at = 0.0
        self._ep_refresh: asyncio.Task | None = None

    async def _fetch_endpoint_config(self) -> None:
        url = self._entry.data[CONF_URL].rstrip("/")
        session = async_get_clientsession(self.hass)
        try:
            async with session.get(
                f"{url}/api/assist/voice-config",
                headers={"Authorization": f"Bearer {self._entry.data[CONF_TOKEN]}"},
                timeout=aiohttp.ClientTimeout(total=2),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    self._ep_config = EndpointConfig.from_dict(data.get("endpoint"))
                    self._ep_config_at = time.monotonic()
        except Exception as err:  # 서버가 옛 버전이거나 잠깐 안 될 때는 기본값으로 계속
            _LOGGER.debug("ha-agent voice-config 실패: %s", err)
        finally:
            if self._ep_config is None:
                self._ep_config = EndpointConfig()
                self._ep_config_at = time.monotonic()

    async def _endpoint_config(self) -> EndpointConfig:
        """처음에는 받아 올 때까지(최대 2초, 그동안 오디오는 쌓임) 기다리고, 이후에는 캐시를 쓰며 뒤에서 갱신한다."""
        if self._ep_config is None:
            await self._fetch_endpoint_config()
        elif time.monotonic() - self._ep_config_at > _CONFIG_TTL and (self._ep_refresh is None or self._ep_refresh.done()):
            self._ep_refresh = self.hass.async_create_task(self._fetch_endpoint_config())
        return self._ep_config or EndpointConfig()

    async def async_will_remove_from_hass(self) -> None:
        if self._ep_refresh is not None and not self._ep_refresh.done():
            self._ep_refresh.cancel()
            self._ep_refresh = None

    @property
    def supported_languages(self) -> list[str]:
        return ["ko", "ko-KR", "en", "en-US"]

    @property
    def supported_formats(self) -> list[stt.AudioFormats]:
        return [stt.AudioFormats.WAV, stt.AudioFormats.OGG]

    @property
    def supported_codecs(self) -> list[stt.AudioCodecs]:
        return [stt.AudioCodecs.PCM, stt.AudioCodecs.OPUS]

    @property
    def supported_bit_rates(self) -> list[stt.AudioBitRates]:
        return [stt.AudioBitRates.BITRATE_16]

    @property
    def supported_sample_rates(self) -> list[stt.AudioSampleRates]:
        return [
            stt.AudioSampleRates.SAMPLERATE_8000,
            stt.AudioSampleRates.SAMPLERATE_16000,
            stt.AudioSampleRates.SAMPLERATE_44100,
            stt.AudioSampleRates.SAMPLERATE_48000,
        ]

    @property
    def supported_channels(self) -> list[stt.AudioChannels]:
        return [stt.AudioChannels.CHANNEL_MONO]

    async def async_process_audio_stream(
        self, metadata: stt.SpeechMetadata, stream: AsyncIterable[bytes]
    ) -> stt.SpeechResult:
        channels = int(getattr(metadata.channel, "value", metadata.channel) or 1)
        bits = int(getattr(metadata.bit_rate, "value", metadata.bit_rate) or 16)
        rate = int(getattr(metadata.sample_rate, "value", metadata.sample_rate) or 16000)
        is_pcm = metadata.format != stt.AudioFormats.OGG
        ep_cfg = await self._endpoint_config()
        endpointer = Endpointer(sample_rate=rate, config=ep_cfg) if is_pcm and ep_cfg.enabled and bits == 16 and channels == 1 else None

        audio_data = bytearray()
        first = True
        async for chunk in stream:
            if first and is_pcm:
                first = False
                off = wav_data_offset(chunk[:4096])
                if off is not None:  # 머리가 붙어 온 WAV면 PCM만 남긴다(뒤에서 다시 감쌈)
                    chunk = chunk[off:]
            audio_data.extend(chunk)
            if endpointer is not None and endpointer.feed(chunk) is not None:
                break  # 말 끝: HA VAD를 기다리지 않고 바로 전사

        if not audio_data:
            return stt.SpeechResult(None, stt.SpeechResultState.ERROR)

        params = {"language": metadata.language or "ko"}
        if metadata.format == stt.AudioFormats.OGG:
            content_type = "audio/ogg"
            payload = bytes(audio_data)
        else:
            content_type = "audio/wav"
            raw = bytes(audio_data)
            if endpointer is not None:
                res = endpointer.close()
                keep = 0 if res.reason == "stream_end" else endpointer.keep_from_byte()
                params.update({
                    "ep_reason": res.reason,
                    "ep_cut_ms": str(res.cut_ms),
                    "ep_start_ms": str(res.start_ms),
                    "ep_keep_ms": str(int(keep / 2 / rate * 1000)),
                    "ep_noise_db": str(res.noise_db),
                    "ep_bg_db": "" if res.background_db is None else str(res.background_db),
                    "ep_speech_db": "" if res.speech_db is None else str(res.speech_db),
                })
                if keep > 0:
                    raw = raw[keep:]
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(channels)
                wf.setsampwidth(max(1, bits // 8))
                wf.setframerate(rate)
                wf.writeframes(raw)
            payload = buf.getvalue()

        url = self._entry.data[CONF_URL].rstrip("/")
        token = self._entry.data[CONF_TOKEN]
        session = async_get_clientsession(self.hass)

        try:
            async with session.post(
                f"{url}/api/assist/stt",
                params=params,
                data=payload,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": content_type,
                },
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status != 200:
                    err_text = await resp.text()
                    _LOGGER.warning("ha-agent STT HTTP %s: %s", resp.status, err_text[:200])
                    return stt.SpeechResult(None, stt.SpeechResultState.ERROR)
                data = await resp.json()
                text = (data.get("text") or "").strip()
                if not text:
                    return stt.SpeechResult(None, stt.SpeechResultState.ERROR)
                return stt.SpeechResult(text, stt.SpeechResultState.SUCCESS)
        except Exception as err:
            _LOGGER.warning("ha-agent STT error: %s", err)
            return stt.SpeechResult(None, stt.SpeechResultState.ERROR)
