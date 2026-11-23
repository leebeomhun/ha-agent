// Gemini Interactions API 음성(STT/TTS) 모듈 및 AssistServer 음성 엔드포인트 단위·통합 테스트
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'haagent-voice-'))
process.env.HAAGENT_DATA_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

const { mergeConfig, saveControl } = await import('../src/config.mjs')
const { P, writeJson } = await import('../src/util.mjs')
const {
	pcmToWav, parsePcmParams, isWavBuffer, ensureWav,
	cleanSpeechForTts, normalizeTtsLanguage, sttThinkingLevel, wavStats,
	transcribeGemini, synthesizeGemini,
} = await import('../src/voice/gemini-voice.mjs')
const { Agent } = await import('../src/agent.mjs')

const T0 = Date.parse('2026-11-20T15:00:00+09:00')
const st = (entity_id, state, attrs = {}) => ({
	entity_id, state, attributes: { friendly_name: entity_id, ...attrs },
	last_changed: new Date(T0).toISOString(), last_updated: new Date(T0).toISOString(),
})

test('WAV/PCM 유틸, TTS 텍스트 정리, 언어·생각 수준 정규화', () => {
	const pcm = Buffer.alloc(320, 1)
	const wav = pcmToWav(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 })
	assert.equal(wav.length, 44 + 320)
	assert.equal(isWavBuffer(wav), true)
	assert.equal(isWavBuffer(pcm), false)
	assert.equal(wav.readUInt32LE(24), 16000)
	assert.equal(wav.readUInt16LE(22), 1)
	assert.equal(wav.readUInt32LE(40), 320)

	// 이미 WAV면 중복 헤더를 붙이지 않는다
	assert.equal(ensureWav(wav, 'audio/wav'), wav)
	const wrapped = ensureWav(pcm, 'audio/L16;codec=pcm;rate=24000;channels=1')
	assert.equal(isWavBuffer(wrapped), true)
	assert.equal(wrapped.readUInt32LE(24), 24000)
	assert.deepEqual(parsePcmParams('audio/l16; rate=16000; channels=2'), { sampleRate: 16000, channels: 2, bitsPerSample: 16 })

	const dirty = '## 거실 상태\n- **공기청정기**: `on` 상태예요.\n[자세히](https://example.com)\n```json\n{"a":1}\n```'
	assert.equal(cleanSpeechForTts(dirty), '거실 상태 공기청정기: on 상태예요. 자세히')

	assert.equal(normalizeTtsLanguage('ko'), 'ko-KR')
	assert.equal(normalizeTtsLanguage('en'), 'en-US')
	assert.equal(normalizeTtsLanguage('ko_kr'), 'ko-KR')

	assert.equal(sttThinkingLevel('gemini-3.5-transcribe'), null)
	assert.equal(sttThinkingLevel('gemini-3.5-flash-lite'), 'minimal')
	assert.equal(sttThinkingLevel('gemini-3.8-flash'), 'low')

	// wavStats: 길이·최대/평균 dBFS·말소리 추정 구간(20ms 프레임 중 -40dBFS 이상)
	const sr = 16000, tone = Buffer.alloc(sr * 2 * 2) // 2초: 앞 1초 무음, 뒤 1초 0.5 진폭 사각파
	for (let i = sr; i < sr * 2; i++) tone.writeInt16LE(i % 2 ? 16384 : -16384, i * 2)
	const s1 = wavStats(pcmToWav(tone, { sampleRate: sr }))
	assert.equal(s1.durationMs, 2000)
	assert.equal(s1.peakDbfs, -6)
	assert.equal(s1.rmsDbfs, -9)
	assert.equal(s1.activeMs, 1000)
	const silent = wavStats(pcmToWav(Buffer.alloc(sr), { sampleRate: sr }))
	assert.equal(silent.durationMs, 500)
	assert.equal(silent.peakDbfs, -Infinity)
	assert.equal(silent.activeMs, 0)
	assert.equal(wavStats(Buffer.from('OggS not a wav file')), null)
	// 스트리밍 WAV(data 크기 0xFFFFFFFF)도 남은 바이트로 길이를 잰다
	const streamed = pcmToWav(tone, { sampleRate: sr })
	streamed.writeUInt32LE(0xFFFFFFFF, 40)
	assert.equal(wavStats(streamed).durationMs, 2000)
})

