// 판단 받기: Codex CLI(codex) 또는 OpenAI API 직접 호출(api, src/api.mjs) 가운데 고른 방식으로 묻는다.
// Codex 실행: 사용자 Codex 설정(플러그인·MCP·메모리)을 쓰지 않고, brain/ 폴더만 읽을 수 있게 격리해서 돌린다.
// 어느 쪽이든 HA에 직접 닿지 않는다. 답(JSON)만 돌려주고, 적용은 이 프로그램이 검사한 뒤 한다.
import { spawn } from 'node:child_process'
import { existsSync, realpathSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { P } from './util.mjs'
import { isReservedMessage } from './notify.mjs'
import { runApi, apiKey } from './api.mjs'

export const MODES = ['codex', 'api']
export const MODE_LABEL = { codex: 'Codex', api: 'API' }
// 판단 방식: state/control.json의 brain(실행 중에 바꾼 것)이 있으면 그것, 없으면 config.json의 brain.
export function brainMode(cfg, control) {
	const m = control?.brain ?? cfg.brain
	return MODES.includes(m) ? m : 'codex'
}
// 고른 방식의 모델·추론 노력·제한 시간. api 쪽에 적지 않은(null) 값은 codex 값을 그대로 쓴다.
const SHARED = ['model', 'fallback_model', 'effort', 'effort_hourly', 'effort_deep', 'timeout_seconds', 'timeout_deep_seconds']
export function brainSettings(cfg, mode) {
	const out = Object.fromEntries(SHARED.map(k => [k, mode === 'api' ? cfg.api[k] ?? cfg.codex[k] : cfg.codex[k]]))
	out.effort_hourly = mode === 'api'
		? (cfg.api.effort_hourly ?? cfg.api.effort ?? cfg.codex.effort_hourly ?? cfg.codex.effort)
		: (cfg.codex.effort_hourly ?? cfg.codex.effort)
	return out
}
export const runBrain = ({ mode, ...args }) => (mode === 'api' ? runApi(args) : runCodex(args))

function which(bin) {
	if (bin.includes('/')) return existsSync(bin) ? bin : null
	const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.npm-global', 'bin'), join(homedir(), '.local', 'bin')].filter(Boolean)
	for (const d of dirs) {
		const p = join(d, bin)
		if (existsSync(p)) return p
	}
	return null
}

// 격리 실행 도우미(codex-linux-sandbox)가 Codex 실행 파일을 가리키므로 그 폴더는 읽기를 허용해야 한다.
export function codexVendorDir(cfg) {
	if (cfg.codex.vendor_dir) return cfg.codex.vendor_dir
	const bin = which(cfg.codex.bin)
	if (!bin) throw new Error('codex 실행 파일을 찾지 못함 (PATH 확인)')
	const pkg = dirname(dirname(realpathSync(bin)))
	const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
	const v = join(pkg, 'node_modules', '@openai', `codex-linux-${arch}`, 'vendor')
	if (!existsSync(v)) throw new Error(`codex vendor 폴더 없음: ${v}`)
	return v
}

// 데몬을 시작할 때(또는 방식을 바꿀 때) Codex나 API를 실제로 부르지 않고 확인할 수 있는 것만 본다.
export function selfCheck(cfg, mode = 'codex') {
	try {
		if (mode === 'api') apiKey(cfg)
		else codexVendorDir(cfg)
		for (const f of [P.guide, P.schema]) if (!existsSync(f)) throw new Error(`파일 없음: ${f}`)
		JSON.parse(readFileSync(P.schema, 'utf8'))
		return null
	} catch (e) { return e.message }
}

const tomlTable = obj => '{' + Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(', ') + '}'

export function codexArgs({ cfg, effort, outFile, vendorDir, model = cfg.codex.model, brainDir = P.brain, schema = P.schema }) {
	const fs = {
		':root': 'deny',
		':minimal': 'read',
		[brainDir]: 'read',
		[join(homedir(), '.codex', 'tmp', 'arg0-linux')]: 'read',
		[vendorDir]: 'read',
	}
	return [
		'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
		'-C', brainDir,
		'-m', model,
		'-c', `model_reasoning_effort="${effort}"`,
		'-c', 'approval_policy="never"',
		'-c', 'web_search="disabled"',
		'--disable', 'memories',
		'-c', 'default_permissions="haagent"',
		'-c', `permissions.haagent.filesystem=${tomlTable(fs)}`,
		'-c', 'permissions.haagent.network={enabled=false}',
		'--output-schema', schema,
		'-o', outFile,
		'-',
	]
}

// brainDir를 바꾸면(다시 돌려보기) 그 폴더에서만 읽는다. 답 파일은 <brainDir>/run/answer.json.
export function runCodex({ cfg, prompt, effort, timeoutSec, model, brainDir = P.brain, runDir = P.run, signal }) {
	const outFile = join(runDir, 'answer.json')
	rmSync(outFile, { force: true })
	const bin = which(cfg.codex.bin) ?? cfg.codex.bin
	const args = codexArgs({ cfg, effort, outFile, vendorDir: codexVendorDir(cfg), model: model ?? cfg.codex.model, brainDir })
	const started = Date.now()
	return new Promise((resolve, reject) => {
		// API 키가 환경 변수에 있어도 Codex(와 그 안의 셸)로는 넘기지 않는다.
		const { [cfg.api.key_env]: _key, ...env } = process.env
		const child = spawn(bin, args, { cwd: brainDir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
		let out = '', timedOut = false, aborted = false, killTimer = null
		const keep = d => { out += d; if (out.length > 40000) out = out.slice(-40000) }
		child.stdout.on('data', keep)
		child.stderr.on('data', keep)
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
		}, timeoutSec * 1000)
		const cleanup = () => {
			clearTimeout(timer)
			clearTimeout(killTimer)
			signal?.removeEventListener('abort', onAbort)
		}
		child.on('error', e => { cleanup(); reject(e) })
		child.on('close', (code, sig) => {
			cleanup()
			const ms = Date.now() - started
			const tokens = Number((/tokens used\s*([\d,]+)/i.exec(out)?.[1] ?? '').replace(/,/g, '')) || null
			const tail = out.slice(-400).replace(/\s+/g, ' ')
			if (timedOut) return reject(new Error(`codex 시간 초과 (${timeoutSec}초)`))
			if (aborted) return reject(signal?.reason instanceof Error ? signal.reason : new Error('codex 중단됨'))
			if (code !== 0) return reject(new Error(`codex 종료 코드 ${code}${sig ? ` (${sig})` : ''} (${Math.round(ms / 1000)}초): ${tail}`))
			try {
				resolve({ result: JSON.parse(readFileSync(outFile, 'utf8')), ms, tokens })
			} catch (e) {
				reject(new Error(`codex 답을 읽지 못함: ${e.message}; ${tail}`))
			}
		})
		child.stdin.on('error', () => {})
		child.stdin.end(prompt)
	})
}

const INFO_MAX_HOURS = { history: 168, statistics: 2160, logbook: 72 }

// 스키마로 강제되지만 한 번 더 검사하고 길이를 자른다.
export function validateResponse(x) {
	if (!x || typeof x !== 'object') throw new Error('응답이 객체가 아님')
	const arr = v => (Array.isArray(v) ? v : [])
	const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
	const ids = v => arr(v).filter(s => typeof s === 'string')
	return {
		summary: str(x.summary, 1000),
		notifications: arr(x.notifications).slice(0, 5).map(n => ({
			kind: ['alert', 'info', 'hourly_summary'].includes(n?.kind) ? n.kind : 'info',
			level: ['urgent', 'normal', 'quiet'].includes(n?.level) ? n.level : 'normal',
			title: str(n?.title, 60),
			message: str(n?.message, 500),
			related_rule_ids: ids(n?.related_rule_ids).slice(0, 5),
			// 휴대폰 앱이 명령으로 알아듣는 문구(remove_channel, command_* 등)는 알림으로 보내지 않는다.
		})).filter(n => n.title && n.message && !isReservedMessage(n.message)),
		rule_changes: {
			upsert: arr(x.rule_changes?.upsert).slice(0, 30),
			delete: ids(x.rule_changes?.delete).slice(0, 60),
		},
		next_wakes: arr(x.next_wakes).slice(0, 6).map(w => ({ at: str(w?.at, 40), reason: str(w?.reason, 200) })).filter(w => w.at && w.reason),
		memory: {
			mode: ['keep', 'append', 'replace'].includes(x.memory?.mode) ? x.memory.mode : 'keep',
			text: str(x.memory?.text, 8000),
		},
		// 주간 분석 보고서(마크다운). 주간 분석이 아닐 때는 빈 문자열.
		report: str(x.report, 20000),
		info_requests: arr(x.info_requests).slice(0, 3).map(r => {
			const kind = ['history', 'statistics', 'logbook'].includes(r?.kind) ? r.kind : 'history'
			return {
				kind,
				entity_ids: ids(r?.entity_ids).slice(0, 6),
				hours: Math.min(Math.max(Math.round(Number(r?.hours)) || 24, 1), INFO_MAX_HOURS[kind]),
			}
		}).filter(r => r.entity_ids.length),
		actions: arr(x.actions).slice(0, 5).map(a => ({
			entity_id: str(a?.entity_id, 120),
			action: ['turn_on', 'turn_off'].includes(a?.action) ? a.action : '',
			reason: str(a?.reason, 200),
			// 사용자가 이번 말에서 직접 시킨 행동인가(그러면 승인을 다시 묻지 않는다)
			requested: a?.requested === true,
		})).filter(a => a.entity_id && a.action && a.reason),
	}
}
