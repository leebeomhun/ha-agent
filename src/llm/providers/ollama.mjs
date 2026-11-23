// 로컬 Ollama API 어댑터 (/api/chat, tool-use 지원)
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { P } from '../../util.mjs'
import { INSTRUCTIONS, TOOLS, FILE_TOOL_NAMES, runTool } from '../../api.mjs'
import { runToolRound } from '../../tools/registry.mjs'

const BUDGET = 200000

export async function runOllama({
	cfg, prompt, timeoutSec = 120, model = null,
	brainDir = P.brain, runDir = P.run, schema = P.schema,
	instructions = null, toolBroker = null, toolContext = null, customSchema = null,
	includeFileTools = undefined, fetchFn = fetch, signal,
}) {
	const o = cfg.llm?.ollama ?? {}
	const base = (o.base_url || 'http://127.0.0.1:11434').replace(/\/+$/, '')
	const resolvedSchema = customSchema ?? (schema ? JSON.parse(readFileSync(schema, 'utf8')) : null)
	const useFileTools = includeFileTools ?? !customSchema
	if (useFileTools && runDir) rmSync(join(runDir, 'answer.json'), { force: true })

	const started = Date.now(), ctl = new AbortController()
	const timer = setTimeout(() => ctl.abort(new Error(`Ollama 시간 초과 (${timeoutSec}초)`)), timeoutSec * 1000)
	const onAbort = () => ctl.abort(signal.reason instanceof Error ? signal.reason : new Error('Ollama 중단됨'))
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
		type: 'function',
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}))
	const activeInstructions = instructions ?? (toolBroker
		? `${INSTRUCTIONS}\n추가로 제공된 Home Assistant 조회·제어·제안 도구도 정책 범위 안에서 쓸 수 있다.`
		: useFileTools ? INSTRUCTIONS : '')

	const messages = []
	if (activeInstructions) messages.push({ role: 'system', content: activeInstructions })
	if (Array.isArray(prompt)) {
		for (const m of prompt) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })
	} else {
		messages.push({ role: 'user', content: String(prompt) })
	}

	const maxCalls = cfg?.api?.max_tool_calls ?? 30
	let tokens = 0, calls = 0, chars = 0, rounds = 0
	try {
		for (;;) {
			const last = calls >= maxCalls || chars >= BUDGET
			rounds++
			const res = await fetchFn(`${base}/api/chat`, {
				method: 'POST',
				signal: ctl.signal,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					model: model ?? o.model ?? 'qwen2.5:14b',
					messages,
					stream: false,
					...(tools.length && !last ? { tools } : {}),
					...(resolvedSchema && (!tools.length || last) ? { format: resolvedSchema } : {}),
				}),
			})
			const textBody = await res.text()
			if (!res.ok) throw new Error(`Ollama 오류 ${res.status}: ${textBody.slice(0, 250)}`)
			const data = JSON.parse(textBody)
			tokens += (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0)
			const msg = data.message ?? {}
			const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
			if (!rawCalls.length || last) {
				const outText = String(msg.content ?? '').trim()
				const cleaned = outText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
				let result
				if (resolvedSchema) {
					try { result = JSON.parse(cleaned) } catch (e) { throw new Error(`Ollama 답을 읽지 못함: ${e.message}; ${cleaned.slice(-200)}`) }
				} else {
					result = outText
				}
				return { result, ms: Date.now() - started, tokens: tokens || null, usage: null, tool_calls: calls, rounds }
			}
			messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: rawCalls })
			const normalizedCalls = rawCalls.map(tc => ({ ...tc, name: tc.function?.name }))
			const outs = await runToolRound(normalizedCalls, async tc => {
				const rawArgs = tc.function?.arguments ?? {}
				let out
				if (chars >= BUDGET) out = '오류: 이번 판단에서 읽을 수 있는 자료 양을 다 썼다. 지금까지 본 것으로 답한다.'
				else if (brokerNames.has(tc.name)) out = await toolBroker.run(tc.name, rawArgs, toolContext)
				else if (useFileTools) out = await runTool(tc.name, typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs), { brainDir })
				else out = '도구 없음'
				return typeof out === 'string' ? out : String(out)
			}, name => (useFileTools && FILE_TOOL_NAMES.has(name)) || (brokerNames.has(name) && Boolean(toolBroker?.isReadOnly?.(name))))
			normalizedCalls.forEach((tc, i) => {
				chars += outs[i].length
				messages.push({ role: 'tool', content: outs[i] })
			})
			calls += normalizedCalls.length
			const early = toolContext?.takeEarlyResult?.(normalizedCalls.map(tc => tc.name).filter(Boolean))
			if (early) return { result: early, ms: Date.now() - started, tokens: tokens || null, usage: null, tool_calls: calls, rounds, early: true }
		}
	} catch (e) {
		if (ctl.signal.aborted) throw ctl.signal.reason
		throw e
	} finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
}
