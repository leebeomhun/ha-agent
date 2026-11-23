// Google Gemini Interactions API 음성(STT/TTS) 어댑터: /v1beta/interactions + RIFF/WAV 자동 판별·래핑 지원
import { geminiKey } from '../llm/providers/gemini.mjs'

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])
const MAX_TTS_CHARS = 1000
// custom_vocabulary는 최대 1000개지만 문서상 100개 이하일 때 가장 정확하다.
export const MAX_STT_VOCAB = 100
const MAX_STT_PROMPT_HINTS = 40
const ACTIVE_FRAME_MS = 20
const ACTIVE_DBFS = -40

export const isTranscribeModel = model => /transcribe/i.test(String(model ?? ''))

const toDbfs = v => (v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -Infinity)

// 16비트 PCM WAV의 길이·음량·말소리 추정 구간을 잰다. STT 빈 결과가 무음 때문인지 가리는 진단용.
export function wavStats(buf) {
	if (!isWavBuffer(buf)) return null
	let fmt = null, dataOff = -1, dataLen = 0
	for (let off = 12; off + 8 <= buf.length;) {
		const id = buf.toString('ascii', off, off + 4)
		const size = buf.readUInt32LE(off + 4)
		const body = off + 8
		if (id === 'fmt ' && body + 16 <= buf.length) {
			fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
		} else if (id === 'data') {
			dataOff = body
			// 스트리밍으로 만든 WAV는 data 크기가 0이나 0xFFFFFFFF일 수 있다.
			dataLen = size > 0 && body + size <= buf.length ? size : buf.length - body
			break
		}
		off = body + size + (size % 2)
	}
	if (!fmt || dataOff < 0 || !fmt.sampleRate || !fmt.channels) return null
	const bytesPerFrame = fmt.channels * (fmt.bits / 8)
	const durationMs = bytesPerFrame ? Math.round(dataLen / bytesPerFrame / fmt.sampleRate * 1000) : 0
	const out = { durationMs, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, peakDbfs: null, rmsDbfs: null, activeMs: null }
	if (fmt.format !== 1 || fmt.bits !== 16) return out

	const samples = Math.floor(dataLen / 2)
	const frameSamples = Math.max(1, Math.round(fmt.sampleRate * fmt.channels * ACTIVE_FRAME_MS / 1000))
	const activeSq = (10 ** (ACTIVE_DBFS / 20)) ** 2
	let peak = 0, sumSq = 0, frameSq = 0, frameN = 0, activeFrames = 0
	for (let i = 0; i < samples; i++) {
		const s = buf.readInt16LE(dataOff + i * 2) / 32768
		const a = Math.abs(s)
		if (a > peak) peak = a
		sumSq += s * s
		frameSq += s * s
		if (++frameN === frameSamples) {
			if (frameSq / frameN >= activeSq) activeFrames++
			frameSq = 0
			frameN = 0
		}
	}
	out.peakDbfs = toDbfs(peak)
	out.rmsDbfs = samples ? toDbfs(Math.sqrt(sumSq / samples)) : -Infinity
	out.activeMs = activeFrames * ACTIVE_FRAME_MS
	return out
}

const sleep = (ms, signal) => new Promise((done, fail) => {
	const t = setTimeout(done, ms)
	signal.addEventListener('abort', () => { clearTimeout(t); fail(signal.reason) }, { once: true })
})

export function isWavBuffer(buf) {
	return Buffer.isBuffer(buf)
		&& buf.length >= 12
		&& buf.subarray(0, 4).toString('ascii') === 'RIFF'
		&& buf.subarray(8, 12).toString('ascii') === 'WAVE'
}

export function parsePcmParams(mimeType = '') {
	const s = String(mimeType || '')
	const rateMatch = /(?:rate|sample_rate)\s*=\s*(\d+)/i.exec(s)
	const chanMatch = /channels\s*=\s*(\d+)/i.exec(s)
	const bitsMatch = /bits\s*=\s*(\d+)/i.exec(s)
	const sampleRate = rateMatch ? Math.max(8000, Math.min(96000, Number(rateMatch[1]))) : 24000
	const channels = chanMatch ? Math.max(1, Math.min(2, Number(chanMatch[1]))) : 1
	const bitsPerSample = bitsMatch ? Number(bitsMatch[1]) : (/\bl8\b/i.test(s) ? 8 : 16)
	return { sampleRate, channels, bitsPerSample }
}

export function pcmToWav(pcmBuffer, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
	const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer ?? [])
	const header = Buffer.alloc(44)
	const byteRate = sampleRate * channels * (bitsPerSample / 8)
	const blockAlign = channels * (bitsPerSample / 8)
	header.write('RIFF', 0)
	header.writeUInt32LE(36 + pcm.length, 4)
	header.write('WAVE', 8)
	header.write('fmt ', 12)
	header.writeUInt32LE(16, 16)
	header.writeUInt16LE(1, 20)
	header.writeUInt16LE(channels, 22)
	header.writeUInt32LE(sampleRate, 24)
	header.writeUInt32LE(byteRate, 28)
	header.writeUInt16LE(blockAlign, 32)
	header.writeUInt16LE(bitsPerSample, 34)
	header.write('data', 36)
	header.writeUInt32LE(pcm.length, 40)
	return Buffer.concat([header, pcm])
}