test('transcribeGemini & synthesizeGemini (Interactions API): 모델별 설정, PCM→WAV 래핑, 재시도', async () => {
	const prev = process.env.TEST_VOICE_GEMINI_KEY
	process.env.TEST_VOICE_GEMINI_KEY = 'gem-voice-test'
	const cfg = mergeConfig({ gemini: { key_env: 'TEST_VOICE_GEMINI_KEY' } })
	try {
		// 100바이트 미만 오디오는 API 호출 없이 빈 텍스트 반환
		let calls = 0
		const empty = await transcribeGemini({ cfg, audioBuffer: Buffer.alloc(20), fetchFn: async () => { calls++; throw new Error('should not call') } })
		assert.equal(empty.text, '')
		assert.equal(calls, 0)

		// 기본 STT 모델(gemini-3.5-transcribe): Interactions API, PCM→WAV 변환, transcription_config, 503 후 1회 재시도
		const sentBodies = [], sentUrls = []
		let sttAttempts = 0
		const sttRes = await transcribeGemini({
			cfg,
			audioBuffer: Buffer.alloc(400, 2),
			mimeType: 'audio/l16;rate=16000;channels=1',
			language: 'ko',
			hints: ['공기청정기', '거실', '공기청정기'],
			fetchFn: async (url, init) => {
				sttAttempts++
				sentUrls.push(url)
				sentBodies.push(JSON.parse(init.body))
				if (sttAttempts === 1) return { ok: false, status: 503, text: async () => '{"error":{"message":"busy"}}' }
				return {
					ok: true, status: 200,
					text: async () => JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'text', text: '"거실 공기청정기 켜줘"' }] }] }),
				}
			},
		})
		assert.equal(sttAttempts, 2)
		assert.ok(sentUrls[0].endsWith('/v1beta/interactions'))
		assert.equal(sttRes.text, '거실 공기청정기 켜줘')
		assert.equal(sttRes.model, 'gemini-3.5-transcribe')
		const sttBody = sentBodies[0]
		assert.equal(sttBody.model, 'gemini-3.5-transcribe')
		assert.equal(sttBody.store, false)
		// 전사 전용 모델: 텍스트 지시문 없이 오디오만 보내고, 언어·어휘는 transcription_config로 고정
		assert.equal(sttBody.input.length, 1)
		assert.deepEqual(sttBody.generation_config, {
			transcription_config: { language_codes: ['ko-KR'], mode: 'verbatim', custom_vocabulary: ['공기청정기', '거실'] },
		})
		const sentAudio = Buffer.from(sttBody.input[0].data, 'base64')
		assert.equal(sttBody.input[0].type, 'audio')
		assert.equal(sttBody.input[0].mime_type, 'audio/wav')
		assert.equal(isWavBuffer(sentAudio), true)
		assert.equal(sentAudio.readUInt32LE(24), 16000)

		// stt_mode=smart, 힌트 없음이면 custom_vocabulary를 생략
		const smartBodies = []
		await transcribeGemini({
			cfg: mergeConfig({ gemini: { key_env: 'TEST_VOICE_GEMINI_KEY' }, assist: { voice: { stt_mode: 'smart' } } }),
			audioBuffer: pcmToWav(Buffer.alloc(200)), language: 'ko-KR',
			fetchFn: async (_u, i) => { smartBodies.push(JSON.parse(i.body)); return { ok: true, status: 200, text: async () => '{"steps":[]}' } },
		})
		assert.deepEqual(smartBodies[0].generation_config, { transcription_config: { language_codes: ['ko-KR'], mode: 'smart' } })

		// 일반 모델: flash-lite는 minimal, gemini-3.8-flash는 low thinking_level + 텍스트 지시문(힌트 포함)
		const flashBodies = []
		await transcribeGemini({
			cfg, audioBuffer: pcmToWav(Buffer.alloc(200)), model: 'gemini-3.5-flash-lite', hints: ['공기청정기', '거실'],
			fetchFn: async (_u, i) => { flashBodies.push(JSON.parse(i.body)); return { ok: true, status: 200, text: async () => '{"steps":[{"type":"model_output","content":[{"type":"text","text":"테스트"}]}]}' } },
		})
		assert.equal(flashBodies[0].generation_config.thinking_level, 'minimal')
		assert.equal(flashBodies[0].generation_config.temperature, 0)
		assert.equal(flashBodies[0].generation_config.transcription_config, undefined)
		assert.match(flashBodies[0].input[0].text, /공기청정기, 거실/)
		assert.equal(flashBodies[0].input[1].type, 'audio')

		await transcribeGemini({
			cfg, audioBuffer: pcmToWav(Buffer.alloc(200)), model: 'gemini-3.8-flash',
			fetchFn: async (_u, i) => { flashBodies.push(JSON.parse(i.body)); return { ok: true, status: 200, text: async () => '{"steps":[{"type":"model_output","content":[{"type":"text","text":"전사"}]}]}' } },
		})
		assert.equal(flashBodies[1].generation_config.thinking_level, 'low')

		// TTS (Interactions API): raw PCM 응답이면 WAV로 래핑, 이미 WAV면 그대로 유지
		const rawPcm = Buffer.alloc(160, 7)
		let ttsBody = null, ttsUrl = null
		const tts1 = await synthesizeGemini({
			cfg,
			text: '**거실** 온도는 23도예요.',
			language: 'ko',
			fetchFn: async (u, i) => {
				ttsUrl = u
				ttsBody = JSON.parse(i.body)
				return {
					ok: true, status: 200,
					text: async () => JSON.stringify({
						steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/L16;codec=pcm;rate=24000', data: rawPcm.toString('base64') }] }],
					}),
				}
			},
		})
		assert.ok(ttsUrl.endsWith('/v1beta/interactions'))
		assert.equal(ttsBody.model, 'gemini-3.8-flash-lite-tts')
		assert.equal(ttsBody.store, false)
		assert.deepEqual(ttsBody.response_modalities, ['audio'])
		assert.deepEqual(ttsBody.generation_config.speech_config, [{ voice: 'Kore', language: 'ko-KR' }])
		assert.equal(ttsBody.input, '거실 온도는 23도예요.')
		assert.equal(isWavBuffer(tts1.audio), true)
		assert.equal(tts1.audio.length, 44 + 160)

		const alreadyWav = pcmToWav(rawPcm, { sampleRate: 24000 })
		const tts2 = await synthesizeGemini({
			cfg,
			text: '확인했어요.',
			fetchFn: async () => ({
				ok: true, status: 200,
				text: async () => JSON.stringify({
					steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: alreadyWav.toString('base64') }] }],
				}),
			}),
		})
		assert.equal(tts2.audio.length, alreadyWav.length)
	} finally {
		if (prev === undefined) delete process.env.TEST_VOICE_GEMINI_KEY; else process.env.TEST_VOICE_GEMINI_KEY = prev
	}
})

