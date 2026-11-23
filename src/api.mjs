// API 실행: Codex 없이 OpenAI Responses API를 직접 불러 판단을 받는다.
// 모델은 HA에도 셸에도 닿지 않는다. brain/ 폴더의 파일을 읽는 도구(또는 정책 검증된 ToolBroker)만 받고 답을 돌려준다.
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { P, ROOT, expandHome, readEnvFile } from './util.mjs'
import { runToolRound } from './tools/registry.mjs'

const OUT_MAX = 16000 // 도구 한 번이 돌려주는 글자 수
const BUDGET = 200000 // 한 번의 판단에서 도구가 돌려주는 글자 수 합계

// reasoning 파라미터를 받지 않는 옛 비추론 모델(gpt-4o, gpt-4.1 등). 여기에는 effort none이어도 reasoning을 보내지 않는다.
const NON_REASONING = /^(gpt-4|gpt-3|chatgpt-4o)/i
// GPT-6.2부터는 top-level instructions가 input 뒤에 붙어 프롬프트 캐시가 깨지므로 developer 메시지로 맨 앞에 넣는다.
const DEV_FIRST = /^gpt-(6\.[2-9]|[7-9])/i

// effort 해석: 'off'/'disabled'/빈 값 → reasoning 생략, 'none' → 추론 모델이면 { effort: 'none' }을 명시(생략하면 모델 기본값 medium으로 돈다).
export function reasoningFor(model, effort) {
	const e = effort == null ? '' : String(effort).trim().toLowerCase()
	if (!e || e === 'off' || e === 'disabled') return null
	if (e === 'none' && NON_REASONING.test(String(model ?? ''))) return null
	return e === 'none' ? { reasoning: { effort: 'none' } } : { reasoning: { effort: e }, include: ['reasoning.encrypted_content'] }
}
const LINE_MAX = 2000

// 키는 파일(api.key_file) → 환경 변수 → 프로젝트 .env 순서로 찾는다.
// .env를 process.env에 올리지 않는다(Codex 자식 프로세스로 넘어가지 않게).
export function apiKey(cfg, { env = process.env, envFile = join(ROOT, '.env') } = {}) {
	const a = cfg.api
	if (a.key_file) {
		const k = readFileSync(expandHome(a.key_file), 'utf8').trim()
		if (!k) throw new Error(`API 키 파일이 비어 있음: ${a.key_file}`)
		return k
	}
	if (env[a.key_env]?.trim()) return env[a.key_env].trim()
	const fileEnv = readEnvFile(envFile)
	if (fileEnv[a.key_env]) return fileEnv[a.key_env]
	throw new Error(`API 키를 찾지 못함: 환경 변수 ${a.key_env}, 프로젝트의 .env, config.json의 api.key_file 가운데 하나에 넣어야 함`)
}

// ── 파일 도구: brainDir/run 안에서만, 읽기만 ──
function runRootOf(brainDir) {
	const brainRoot = realpathSync(brainDir)
	let runRoot
	try { runRoot = realpathSync(join(brainRoot, 'run')) } catch { return { brainRoot, runRoot: null } }
	if (runRoot !== brainRoot && !runRoot.startsWith(brainRoot + sep)) throw new Error('run 폴더 경로가 올바르지 않음')
	return { brainRoot, runRoot }
}
function inside(brainDir, p) {
	if (typeof p !== 'string' || !p) throw new Error('path가 비어 있음')
	const { brainRoot, runRoot } = runRootOf(brainDir)
	if (!runRoot) throw new Error(`파일 없음: ${p}`)
	let real
	try { real = realpathSync(resolve(brainRoot, p)) } catch { throw new Error(`파일 없음: ${p}`) }
	if (real !== runRoot && !real.startsWith(runRoot + sep)) throw new Error('이 폴더 밖은 읽을 수 없음')
	return real
}
function walk(dir, root, out = []) {
	for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = join(dir, d.name)
		if (d.isDirectory()) walk(full, root, out)
		else if (d.isFile()) out.push(relative(root, full))
	}
	return out
}
const clip = (s, max = OUT_MAX) => (s.length > max ? `${s.slice(0, max)}\n… (잘림: 전체 ${s.length}자. 범위를 좁혀 다시 읽는다)` : s)
const int = (v, dflt, min, max) => Math.min(Math.max(Number.isFinite(Number(v)) && v !== null ? Math.round(Number(v)) : dflt, min), max)