export function ensureWav(buffer, mimeType = '') {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
	if (isWavBuffer(buf)) return buf
	return pcmToWav(buf, parsePcmParams(mimeType))
}

export function cleanSpeechForTts(text) {
	return String(text ?? '')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/^\s*[-*•]\s+/gm, '')
		.replace(/(\*\*|__|~~|\*)/g, '')
		.replace(/\r?\n+/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim()
		.slice(0, MAX_TTS_CHARS)
		.trim()
}

export function normalizeTtsLanguage(lang) {
	const raw = String(lang ?? '').trim()
	if (!raw) return 'ko-KR'
	const low = raw.toLowerCase()
	if (low === 'ko') return 'ko-KR'
	if (low === 'en') return 'en-US'
	if (low === 'ja') return 'ja-JP'
	if (low === 'zh') return 'zh-CN'
	const m = /^([a-z]{2})[-_]([a-z]{2})$/i.exec(raw)
	if (m) return `${m[1].toLowerCase()}-${m[2].toUpperCase()}`
	return raw
}

export function sttThinkingLevel(apiModel) {
	const m = String(apiModel ?? '')
	if (/transcribe/i.test(m)) return null
	if (/flash-lite/i.test(m)) return 'minimal'
	if (/^gemini-(?:[3-9]|\d{2,}).*flash/i.test(m)) return 'low'
	return null
}

function geminiBaseUrl(cfg) {
	return String(cfg?.gemini?.base_url || cfg?.llm?.gemini?.base_url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
}

async function postGeminiVoice({ url, key, body, signal, fetchFn }) {
	for (let attempt = 0; ; attempt++) {
		let res, err
		try {
			res = await fetchFn(url, {
				method: 'POST',
				signal,
				headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
				body: JSON.stringify(body),
			})
		} catch (e) {
			if (signal.aborted) throw e
			err = new Error(`Gemini 음성 연결 실패: ${e.cause?.code ?? e.cause?.message ?? e.message}`)
		}
		if (res?.ok) {
			const text = await res.text()
			try { return JSON.parse(text) } catch (e) { throw new Error(`Gemini 음성 응답 JSON 파싱 실패: ${e.message}`) }
		}
		if (res) {
			const text = await res.text().catch(() => '')
			let msg = text.slice(0, 250)
			try { msg = JSON.parse(text).error?.message ?? msg } catch {}
			err = new Error(`Gemini 음성 오류 ${res.status}: ${String(msg).replace(/\s+/g, ' ').slice(0, 250)}`)
			if (!RETRY_STATUS.has(res.status)) throw err
		}
		if (attempt >= 1) throw err
		await sleep(500, signal)
	}
}

function createLinkedController(timeoutSec, signal, label) {
	const ctl = new AbortController()
	const timer = setTimeout(() => ctl.abort(new Error(`${label} 시간 초과 (${timeoutSec}초)`)), timeoutSec * 1000)
	const onAbort = () => ctl.abort(signal.reason instanceof Error ? signal.reason : new Error(`${label} 중단됨`))
	if (signal) {
		if (signal.aborted) onAbort()
		else signal.addEventListener('abort', onAbort, { once: true })
	}
	return {
		ctl,
		cleanup() {
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
		},
	}
}

export async function transcribeGemini({
	cfg, audioBuffer, mimeType = 'audio/wav', language = 'ko', hints = [],
	model = null, timeoutSec = null, fetchFn = fetch, signal,
} = {}) {
	const v = cfg?.assist?.voice ?? {}
	const apiModel = String(model ?? v.stt_model ?? 'gemini-3.5-transcribe').trim()
	const rawBuf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer ?? [])
	if (rawBuf.length < 100) return { text: '', ms: 0, model: apiModel, usage: null }

	const key = geminiKey(cfg)
	const rawMime = String(mimeType || 'audio/wav').trim()
	const needsWavWrap = /pcm|l16/i.test(rawMime) && !isWavBuffer(rawBuf)
	const sendBuf = needsWavWrap ? pcmToWav(rawBuf, parsePcmParams(rawMime)) : rawBuf
	const sendMime = needsWavWrap ? 'audio/wav' : (rawMime.split(';')[0].trim() || 'audio/wav')

	const allHints = [...new Set((Array.isArray(hints) ? hints : []).map(h => String(h ?? '').trim()).filter(Boolean))]
	const audioPart = { type: 'audio', data: sendBuf.toString('base64'), mime_type: sendMime }
	let input, generationConfig

	if (isTranscribeModel(apiModel)) {
		// 전사 전용 모델은 텍스트 지시문 대신 transcription_config로 언어·어휘를 받는다.
		// 언어를 비우면 자동 감지가 되어 짧은 한국어("응", "꺼")가 "うん。", "go"처럼 다른 언어로 나온다.
		const vocab = allHints.slice(0, MAX_STT_VOCAB)
		input = [audioPart]
		generationConfig = {
			transcription_config: {
				language_codes: [normalizeTtsLanguage(language || 'ko')],
				mode: v.stt_mode === 'smart' ? 'smart' : 'verbatim',
				...(vocab.length ? { custom_vocabulary: vocab } : {}),
			},
		}
	} else {
		const promptHints = allHints.slice(0, MAX_STT_PROMPT_HINTS)
		const isKo = !language || /^ko/i.test(String(language))
		let promptText = isKo
			? '이 한국어 음성을 그대로 받아적으세요. 설명, 따옴표, 부가 문장 없이 말한 내용만 출력하세요. 말소리가 없으면 빈 문자열만 출력하세요.'
			: `Transcribe this ${language} speech verbatim. Output only the spoken text without quotes or explanation.`
		if (promptHints.length) {
			promptText += `\n참고용 집 안 방/기기 이름(이 단어가 들리면 정확히 표기): ${promptHints.join(', ')}`
		}
		const tl = sttThinkingLevel(apiModel)
		input = [{ type: 'text', text: promptText }, audioPart]
		generationConfig = { ...(tl ? { thinking_level: tl } : {}), temperature: 0 }
	}
	const resolvedTimeout = Number(timeoutSec ?? v.stt_timeout_seconds ?? 25) || 25
	const url = `${geminiBaseUrl(cfg)}/interactions`
	const started = Date.now()
	const { ctl, cleanup } = createLinkedController(resolvedTimeout, signal, 'Gemini STT')

	try {
		const data = await postGeminiVoice({
			url,
			key,
			signal: ctl.signal,
			fetchFn,
			body: {
				model: apiModel,
				input,
				generation_config: generationConfig,
				store: false,
			},
		})
		const steps = Array.isArray(data.steps) ? data.steps : []
		const rawText = steps
			.filter(s => s.type === 'model_output')
			.flatMap(s => Array.isArray(s.content) ? s.content : [])
			.filter(c => c?.type === 'text' && typeof c.text === 'string')
			.map(c => c.text)
			.join('')
			.trim()
		const text = rawText.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
		return { text, ms: Date.now() - started, model: apiModel, usage: data.usage ?? null }
	} catch (e) {
		if (ctl.signal.aborted) throw ctl.signal.reason
		throw e
	} finally {
		cleanup()
	}
}

