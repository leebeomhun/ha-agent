// Anthropic Messages API 어댑터 (Zero-dependency fetch 기반, tool-use·재시도·캐시 토큰 집계·병렬 읽기 지원)
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

async function postAnthropic({ url, key, body, signal, fetchFn }) {
	for (let attempt = 0; ; attempt++) {
		let res, err
		try {
			res = await fetchFn(url, {
				method: 'POST',
				signal,
				headers: {
					'content-type': 'application/json',
					'x-api-key': key,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify(body),
			})
		} catch (e) {
			if (signal.aborted) throw e
			err = new Error(`Anthropic 연결 실패: ${e.cause?.code ?? e.cause?.message ?? e.message}`)
		}
		if (res?.ok) {
			const textBody = await res.text()
			try { return JSON.parse(textBody) } catch (e) { throw new Error(`Anthropic 응답 JSON 파싱 실패: ${e.message}`) }
		}
		if (res) {
			const textBody = await res.text().catch(() => '')
			let msg = textBody.slice(0, 250)
			try { msg = JSON.parse(textBody).error?.message ?? msg } catch {}
			err = new Error(`Anthropic 오류 ${res.status}: ${String(msg).replace(/\s+/g, ' ').slice(0, 250)}`)
			if (!RETRY_STATUS.has(res.status)) throw err
		}
		if (attempt >= 2) throw err
		await sleep(retryAfterMs(res) ?? (2000 * 3 ** attempt), signal)
	}
}

export function anthropicKey(cfg, { env = process.env, envFile = join(ROOT, '.env') } = {}) {
	const a = cfg.llm?.anthropic ?? {}
	if (a.key_file) {
		const k = readFileSync(expandHome(a.key_file), 'utf8').trim()
		if (k) return k
	}
	const keyEnv = a.key_env || 'ANTHROPIC_API_KEY'
	if (env[keyEnv]?.trim()) return env[keyEnv].trim()
	const fileEnv = readEnvFile(envFile)
	if (fileEnv[keyEnv]) return fileEnv[keyEnv]
	throw new Error(`Anthropic API 키를 찾지 못함 (${keyEnv})`)
}

export async function runAnthropic({
	cfg, prompt, timeoutSec = 120, model = null,
	brainDir = P.brain, runDir = P.run, schema = P.schema,
	instructions = null, toolBroker = null, toolContext = null, customSchema = null,
	includeFileTools = undefined, fetchFn = fetch, signal,
}) {
	const key = anthropicKey(cfg)
	const a = cfg.llm?.anthropic ?? {}
	const resolvedSchema = customSchema ?? (schema ? JSON.parse(readFileSync(schema, 'utf8')) : null)
	const useFileTools = includeFileTools ?? !customSchema
	if (useFileTools && runDir) rmSync(join(runDir, 'answer.json'), { force: true })

	const url = `${(a.base_url || 'https://api.anthropic.com/v1').replace(/\/+$/, '')}/messages`
	const started = Date.now(), ctl = new AbortController()
	const timer = setTimeout(() => ctl.abort(new Error(`Anthropic 시간 초과 (${timeoutSec}초)`)), timeoutSec * 1000)
	const onAbort = () => ctl.abort(signal.reason instanceof Error ? signal.reason : new Error('Anthropic 중단됨'))
	if (signal) {
		if (signal.aborted) onAbort()
		else signal.addEventListener('abort', onAbort, { once: true })
	}

	const brokerList = toolBroker ? toolBroker.tools(toolContext) : []
	const brokerNames = new Set(brokerList.map(t => t.name))
	const activeTools = [
		...(useFileTools ? TOOLS : []),
		...brokerList,
	]
	const tools = activeTools.map(t => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters,
	}))
	const messages = Array.isArray(prompt)
		? prompt.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }))
		: [{ role: 'user', content: String(prompt) }]
	const baseInstr = instructions ?? (toolBroker
		? `${INSTRUCTIONS}\n추가로 제공된 Home Assistant 조회·제어·제안 도구도 정책 범위 안에서 쓸 수 있다.`
		: useFileTools ? INSTRUCTIONS : '')
	const sys = resolvedSchema
		? `${baseInstr}\n\n반드시 다음 JSON 스키마에 맞는 순수 JSON 객체 하나만 출력하라:\n${JSON.stringify(resolvedSchema)}`
		: baseInstr

	const maxCalls = cfg.api?.max_tool_calls ?? 30
	let tokens = 0, calls = 0, chars = 0, rounds = 0
	const usage = { input: 0, cached: 0, output: 0, reasoning: 0 }
	try {
		for (;;) {
			const last = calls >= maxCalls || chars >= BUDGET
			rounds++
			const data = await postAnthropic({
				url, key, signal: ctl.signal, fetchFn,
				body: {
					model: model ?? a.model ?? 'claude-sonnet-4-5',
					max_tokens: 4096,
					system: sys,
					messages,
					...(tools.length && !last ? { tools } : {}),
				},
			})
			if (data.usage) {
				usage.input += data.usage.input_tokens ?? 0
				usage.cached += data.usage.cache_read_input_tokens ?? 0
				usage.output += data.usage.output_tokens ?? 0
				tokens += (data.usage.input_tokens ?? 0) + (data.usage.cache_read_input_tokens ?? 0) + (data.usage.output_tokens ?? 0)
			}
			const content = Array.isArray(data.content) ? data.content : []
			const toolUses = content.filter(b => b.type === 'tool_use')
			if (!toolUses.length || last) {
				const outText = content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
				const cleaned = outText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
				let result
				if (resolvedSchema) {
					try { result = JSON.parse(cleaned) } catch (e) { throw new Error(`Anthropic 답을 읽지 못함: ${e.message}; ${cleaned.slice(-200)}`) }
				} else {
					result = outText
				}
				return { result, ms: Date.now() - started, tokens: tokens || null, usage, tool_calls: calls, rounds }
			}
			messages.push({ role: 'assistant', content })
			const outs = await runToolRound(toolUses, async tu => {
				let out
				if (chars >= BUDGET) out = '오류: 이번 판단에서 읽을 수 있는 자료 양을 다 썼다. 지금까지 본 것으로 답한다.'
				else if (brokerNames.has(tu.name)) out = await toolBroker.run(tu.name, tu.input, toolContext)
				else if (useFileTools) out = await runTool(tu.name, JSON.stringify(tu.input ?? {}), { brainDir })
				else out = '도구 없음'
				return typeof out === 'string' ? out : String(out)
			}, name => (useFileTools && FILE_TOOL_NAMES.has(name)) || (brokerNames.has(name) && Boolean(toolBroker?.isReadOnly?.(name))))
			const toolResults = toolUses.map((tu, i) => {
				chars += outs[i].length
				return { type: 'tool_result', tool_use_id: tu.id, content: outs[i] }
			})
			messages.push({ role: 'user', content: toolResults })
			calls += toolUses.length
			const early = toolContext?.takeEarlyResult?.(toolUses.map(tu => tu.name))
			if (early) return { result: early, ms: Date.now() - started, tokens: tokens || null, usage, tool_calls: calls, rounds, early: true }
		}
	} catch (e) {
		if (ctl.signal.aborted) throw ctl.signal.reason
		throw e
	} finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
}