const TOOL_FNS = {
	list_files({ brainDir }) {
		const { brainRoot, runRoot } = runRootOf(brainDir)
		if (!runRoot) return '(파일 없음)'
		return walk(runRoot, brainRoot).map(f => `${f}  ${statSync(join(brainRoot, f)).size}바이트`).join('\n') || '(파일 없음)'
	},
	read_file({ brainDir }, a) {
		const lines = readFileSync(inside(brainDir, a.path), 'utf8').split('\n')
		const start = int(a.start_line, 1, 1, Math.max(lines.length, 1)), n = int(a.max_lines, 200, 1, 2000)
		const part = lines.slice(start - 1, start - 1 + n).map((l, i) => `${start + i}: ${l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l}`)
		const end = start + part.length - 1
		return clip(part.join('\n')) + (end < lines.length ? `\n(전체 ${lines.length}줄 가운데 ${start}~${end}줄)` : '')
	},
	// 모델이 준 정규식을 Node에서 돌리면 나쁜 패턴 하나로 주 루프가 멈출 수 있어, 시간 제한을 걸고 grep에 맡긴다.
	grep({ brainDir }, a) {
		if (typeof a.pattern !== 'string' || !a.pattern) throw new Error('pattern이 비어 있음')
		const { brainRoot, runRoot } = runRootOf(brainDir)
		const files = a.path ? [relative(brainRoot, inside(brainDir, a.path))] : (runRoot ? walk(runRoot, brainRoot) : [])
		if (!files.length) return '(파일 없음)'
		const args = ['-n', '-H', '-i', '-E', '-m', String(int(a.max_matches, 50, 1, 200)), '-C', String(int(a.context, 0, 0, 20)), '-e', a.pattern, '--', ...files]
		return new Promise((done, fail) => {
			execFile('grep', args, { cwd: brainRoot, timeout: 5000, maxBuffer: 4 << 20, env: { PATH: process.env.PATH, LC_ALL: 'C.UTF-8' } }, (err, stdout, stderr) => {
				if (!err) return done(clip(stdout))
				if (err.code === 1) return done('(찾은 줄 없음)')
				fail(new Error(err.killed ? '검색이 너무 오래 걸림. 패턴을 단순하게 한다' : `grep 오류: ${String(stderr || err.message).trim().slice(0, 200)}`))
			})
		})
	},
	// jq '."키"'를 대신한다. 배열에서는 번호, 또는 원소의 id 값으로 고른다(run/states.json에서 엔티티 하나 꺼내기).
	json_get({ brainDir }, a) {
		let v = JSON.parse(readFileSync(inside(brainDir, a.path), 'utf8'))
		for (const k of Array.isArray(a.keys) ? a.keys : []) {
			const key = String(k)
			if (Array.isArray(v)) v = /^\d+$/.test(key) ? v[Number(key)] : v.find(x => x && typeof x === 'object' && x.id === key)
			else if (v && typeof v === 'object' && Object.hasOwn(v, key)) v = v[key]
			else v = undefined
			if (v === undefined) return `(없음: ${JSON.stringify(key)})`
		}
		const text = JSON.stringify(v, null, 1)
		if (text.length <= OUT_MAX) return text
		// 통째로는 너무 크면 무엇이 들어 있는지만 알려 준다.
		if (Array.isArray(v)) return clip(`배열 ${v.length}개, 전체 ${text.length}자라 다 보여줄 수 없음. keys에 번호나 id를 더해 좁힌다. id 목록: ${v.map((x, i) => x?.id ?? i).join(', ')}`)
		return clip(`객체, 전체 ${text.length}자라 다 보여줄 수 없음. keys에 키를 더해 좁힌다. 키 목록: ${Object.keys(v).join(', ')}`)
	},
}

const fn = (name, description, properties) => ({ type: 'function', name, description, strict: true, parameters: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } })
export const TOOLS = [
	fn('list_files', '읽을 수 있는 파일 목록과 크기', {}),
	fn('grep', '파일에서 정규식(ERE, 대소문자 무시)에 맞는 줄을 줄 번호와 함께 찾는다', {
		pattern: { type: 'string', description: '정규식. 예: "id": "light\\.' },
		path: { type: ['string', 'null'], description: '파일 경로(예: run/states.json). null이면 모든 파일' },
		context: { type: ['integer', 'null'], description: '찾은 줄 앞뒤로 함께 보여줄 줄 수(0~20). null이면 0' },
		max_matches: { type: ['integer', 'null'], description: '파일마다 찾을 줄 수(1~200). null이면 50' },
	}),
	fn('json_get', 'JSON 파일에서 키 경로로 한 부분만 꺼낸다(jq를 대신한다). 배열에서는 번호 또는 원소의 id 값으로 고른다', {
		path: { type: 'string', description: '파일 경로(예: run/automation-configs.json)' },
		keys: { type: 'array', items: { type: 'string' }, description: '키 경로. 예: ["automation.abc"], run/states.json에서는 ["light.bul"]. 빈 배열이면 전체' },
	}),
	fn('read_file', '파일을 줄 범위로 읽는다', {
		path: { type: 'string', description: '파일 경로' },
		start_line: { type: ['integer', 'null'], description: '시작 줄(1부터). null이면 1' },
		max_lines: { type: ['integer', 'null'], description: '읽을 줄 수(1~2000). null이면 200' },
	}),
]
export const FILE_TOOL_NAMES = new Set(TOOLS.map(t => t.name))