export async function synthesizeGemini({
	cfg, text, language = null, voice = null, model = null,
	timeoutSec = null, fetchFn = fetch, signal,
} = {}) {
	const cleaned = cleanSpeechForTts(text)
	if (!cleaned) throw new Error('TTS로 변환할 텍스트가 비어 있음')

	const key = geminiKey(cfg)
	const v = cfg?.assist?.voice ?? {}
	const apiModel = String(model ?? v.tts_model ?? 'gemini-3.8-flash-lite-tts').trim()
	const voiceName = String(voice ?? v.tts_voice ?? 'Kore').trim()
	const languageCode = normalizeTtsLanguage(language ?? v.tts_language ?? 'ko-KR')
	const resolvedTimeout = Number(timeoutSec ?? v.tts_timeout_seconds ?? 30) || 30
	const url = `${geminiBaseUrl(cfg)}/interactions`
	const started = Date.now()
	const { ctl, cleanup } = createLinkedController(resolvedTimeout, signal, 'Gemini TTS')

	try {
		const data = await postGeminiVoice({
			url,
			key,
			signal: ctl.signal,
			fetchFn,
			body: {
				model: apiModel,
				input: cleaned,
				response_modalities: ['audio'],
				generation_config: {
					speech_config: [{ voice: voiceName, language: languageCode }],
				},
				store: false,
			},
		})
		const steps = Array.isArray(data.steps) ? data.steps : []
		const part = steps
			.filter(s => s.type === 'model_output')
			.flatMap(s => Array.isArray(s.content) ? s.content : [])
			.find(c => c?.type === 'audio' && c?.data)
		if (!part) throw new Error(`Gemini TTS 오디오 응답 없음 (${data.status ?? 'EMPTY'})`)
		const audio = ensureWav(Buffer.from(part.data, 'base64'), part.mime_type || '')
		return { audio, mimeType: 'audio/wav', format: 'wav', ms: Date.now() - started, model: apiModel, voice: voiceName }
	} catch (e) {
		if (ctl.signal.aborted) throw ctl.signal.reason
		throw e
	} finally {
		cleanup()
	}
}
