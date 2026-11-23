"""말 끝 감지(endpoint.py) 합성 신호 시험. node test/endpoint.test.mjs가 python3로 돌린다.

말소리: 120~400Hz 배음 + 음절 포락선(200ms 음절, 80ms 틈, 단어 사이 300ms)
배경: 백색 소음(에어컨·공기청정기), 말처럼 오르내리는 작은 소리(옆방 TV·대화)
"""
import importlib.util
import math
import os
import random
import struct
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    "endpoint", os.path.join(HERE, "..", "ha", "custom_components", "ha_agent_assist", "endpoint.py")
)
endpoint = importlib.util.module_from_spec(SPEC)
sys.modules["endpoint"] = endpoint
SPEC.loader.exec_module(endpoint)

RATE = 16000


def db_to_amp(db):
    return 10 ** (db / 20)


def silence(sec):
    return [0.0] * int(sec * RATE)


def white(sec, db, seed=1):
    rnd = random.Random(seed)
    a = db_to_amp(db)
    return [rnd.gauss(0, a) for _ in range(int(sec * RATE))]


def speech(words=3, db=-20, f0=180, pause_ms=None):
    """음절 3개짜리 단어 words개. pause_ms가 있으면 두 번째 단어 앞에 그만큼 쉰다."""
    out = []
    a = db_to_amp(db) * math.sqrt(2) / 1.6
    for w in range(words):
        if w:
            out += [0.0] * int((pause_ms if (pause_ms and w == 1) else 300) * RATE / 1000)
        for s in range(3):
            n = int(0.2 * RATE)
            for i in range(n):
                t = i / RATE
                env = math.sin(math.pi * i / n) ** 0.5
                f = f0 * (1 + 0.1 * math.sin(2 * math.pi * 3 * t + s))
                v = math.sin(2 * math.pi * f * t) + 0.5 * math.sin(4 * math.pi * f * t) + 0.3 * math.sin(6 * math.pi * f * t)
                out.append(a * env * v)
            out += [0.0] * int(0.08 * RATE)
    return out


def babble(sec, db, seed=2):
    """옆방 TV처럼 크기가 오르내리는 말 비슷한 소리."""
    rnd = random.Random(seed)
    out = []
    while len(out) < sec * RATE:
        out += speech(words=rnd.randint(1, 3), db=db + rnd.uniform(-3, 3), f0=rnd.uniform(110, 260))
        out += [0.0] * int(rnd.uniform(0.05, 0.25) * RATE)
    return out[: int(sec * RATE)]


def mix(*tracks):
    n = max(len(t) for t in tracks)
    return [sum(t[i] if i < len(t) else 0.0 for t in tracks) for i in range(n)]


def place(total_sec, at_sec, sig):
    out = [0.0] * int(total_sec * RATE)
    start = int(at_sec * RATE)
    for i, v in enumerate(sig):
        if start + i < len(out):
            out[start + i] = v
    return out


def pcm(samples):
    return b"".join(struct.pack("<h", max(-32768, min(32767, int(v * 32767)))) for v in samples)


def run(samples, chunk_ms=60, **cfg):
    ep = endpoint.Endpointer(sample_rate=RATE, config=endpoint.EndpointConfig.from_dict(cfg))
    data = pcm(samples)
    step = int(RATE * chunk_ms / 1000) * 2
    for i in range(0, len(data), step):
        res = ep.feed(data[i:i + step])
        if res:
            return res
    return ep.close()


SPEECH_SEC = len(speech()) / RATE  # 약 1.6초


