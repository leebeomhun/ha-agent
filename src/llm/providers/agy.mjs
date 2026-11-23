// Antigravity CLI(agy) 실행 어댑터: Gemini 모델을 구독 CLI로 실행한다.
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { P, expandHome } from '../../util.mjs'

const PROMPT_BYTE_LIMIT = 90000

const isExecutable = p => {
	try { accessSync(p, constants.X_OK); return true } catch { return false }
}

// 실행 파일 탐색: 절대/상대 경로 또는 PATH + ~/.local/bin 순서로 확인한다.
export function agyBin(cfg, { env = process.env } = {}) {
	const bin = expandHome(cfg?.agy?.bin || 'agy')
	if (bin.includes('/')) {
		if (!isExecutable(bin)) throw new Error(`agy 실행 파일을 찾지 못함: ${bin}`)
		return bin
	}
	const dirs = [
		...(env.PATH ? env.PATH.split(':').filter(Boolean) : []),
		join(homedir(), '.local', 'bin'),
	]
	for (const d of dirs) {
		const full = join(d, bin)
		if (isExecutable(full)) return full
	}
	throw new Error(`agy 실행 파일을 찾지 못함: ${bin}`)
}

const EFFORT_SUFFIX_RE = /^([a-z0-9._-]+)-(minimal|low|medium|high|xhigh|max)$/i

export function resolveAgyModelAndEffort(rawModel, effort = null) {
	const raw = String(rawModel || 'gemini-4-hydrogen').trim()
	const m = EFFORT_SUFFIX_RE.exec(raw)
	const baseModel = m ? m[1] : raw
	const inferred = m ? m[2].toLowerCase() : null
	const effRaw = effort ? String(effort).trim().toLowerCase() : inferred
	const eff = effRaw === 'minimal' ? 'low' : effRaw === 'max' ? 'high' : effRaw
	// agy CLI는 --model <name>-<effort>와 --effort <val>을 동시 전달하면 충돌 에러를 낸다.
	// effort가 결정되면 기본 모델명 + --effort로 정규화해 전달한다.
	if (eff) return { model: baseModel, effort: eff }
	return { model: raw, effort: null }
}

export function agyArgs({ cfg, model, effort, timeoutSec, schema, promptArg }) {
	const resolved = resolveAgyModelAndEffort(model ?? cfg?.agy?.model ?? 'gemini-4-hydrogen', effort)
	return [
		'--output-format', 'json',
		'--disable-slash-commands',
		'--sandbox',
		'--model', resolved.model,
		...(resolved.effort ? ['--effort', resolved.effort] : []),
		...(timeoutSec ? ['--print-timeout', `${Math.max(1, Math.round(Number(timeoutSec)))}s`] : []),
		...(schema ? ['--json-schema', String(schema)] : []),
		`-p=${promptArg}`,
	]
}

function stripCodeFences(s) {
	return String(s ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
}

export function parseAgyOutput(raw, expectJson = true) {
	const trimmed = String(raw ?? '').trim()
	if (!trimmed) throw new Error('agy 출력이 비어 있음')
	let parsed = null
	try {
		parsed = JSON.parse(trimmed)
	} catch {
		const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean).reverse()
		for (const line of lines) {
			if (line.startsWith('{')) {
				try { parsed = JSON.parse(line); break } catch {}
			}
		}
	}
	if (!parsed || typeof parsed !== 'object') throw new Error(`agy JSON 파싱 실패: ${trimmed.slice(-200)}`)
	if (parsed.status && parsed.status !== 'SUCCESS') {
		const msg = parsed.error ?? parsed.message ?? parsed.response ?? parsed.status
		throw new Error(`agy 실행 상태 오류 (${parsed.status}): ${String(msg).slice(0, 200)}`)
	}
	let result = parsed.structured_output
	if (result === undefined) {
		if (parsed.response === undefined || parsed.response === null) throw new Error('agy 응답에 structured_output/response가 없음')
		if (expectJson && typeof parsed.response === 'string') result = JSON.parse(stripCodeFences(parsed.response))
		else result = parsed.response
	}
	const u = parsed.usage
	const usage = u ? {
		input: u.input_tokens ?? 0,
		cached: u.cache_read_tokens ?? 0,
		output: u.output_tokens ?? 0,
		reasoning: u.thinking_tokens ?? 0,
	} : null
	const tokens = u?.total_tokens ?? (usage ? (usage.input + usage.output + usage.reasoning) || null : null)
	return { result, usage, tokens }
}

function formatPromptInput(prompt, instructions) {
	if (!Array.isArray(prompt)) return instructions ? `${instructions}\n\n${prompt}` : String(prompt)
	const msgs = prompt.map(m => `[${m.role}]\n${String(m.content ?? '')}`).join('\n\n')
	return instructions ? `# 지침\n${instructions}\n\n# 대화\n${msgs}` : msgs
}