// 도구 오류는 던지지 않고 글로 돌려준다(모델이 고쳐서 다시 부를 수 있게).
export async function runTool(name, argsJson, ctx) {
	try {
		if (!Object.hasOwn(TOOL_FNS, name)) throw new Error(`없는 도구: ${name}`)
		return await TOOL_FNS[name](ctx, argsJson ? JSON.parse(argsJson) : {})
	} catch (e) { return `오류: ${e.message}` }
}

export const INSTRUCTIONS = [
	'이 실행에는 셸이 없다. 지침에 `jq`나 `grep`으로 찾아보라고 적힌 곳은 아래 도구로 대신한다.',
	'- grep: 정규식으로 줄 찾기(context로 앞뒤 줄 포함)',
	'- json_get: JSON에서 키 경로로 한 부분만 꺼내기. run/states.json에서는 keys에 엔티티 id를 주면 그 엔티티만 나온다',
	'- read_file: 줄 범위로 읽기, list_files: 파일 목록',
	'경로는 프롬프트에 적힌 그대로 쓴다(run/states.json 등). 도구를 부를 때마다 비용이 드니 필요한 것만 읽고, 여러 개가 필요하면 한 번에 함께 부른다.',
	'다 봤으면 스키마에 맞는 최종 JSON 답 하나만 낸다.',
].join('\n')

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

// 잠깐의 오류(한도·서버 오류·연결 끊김)는 두 번까지 다시 보낸다. 그 밖은 판단 실패로 올려 본체가 다시 깨운다.
async function post({ url, key, body, signal, fetchFn }) {
	for (let attempt = 0; ; attempt++) {
		let res, err
		try {
			res = await fetchFn(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) })
		} catch (e) {
			if (signal.aborted) throw e
			err = new Error(`API 연결 실패: ${e.cause?.code ?? e.cause?.message ?? e.message}`)
		}
		if (res?.ok) return res.json()
		if (res) {
			const text = await res.text().catch(() => '')
			let msg = text.slice(0, 300)
			try { msg = JSON.parse(text).error?.message ?? msg } catch {}
			err = new Error(`API 오류 ${res.status}: ${String(msg).replace(/\s+/g, ' ').slice(0, 300)}`)
			if (!RETRY_STATUS.has(res.status)) throw err
		}
		if (attempt >= 2) throw err
		await sleep(retryAfterMs(res) ?? (2000 * 3 ** attempt), signal)
	}
}

function finalAnswer(res, parseJson = true) {
	if (res.status === 'incomplete') throw new Error(`API 답이 중간에 끊김: ${res.incomplete_details?.reason ?? '이유 모름'}`)
	const parts = (res.output ?? []).filter(o => o.type === 'message').flatMap(o => o.content ?? [])
	const refusal = parts.find(c => c.type === 'refusal')
	if (refusal) throw new Error(`모델이 답을 거절함: ${String(refusal.refusal).slice(0, 200)}`)
	const text = parts.filter(c => c.type === 'output_text').map(c => c.text).join('')
	if (!text) throw new Error('API 답에 내용이 없음')
	if (!parseJson) return text
	try { return JSON.parse(text) } catch (e) { throw new Error(`API 답을 읽지 못함: ${e.message}; ${text.slice(-200)}`) }
}