class EndpointTest(unittest.TestCase):
    def assertCutNear(self, res, expected, tol=0.35):
        self.assertEqual(res.reason, "silence", res)
        self.assertAlmostEqual(res.cut_ms / 1000, expected, delta=tol, msg=res)

    def test_quiet_room(self):
        sig = mix(white(15, -62), place(15, 0.6, speech()))
        self.assertCutNear(run(sig), 0.6 + SPEECH_SEC + 0.7)

    def test_steady_fan_noise(self):
        sig = mix(white(15, -38), place(15, 0.6, speech(db=-18)))
        self.assertCutNear(run(sig), 0.6 + SPEECH_SEC + 0.7)

    def test_background_tv_babble(self):
        # HA VAD가 15초까지 끌던 상황: 말 비슷한 배경이 -42dB 근처로 계속 깔림
        sig = mix(white(15, -60), babble(15, -42), place(15, 0.6, speech(db=-20)))
        self.assertCutNear(run(sig), 0.6 + SPEECH_SEC + 0.7, tol=0.5)

    def test_louder_babble(self):
        sig = mix(white(15, -56), babble(15, -34, seed=5), place(15, 0.8, speech(db=-16)))
        res = run(sig)
        self.assertEqual(res.reason, "silence", res)
        self.assertLess(res.cut_ms / 1000, 0.8 + SPEECH_SEC + 1.5, res)

    def test_tv_then_user_speaks_late(self):
        # 옆방 TV가 계속 나오는 중에 2초 뒤에 말함: TV만으로 먼저 끊으면 안 된다
        sig = mix(white(15, -58), babble(15, -40, seed=3), place(15, 2.0, speech(db=-20)))
        res = run(sig)
        self.assertGreater(res.cut_ms / 1000, 2.0 + SPEECH_SEC, res)
        self.assertCutNear(res, 2.0 + SPEECH_SEC + 0.7, tol=0.5)
        self.assertAlmostEqual(res.start_ms / 1000, 2.0, delta=0.15, msg=res)

    def test_loud_fan_next_to_phone(self):
        # 가까운 선풍기·공기청정기(-30dB, 첫 0.7초 기준선보다 큼)를 말로 착각해 일찍 끊으면 안 된다
        sig = mix(white(15, -30), place(15, 1.0, speech(db=-14)))
        res = run(sig)
        self.assertGreater(res.cut_ms / 1000, 1.0 + SPEECH_SEC, res)
        self.assertCutNear(res, 1.0 + SPEECH_SEC + 0.7, tol=0.5)

    def test_soft_far_speech_in_quiet_room(self):
        sig = mix(white(15, -62), place(15, 1.0, speech(db=-36)))
        self.assertCutNear(run(sig), 1.0 + SPEECH_SEC + 0.7)

    def test_speaks_immediately(self):
        sig = mix(white(15, -55), place(15, 0.0, speech()))
        res = run(sig)
        self.assertEqual(res.reason, "silence", res)
        self.assertLess(res.cut_ms / 1000, SPEECH_SEC + 1.6, res)

    def test_mid_sentence_pause_is_not_cut(self):
        sig = mix(white(15, -60), place(15, 0.5, speech(words=3, pause_ms=450)))
        res = run(sig)
        self.assertEqual(res.reason, "silence")
        self.assertGreater(res.cut_ms / 1000, 0.5 + SPEECH_SEC + 0.1, "450ms 쉼에서 끊으면 안 됨")

    def test_no_speech(self):
        res = run(white(15, -50))
        self.assertEqual(res.reason, "no_speech", res)
        self.assertAlmostEqual(res.cut_ms / 1000, 6.0, delta=0.05)

    def test_cough_then_speech(self):
        cough = white(0.08, -15, seed=9)
        sig = mix(white(15, -60), place(15, 0.5, cough), place(15, 2.0, speech()))
        res = run(sig)
        self.assertCutNear(res, 2.0 + SPEECH_SEC + 0.7)
        self.assertAlmostEqual(res.start_ms / 1000, 2.0, delta=0.15, msg=res)

    def test_keep_from_byte(self):
        ep = endpoint.Endpointer(sample_rate=RATE)
        data = pcm(mix(white(15, -60), place(15, 2.0, speech())))
        step = int(RATE * 0.06) * 2
        for i in range(0, len(data), step):
            if ep.feed(data[i:i + step]):
                break
        keep = ep.keep_from_byte()
        self.assertEqual(keep % 2, 0)
        self.assertAlmostEqual(keep / 2 / RATE, 1.5, delta=0.15)
        early = endpoint.Endpointer(sample_rate=RATE)
        early.feed(pcm(mix(white(3, -60), place(3, 0.0, speech()))))
        self.assertEqual(early.keep_from_byte(), 0)

    def test_unseparable_noise_hits_max(self):
        sig = mix(babble(15, -18, seed=7), place(15, 0.6, speech(db=-18)))
        res = run(sig, max_seconds=8)
        # 말과 같은 크기의 배경은 소리 크기로 못 가른다: 6초(말 시작 못 잡음)나 8초 상한에서 끊고 그대로 전사한다
        self.assertIn(res.reason, ("max", "silence", "no_speech"))
        self.assertLessEqual(res.cut_ms / 1000, 8.0)

    def test_stream_end_and_wav_header(self):
        ep = endpoint.Endpointer(sample_rate=RATE)
        ep.feed(pcm(white(1, -60)))
        self.assertEqual(ep.close().reason, "stream_end")
        head = b"RIFF" + (36).to_bytes(4, "little") + b"WAVE" + b"fmt " + (16).to_bytes(4, "little") + bytes(16) + b"data" + bytes(4)
        self.assertEqual(endpoint.wav_data_offset(head), 44)
        self.assertIsNone(endpoint.wav_data_offset(b"\x00" * 50))

    def test_config_from_dict(self):
        c = endpoint.EndpointConfig.from_dict({"silence_ms": "500", "max_seconds": 7, "unknown": 1, "enabled": False})
        self.assertEqual((c.silence_ms, c.max_seconds, c.enabled), (500, 7.0, False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