export function sanitizedAgyEnv(cfg, baseEnv = process.env) {
	const env = { ...baseEnv }
	const localBin = join(homedir(), '.local', 'bin')
	env.PATH = env.PATH ? (env.PATH.includes(localBin) ? env.PATH : `${localBin}:${env.PATH}`) : localBin
	const secretKeys = [
		'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY',
		'SLACK_BOT_TOKEN', 'KAKAO_ACCESS_TOKEN', 'KAKAO_REFRESH_TOKEN', 'KAKAO_REST_API_KEY', 'KAKAO_CLIENT_SECRET',
		cfg?.api?.key_env, cfg?.gemini?.key_env, cfg?.llm?.gemini?.key_env, cfg?.llm?.anthropic?.key_env,
		cfg?.oob?.token_env, cfg?.oob?.refresh_token_env, cfg?.oob?.client_id_env, cfg?.oob?.client_secret_env,
		cfg?.oob?.fallback?.token_env, cfg?.oob?.fallback?.refresh_token_env, cfg?.oob?.fallback?.client_id_env, cfg?.oob?.fallback?.client_secret_env,
	]
	for (const k of secretKeys) if (k) delete env[k]
	return env
}

export function runAgy({
	cfg, prompt, effort = null, timeoutSec = null, model = null,
	brainDir = P.brain, runDir = P.run, schema = P.schema,
	instructions = null, customSchema = null, signal,
}) {
	const bin = agyBin(cfg)
	const mdl = model ?? cfg?.agy?.model ?? 'gemini-4-hydrogen'
	const resolvedTimeout = timeoutSec ?? cfg?.agy?.timeout_seconds ?? 240
	const resolvedSchemaArg = customSchema ? JSON.stringify(customSchema) : schema
	const promptText = formatPromptInput(prompt, instructions)
	const env = sanitizedAgyEnv(cfg)
	let promptFile = null
	let promptArg = promptText

	if (Buffer.byteLength(promptText, 'utf8') > PROMPT_BYTE_LIMIT) {
		const targetDir = runDir || join(brainDir, 'run')
		mkdirSync(targetDir, { recursive: true })
		promptFile = join(targetDir, `agy-prompt-${process.pid}.md`)
		writeFileSync(promptFile, promptText)
		const rel = relative(resolve(brainDir), resolve(promptFile))
		const safeRef = rel && !rel.startsWith('..') ? rel : promptFile
		promptArg = `현재 작업 디렉터리의 ${safeRef} 파일에 전체 요청과 컨텍스트가 있습니다. 파일을 읽고 지침에 따라 JSON 스키마에 맞는 최종 응답만 출력하세요.`
	}

	const args = agyArgs({
		cfg, model: mdl, effort, timeoutSec: resolvedTimeout, schema: resolvedSchemaArg, promptArg,
	})
	const started = Date.now()

	return new Promise((done, fail) => {
		const child = spawn(bin, args, { cwd: brainDir, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
		let out = '', err = '', timedOut = false, aborted = false, killTimer
		const keep = (chunk, isErr) => {
			if (isErr) err = (err + chunk).slice(-8000)
			else out += chunk
		}
		child.stdout.on('data', c => keep(c, false))
		child.stderr.on('data', c => keep(c, true))

		const killTree = sig => {
			if (!child.pid) return
			try {
				if (process.platform !== 'win32') process.kill(-child.pid, sig)
				else child.kill(sig)
			} catch { try { child.kill(sig) } catch {} }
		}
		const onAbort = () => {
			aborted = true
			killTree('SIGTERM')
			if (!killTimer) {
				killTimer = setTimeout(() => killTree('SIGKILL'), 5000)
				killTimer.unref()
			}
		}
		if (signal) {
			if (signal.aborted) onAbort()
			else signal.addEventListener('abort', onAbort, { once: true })
		}
		const timer = setTimeout(() => {
			timedOut = true
			killTree('SIGTERM')
			killTimer = setTimeout(() => killTree('SIGKILL'), 5000)
			killTimer.unref()
		}, resolvedTimeout * 1000)

		const cleanup = () => {
			clearTimeout(timer)
			clearTimeout(killTimer)
			signal?.removeEventListener('abort', onAbort)
			if (promptFile && existsSync(promptFile)) rmSync(promptFile, { force: true })
		}

		child.on('error', e => { cleanup(); fail(e) })
		child.on('close', (code, sig) => {
			cleanup()
			const ms = Date.now() - started
			const tail = (err || out).slice(-400).replace(/\s+/g, ' ')
			if (timedOut) return fail(new Error(`agy 시간 초과 (${resolvedTimeout}초)`))
			if (aborted) return fail(signal?.reason instanceof Error ? signal.reason : new Error('agy 중단됨'))
			if (code !== 0) return fail(new Error(`agy 종료 코드 ${code}${sig ? ` (${sig})` : ''} (${Math.round(ms / 1000)}초): ${tail}`))
			try {
				const parsed = parseAgyOutput(out, Boolean(resolvedSchemaArg))
				done({ ...parsed, ms })
			} catch (e) {
				fail(new Error(`agy 답을 읽지 못함: ${e.message}; ${tail}`))
			}
		})
	})
}
