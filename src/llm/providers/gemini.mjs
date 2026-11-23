// Google Gemini Interactions API 어댑터 (Zero-dependency fetch 기반, /v1beta/interactions + response_format + step_list 도구 루프)
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { P, ROOT, expandHome, readEnvFile } from '../../util.mjs'
import { INSTRUCTIONS, TOOLS, FILE_TOOL_NAMES, runTool } from '../../api.mjs'
import { runToolRound } from '../../tools/registry.mjs'

const BUDGET = 200000
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

const sleep = (ms, signal) => new Promise((done, fail) => {
	const t = setTimeout(done, ms)
	signal.addEventListener('abort', () => { clearTimeout(t); fail(signal.reason) }, { once: true })
})

function retryAfterMs(res) {
	const raw = res?.headers?.get?.('retry-after')
	if (!raw) return null
	const sec = Number(raw)
	if (Number.isFinite(sec) && sec >= 0) return Math.min(Math.round(sec * 1000), 30000)
	const ts = Date.parse(raw)
	if (Number.isFinite(ts)) return Math.min(Math.max(0, ts - Date.now()), 30000)
	return null
}

async function postGemini({ url, key, body, signal, fetchFn }) {
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
			err = new Error(`Gemini 연결 실패: ${e.cause?.code ?? e.cause?.message ?? e.message}`)
		}
		if (res?.ok) {
			const text = await res.text()
			try { return JSON.parse(text) } catch (e) { throw new Error(`Gemini 응답 JSON 파싱 실패: ${e.message}`) }
		}
		if (res) {
			const text = await res.text().catch(() => '')
			let msg = text.slice(0, 250)
			try { msg = JSON.parse(text).error?.message ?? msg } catch {}
			err = new Error(`Gemini 오류 ${res.status}: ${String(msg).replace(/\s+/g, ' ').slice(0, 250)}`)
			if (!RETRY_STATUS.has(res.status)) throw err
		}
		if (attempt >= 2) throw err
		await sleep(retryAfterMs(res) ?? (2000 * 3 ** attempt), signal)
	}
}

const dropNull = obj => Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined && v !== null))

const THINKING_LEVEL_MAP = {
	minimal: 'minimal',
	low: 'low',
	medium: 'medium',
	high: 'high',
	xhigh: 'high',
	max: 'high',
}

export function resolveGeminiModelAndThinking(rawModel, effort = null, fallbackEffort = null) {
	const raw = String(rawModel || 'gemini-4-hydrogen').trim()
	const m = /^(gemini-(?:[3-9]|\d{2,})[a-z0-9._-]*)-(minimal|low|medium|high|xhigh)$/i.exec(raw)
	const apiModel = m ? m[1] : raw
	const inferredEffort = m ? m[2] : null
	const rawEffort = effort ?? inferredEffort ?? fallbackEffort
	const key = rawEffort == null ? '' : String(rawEffort).trim().toLowerCase()
	const thinkingLevel = THINKING_LEVEL_MAP[key] ?? null
	const supportsThinkingLevel = /^gemini-(?:[3-9]|\d{2,})/i.test(apiModel)
	// Gemini 4 계열은 minimal을 받지 않는다(가장 낮은 단계가 low).
	const level = thinkingLevel === 'minimal' && /^gemini-(?:[4-9]|\d{2,})/i.test(apiModel) ? 'low' : thinkingLevel
	return {
		apiModel,
		thinkingLevel: supportsThinkingLevel && level ? level : null,
	}
}

export function geminiKey(cfg, { env = process.env, envFile = join(ROOT, '.env') } = {}) {
	const g = { ...dropNull(cfg?.llm?.gemini), ...dropNull(cfg?.gemini) }
	if (g.key_file) {
		const k = readFileSync(expandHome(g.key_file), 'utf8').trim()
		if (!k) throw new Error(`Gemini API 키 파일이 비어 있음: ${g.key_file}`)
		return k
	}
	const keyEnv = g.key_env || 'GEMINI_API_KEY'
	if (env[keyEnv]?.trim()) return env[keyEnv].trim()
	const fileEnv = readEnvFile(envFile)
	if (fileEnv[keyEnv]) return fileEnv[keyEnv]
	throw new Error(`Gemini API 키를 찾지 못함 (${keyEnv})`)
}