test('AssistServer 음성 엔드포인트: STT(바이너리/JSON), TTS(WAV·LRU 캐시), 인증·ms 계측', async () => {
	rmSync(TMP, { recursive: true, force: true })
	mkdirSync(P.state, { recursive: true })
	saveControl({ paused: false, send: false })
	writeJson(P.rules, { updated: new Date(T0).toISOString(), rules: [] })

	class MockHA extends EventEmitter {
		constructor() { super(); this.connected = true; this.guard = { allowConfigWrite: false } }
		start() {}
		stop() {}
		async call(m) {
			if (m.type === 'get_states') return [st('switch.geosil_gonggiceongjeonggi_power', 'off', { friendly_name: '공기청정기 파워' })]
			return []
		}
		async heartbeat() {}
	}

	const ha = new MockHA()
	const cfg = mergeConfig({
		heartbeat: { enabled: false },
		actions: { enabled: true, auto: ['switch.geosil_gonggiceongjeonggi_power'], confirm: [] },
		assist: {
			enabled: true, host: '127.0.0.1', port: 0, token_file: join(TMP, 'assist-token'),
			voice: { stt_hints: ['거실', '공기청정기'], tts_cache_max: 2, stt_debug_keep: 2 },
		},
	})

	const sttCalls = [], ttsCalls = []
	const fakeWav = pcmToWav(Buffer.alloc(240, 3), { sampleRate: 24000 })
	const agent = new Agent({
		cfg, ha,
		brain: async () => ({ result: { speech: '거실 공기청정기는 꺼져 있어요.', continue_conversation: false }, ms: 12, tokens: 10 }),
		sttFn: async args => { sttCalls.push(args); return { text: '거실 공기청정기 상태 알려줘', ms: 18, model: 'gemini-3.5-transcribe' } },
		ttsFn: async args => { ttsCalls.push(args); return { audio: fakeWav, mimeType: 'audio/wav', format: 'wav', ms: 25, model: 'gemini-3.8-flash-lite-tts', voice: args.voice } },
	})
	agent.attach()
	ha.emit('ready', [st('switch.geosil_gonggiceongjeonggi_power', 'off', { friendly_name: '공기청정기 파워' })])
	const port = await agent.assistServer.start()
	const token = agent.assistServer.token
	try {
		// 1) 인증 거부
		const unauthStt = await fetch(`http://127.0.0.1:${port}/api/assist/stt`, { method: 'POST', body: fakeWav })
		assert.equal(unauthStt.status, 401)
		const unauthTts = await fetch(`http://127.0.0.1:${port}/api/assist/tts`, { method: 'POST', body: '{}' })
		assert.equal(unauthTts.status, 401)

		// 2) 바이너리 WAV STT + 힌트 전달 확인
		const sttRes = await fetch(`http://127.0.0.1:${port}/api/assist/stt?language=ko&sample_rate=16000`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav' },
			body: fakeWav,
		})
		const sttJson = await sttRes.json()
		assert.equal(sttRes.status, 200)
		assert.equal(sttJson.text, '거실 공기청정기 상태 알려줘')
		assert.equal(sttJson.ms, 18)
		assert.ok(sttCalls[0].hints.includes('공기청정기 파워'))

		// 3) JSON base64 STT
		const sttJsonRes = await fetch(`http://127.0.0.1:${port}/api/assist/stt`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ audio_base64: fakeWav.toString('base64'), mime_type: 'audio/wav', language: 'ko' }),
		})
		assert.equal(sttJsonRes.status, 200)
		assert.equal(sttCalls.length, 2)

		// 4) converse ms 반환 확인
		const convRes = await fetch(`http://127.0.0.1:${port}/api/assist/converse`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ text: sttJson.text }),
		})
		const convJson = await convRes.json()
		assert.equal(convRes.status, 200)
		assert.equal(typeof convJson.ms, 'number')

		// 5) TTS + 캐시 적중 확인 (마크다운 제거 후 동일 문장이면 캐시 히트)
		const ttsRes1 = await fetch(`http://127.0.0.1:${port}/api/assist/tts`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ text: convJson.response.speech, language: 'ko' }),
		})
		assert.equal(ttsRes1.status, 200)
		assert.equal(ttsRes1.headers.get('content-type'), 'audio/wav')
		assert.equal(ttsRes1.headers.get('x-ha-agent-cached'), '0')
		const buf1 = Buffer.from(await ttsRes1.arrayBuffer())
		assert.equal(isWavBuffer(buf1), true)
		assert.equal(ttsCalls.length, 1)

		const ttsRes2 = await fetch(`http://127.0.0.1:${port}/api/assist/tts`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ text: '**거실** 공기청정기는 꺼져 있어요.', language: 'ko' }),
		})
		assert.equal(ttsRes2.status, 200)
		assert.equal(ttsRes2.headers.get('x-ha-agent-cached'), '1')
		assert.equal(ttsCalls.length, 1)

		// 6) 성공한 STT는 실패 오디오를 남기지 않는다
		assert.equal(existsSync(P.sttFailures), false)

		// 7) 빈 결과면 state/stt-failures/에 오디오+메타를 남기고 stt_debug_keep(2)개만 유지
		agent.sttFn = async () => ({ text: '', ms: 9, model: 'gemini-3.5-transcribe', usage: { input_tokens: 5 } })
		const pcm = Buffer.alloc(16000 * 2)
		for (let i = 0; i < 3; i++) {
			const r = await fetch(`http://127.0.0.1:${port}/api/assist/stt?sample_rate=16000&channels=1`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/l16' },
				body: pcm,
			})
			assert.equal(r.status, 200)
			assert.equal((await r.json()).text, '')
		}
		const saved = readdirSync(P.sttFailures).sort()
		assert.equal(saved.length, 4)
		assert.deepEqual(saved.map(f => f.split('.').pop()), ['json', 'wav', 'json', 'wav'])
		const meta = JSON.parse(readFileSync(join(P.sttFailures, saved[0]), 'utf8'))
		assert.equal(meta.mime_type, 'audio/wav')
		assert.equal(meta.stats.durationMs, 1000)
		assert.equal(meta.stats.activeMs, 0)
		assert.equal(meta.model, 'gemini-3.5-transcribe')
		assert.equal(isWavBuffer(readFileSync(join(P.sttFailures, saved[1]))), true)

		// 8) HA STT 컴포넌트용 말 끝 감지 설정 (기본값 병합)
		const vc = await fetch(`http://127.0.0.1:${port}/api/assist/voice-config`, { headers: { authorization: `Bearer ${token}` } })
		assert.equal(vc.status, 200)
		assert.deepEqual((await vc.json()).endpoint, { enabled: true, silence_ms: 700, max_seconds: 10, no_speech_seconds: 6 })
		assert.equal((await fetch(`http://127.0.0.1:${port}/api/assist/voice-config`)).status, 401)

		// 9) 말 끝을 못 잡고 상한(max)에서 끊긴 오디오는 인식돼도 조정용으로 남기고 감지 결과를 같이 적는다
		agent.sttFn = async () => ({ text: '주방 불 켜 줘', ms: 9, model: 'gemini-3.5-transcribe' })
		const epRes = await fetch(`http://127.0.0.1:${port}/api/assist/stt?sample_rate=16000&channels=1&ep_reason=max&ep_cut_ms=10000&ep_start_ms=900&ep_keep_ms=400&ep_noise_db=-60.2&ep_bg_db=&ep_speech_db=-18`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/l16' },
			body: pcm,
		})
		assert.equal((await epRes.json()).text, '주방 불 켜 줘')
		const newest = readdirSync(P.sttFailures).filter(f => f.endsWith('.json')).sort().at(-1)
		const epMeta = JSON.parse(readFileSync(join(P.sttFailures, newest), 'utf8'))
		assert.deepEqual(epMeta.endpoint, { reason: 'max', cut_ms: 10000, start_ms: 900, keep_ms: 400, noise_db: -60.2, speech_db: -18 })
		assert.equal(epMeta.text, '주방 불 켜 줘')
	} finally {
		agent.stop()
	}
})