// runCodex와 같은 모양으로 받고 돌려준다. 대화는 OpenAI에 저장하지 않고(store: false) 매번 전체를 다시 보낸다.
export async function runApi({ cfg, prompt, effort, timeoutSec, model, brainDir = P.brain, runDir = P.run, schema = P.schema, fetchFn = fetch, signal, toolBroker = null, toolContext = null, instructions = null, customSchema = null, includeFileTools = true }) {
	const key = apiKey(cfg)
	const resolvedSchema = customSchema ?? (schema ? JSON.parse(readFileSync(schema, 'utf8')) : null)
	const format = resolvedSchema ? { type: 'json_schema', name: 'ha_agent_answer', strict: true, schema: resolvedSchema } : { type: 'text' }
	// Codex가 남긴 지난 답을 자료로 읽지 않게 지운다(파일 도구를 쓰지 않는 Assist 호출에서는 건드리지 않는다).
	if (includeFileTools && runDir) rmSync(join(runDir, 'answer.json'), { force: true })
	const url = `${cfg.api.base_url.replace(/\/+$/, '')}/responses`
	const started = Date.now(), ctl = new AbortController()
	const timer = setTimeout(() => ctl.abort(new Error(`API 응답 시간 초과 (${timeoutSec}초)`)), timeoutSec * 1000)
	const onAbort = () => ctl.abort(signal.reason instanceof Error ? signal.reason : new Error('API 중단됨'))
	if (signal) {
		if (signal.aborted) onAbort()
		else signal.addEventListener('abort', onAbort, { once: true })
	}
	const modelName = model ?? cfg.api.model ?? cfg.codex.model
	const reasoning = reasoningFor(modelName, effort)
	const input = Array.isArray(prompt) ? [...prompt] : [{ role: 'user', content: prompt }]
	const activeTools = [
		...(includeFileTools ? TOOLS : []),
		...(toolBroker ? toolBroker.tools(toolContext) : []),
	]
	const activeInstructions = instructions ?? (toolBroker
		? `${INSTRUCTIONS}\n추가로 제공된 Home Assistant 조회·제어·제안 도구도 정책 범위 안에서 쓸 수 있다.`
		: INSTRUCTIONS)
	const devFirst = DEV_FIRST.test(String(modelName ?? ''))
	if (devFirst) input.unshift({ role: 'developer', content: activeInstructions })
	let tokens = 0, calls = 0, chars = 0, rounds = 0
	const usage = { input: 0, cached: 0, output: 0, reasoning: 0 }
	const summary = () => {
		const hasUsage = usage.input || usage.cached || usage.output || usage.reasoning
		return { ms: Date.now() - started, tokens: tokens || null, usage: hasUsage ? usage : null, tool_calls: calls, rounds }
	}
	try {
		for (;;) {
			// 도구 호출 한도에 닿으면 도구 없이 답만 받는다.
			const last = calls >= cfg.api.max_tool_calls || chars >= BUDGET
			rounds++
			const res = await post({
				url, key, signal: ctl.signal, fetchFn,
				body: {
					model: modelName, ...(devFirst ? {} : { instructions: activeInstructions }), input,
					...(activeTools.length ? { tools: activeTools, tool_choice: last ? 'none' : 'auto' } : {}),
					text: { format }, store: false,
					...(reasoning ?? {}),
				},
			})
			const u = res.usage
			if (u) {
				tokens += u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0))
				usage.input += u.input_tokens ?? 0
				usage.cached += u.input_tokens_details?.cached_tokens ?? 0
				usage.output += u.output_tokens ?? 0
				usage.reasoning += u.output_tokens_details?.reasoning_tokens ?? 0
			}
			const asked = (res.output ?? []).filter(o => o.type === 'function_call')
			if (!asked.length || last) {
				return { result: finalAnswer(res, Boolean(resolvedSchema)), ...summary() }
			}
			// 추론 항목(암호화된 것)과 도구 호출을 그대로 되돌려 보내야 다음 차례가 이어진다.
			input.push(...res.output)
			const outs = await runToolRound(asked, async c => {
				let out
				if (chars >= BUDGET) out = '오류: 이번 판단에서 읽을 수 있는 자료 양을 다 썼다. 지금까지 본 것으로 답한다.'
				else if (toolBroker?.has(c.name)) out = await toolBroker.run(c.name, c.arguments, toolContext)
				else out = await runTool(c.name, c.arguments, { brainDir })
				return typeof out === 'string' ? out : String(out)
			}, name => (includeFileTools && FILE_TOOL_NAMES.has(name)) || Boolean(toolBroker?.has(name) && toolBroker.isReadOnly?.(name)))
			asked.forEach((c, i) => {
				chars += outs[i].length
				input.push({ type: 'function_call_output', call_id: c.call_id, output: outs[i] })
			})
			calls += asked.length
			// 제어만 하고 성공했으면 마지막 답을 받으러 한 번 더 왕복하지 않는다.
			const early = toolContext?.takeEarlyResult?.(asked.map(c => c.name))
			if (early) return { result: early, ...summary(), early: true }
		}
	} catch (e) {
		if (ctl.signal.aborted) throw ctl.signal.reason
		throw e
	} finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
}