export async function runGemini({
	cfg, prompt, effort = null, timeoutSec = null, model = null,
	brainDir = P.brain, runDir = P.run, schema = P.schema,
	instructions = null, toolBroker = null, toolContext = null, customSchema = null,
	includeFileTools = undefined, fetchFn = fetch, signal,
}) {
	const key = geminiKey(cfg)
	const g = { ...dropNull(cfg?.llm?.gemini), ...dropNull(cfg?.gemini) }
	const rawMdl = model ?? g.model ?? 'gemini-4-hydrogen'
	const { apiModel, thinkingLevel } = resolveGeminiModelAndThinking(rawMdl, effort, cfg?.gemini?.effort ?? cfg?.agy?.effort ?? 'medium')
	const resolvedTimeout = timeoutSec ?? cfg?.gemini?.timeout_seconds ?? cfg?.agy?.timeout_seconds ?? g.timeout_seconds ?? 120
	const maxCalls = g.max_tool_calls ?? cfg?.api?.max_tool_calls ?? 30
	const resolvedSchema = customSchema ?? (schema ? JSON.parse(readFileSync(schema, 'utf8')) : null)
	const useFileTools = includeFileTools ?? !customSchema
	if (useFileTools && runDir) rmSync(join(runDir, 'answer.json'), { force: true })

	const url = `${(g.base_url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')}/interactions`
	const started = Date.now(), ctl = new AbortController()
	const timer = setTimeout(() => ctl.abort(new Error(`Gemini 시간 초과 (${resolvedTimeout}초)`)), resolvedTimeout * 1000)
	const onAbort = () => ctl.abort(signal.reason instanceof Error ? signal.reason : new Error('Gemini 중단됨'))
	if (signal) {
		if (signal.aborted) onAbort()
		else signal.addEventListener('abort', onAbort, { once: true })
	}

	const input = Array.isArray(prompt)
		? prompt.map(m => ({
			type: (m.role === 'assistant' || m.role === 'model') ? 'model_output' : 'user_input',
			content: [{ type: 'text', text: String(m.content ?? '') }],
		}))
		: [{ type: 'user_input', content: [{ type: 'text', text: String(prompt) }] }]

	const brokerList = toolBroker ? toolBroker.tools(toolContext) : []
	const brokerNames = new Set(brokerList.map(t => t.name))
	const activeTools = [
		...(useFileTools ? TOOLS : []),
		...brokerList,
	]
	const tools = activeTools.map(t => ({
		type: 'function',
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}))

	const activeInstructions = instructions ?? (toolBroker
		? `${INSTRUCTIONS}\n추가로 제공된 Home Assistant 조회·제어·제안 도구도 정책 범위 안에서 쓸 수 있다.`
		: useFileTools ? INSTRUCTIONS : '')

	const generationConfig = thinkingLevel ? { thinking_level: thinkingLevel } : null

	let tokens = 0, calls = 0, chars = 0, rounds = 0
	const usage = { input: 0, cached: 0, output: 0, reasoning: 0 }
	const summary = () => {
		const hasUsage = usage.input || usage.cached || usage.output || usage.reasoning
		return { ms: Date.now() - started, tokens: tokens || null, usage: hasUsage ? usage : null, tool_calls: calls, rounds }
	}
	try {
		for (;;) {
			const last = calls >= maxCalls || chars >= BUDGET
			rounds++
			const data = await postGemini({
				url, key, signal: ctl.signal, fetchFn,
				body: {
					model: apiModel,
					...(activeInstructions ? { system_instruction: activeInstructions } : {}),
					input,
					...(tools.length && !last ? { tools } : {}),
					...(resolvedSchema ? { response_format: resolvedSchema } : {}),
					...(generationConfig ? { generation_config: generationConfig } : {}),
					store: false,
				},
			})
			const u = data.usage
			if (u) {
				usage.input += u.total_input_tokens ?? 0
				usage.cached += u.total_cached_tokens ?? 0
				usage.output += u.total_output_tokens ?? 0
				usage.reasoning += u.total_thought_tokens ?? 0
				tokens += u.total_tokens ?? ((u.total_input_tokens ?? 0) + (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0))
			}
			const steps = Array.isArray(data.steps) ? data.steps : []
			const fnCalls = steps.filter(s => s.type === 'function_call')
			if (!fnCalls.length || last) {
				const outText = steps
					.filter(s => s.type === 'model_output')
					.flatMap(s => Array.isArray(s.content) ? s.content : [])
					.filter(c => c?.type === 'text' && typeof c.text === 'string')
					.map(c => c.text)
					.join('')
					.trim()
				if (!outText) throw new Error(`Gemini 답에 내용이 없음 (${data.status ?? 'EMPTY'})`)
				const cleaned = outText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
				let result
				if (resolvedSchema) {
					try { result = JSON.parse(cleaned) } catch (e) { throw new Error(`Gemini 답을 읽지 못함: ${e.message}; ${cleaned.slice(-200)}`) }
				} else {
					result = outText
				}
				return { result, ...summary() }
			}
			input.push(...steps)
			const outs = await runToolRound(fnCalls, async fc => {
				let out
				if (chars >= BUDGET) out = '오류: 이번 판단에서 읽을 수 있는 자료 양을 다 썼다. 지금까지 본 것으로 답한다.'
				else if (brokerNames.has(fc.name)) out = await toolBroker.run(fc.name, fc.arguments ?? {}, toolContext)
				else if (useFileTools) out = await runTool(fc.name, JSON.stringify(fc.arguments ?? {}), { brainDir })
				else out = '도구 없음'
				return typeof out === 'string' ? out : String(out)
			}, name => (useFileTools && FILE_TOOL_NAMES.has(name)) || (brokerNames.has(name) && Boolean(toolBroker.isReadOnly?.(name))))
			fnCalls.forEach((fc, i) => {
				chars += outs[i].length
				input.push({ type: 'function_result', call_id: fc.id, name: fc.name, result: outs[i] })
			})
			calls += fnCalls.length
			// 제어만 하고 성공했으면(호출 때 받아 둔 답 문장이 있으면) 마지막 답을 받으러 한 번 더 왕복하지 않는다.
			const early = toolContext?.takeEarlyResult?.(fnCalls.map(fc => fc.name))
			if (early) return { result: early, ...summary(), early: true }
		}
	} catch (e) {
		if (ctl.signal.aborted) throw ctl.signal.reason
		throw e
	} finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
}
