// 공용 도우미: 경로, JSON 저장, KST 시각 표시
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 시험에서는 HAAGENT_DATA_DIR로 상태·기록·실행 자료 위치를 바꾼다(실제 state/를 건드리지 않게).
const DATA = process.env.HAAGENT_DATA_DIR || ROOT
const S = join(DATA, 'state')
const BRAIN = join(ROOT, 'brain')
export const P = {
	config: join(ROOT, 'config.json'),
	state: S,
	rules: join(S, 'rules.json'),
	runtime: join(S, 'runtime.json'),
	schedule: join(S, 'schedule.json'),
	memory: join(S, 'memory.md'),
	homeProfile: join(S, 'home-profile.md'),
	db: join(S, 'ha-agent.db'),
	haSnapshots: join(S, 'ha-snapshots'),
	notifications: join(S, 'notifications.jsonl'),
	feedback: join(S, 'feedback.jsonl'),
	counters: join(S, 'counters.json'),
	held: join(S, 'held.json'),
	rejected: join(S, 'rejected.json'),
	control: join(S, 'control.json'),
	queue: join(S, 'queue.json'),
	outbox: join(S, 'outbox.json'),
	actions: join(S, 'actions.jsonl'),
	events: join(S, 'events.jsonl'),
	history: join(S, 'history'),
	daily: join(S, 'daily'),
	weekly: join(S, 'weekly'),
	inbox: join(S, 'inbox'),
	sttFailures: join(S, 'stt-failures'),
	pid: join(S, 'daemon.pid'),
	decisions: join(DATA, 'logs', 'decisions.jsonl'),
	runs: join(DATA, 'logs', 'runs'),
	replay: join(DATA, 'replay'),
	brain: BRAIN,
	run: DATA === ROOT ? join(BRAIN, 'run') : join(DATA, 'brain', 'run'),
	guide: join(BRAIN, 'GUIDE.md'),
	schema: join(BRAIN, 'response.schema.json'),
}

export const DAY = 86400000
export const expandHome = p => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

export function readEnvFile(filePath) {
	let text = ''
	try { text = readFileSync(expandHome(filePath), 'utf8') } catch { return {} }
	const out = {}
	for (const line of text.split('\n')) {
		const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line)
		if (m && m[2] !== undefined) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
	}
	return out
}

export function readJson(path, fallback) {
	try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
export function writeJson(path, data) {
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.${newId()}.tmp`
	writeFileSync(tmp, JSON.stringify(data, null, 1))
	renameSync(tmp, path)
}
export function appendJsonl(path, obj) {
	mkdirSync(dirname(path), { recursive: true })
	appendFileSync(path, JSON.stringify(obj) + '\n')
}
export function readJsonl(path) {
	let text = ''
	try { text = readFileSync(path, 'utf8') } catch { return [] }
	return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
// 로그 로테이션 직후에도 직전 세대(.1) 기록까지 이어서 읽는다.
export const readJsonlAll = path => [...readJsonl(`${path}.1`), ...readJsonl(path)]

const JSONL_CACHE = new Map()
function jsonlStatSig(p) {
	try { const s = statSync(p); return `${s.mtimeMs}:${s.size}` } catch { return '-' }
}
// mtime·size가 변하지 않았으면 이전 파싱 결과를 재사용해 15초 tick/판단마다 전체 파일을 다시 읽지 않는다.
export function readJsonlCached(path) {
	const sig = `${jsonlStatSig(`${path}.1`)}|${jsonlStatSig(path)}`
	const hit = JSONL_CACHE.get(path)
	if (hit && hit.sig === sig) return [...hit.rows]
	const rows = readJsonlAll(path)
	if (JSONL_CACHE.size >= 32) JSONL_CACHE.delete(JSONL_CACHE.keys().next().value)
	JSONL_CACHE.set(path, { sig, rows })
	return [...rows]
}
// 같은 key의 줄이 여러 번 있으면(상태가 바뀔 때마다 덧붙임) 마지막 것만 남긴다. 순서는 처음 나온 자리.
export function latestBy(list, key) {
	const m = new Map()
	for (const x of list) m.set(x[key], x)
	return [...m.values()]
}
// 기록 파일이 커지면 한 세대(.1)만 남기고 새로 시작한다.
export function rotateIfBig(path, maxBytes) {
	try {
		if (statSync(path).size <= maxBytes) return false
		renameSync(path, `${path}.1`)
		return true
	} catch { return false }
}

const KST_FMT = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
	hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
})
const WEEKDAY = { Sun: '일', Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토' }
export function kst(date = new Date()) {
	const o = Object.fromEntries(KST_FMT.formatToParts(date).map(p => [p.type, p.value]))
	return {
		h: +o.hour, mi: +o.minute,
		date: `${o.year}-${o.month}-${o.day}`,
		hm: `${o.hour}:${o.minute}`,
		wd: WEEKDAY[o.weekday] ?? o.weekday,
		iso: `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}+09:00`,
	}
}
// 엔티티 id 목록(별표 와일드카드 가능)에 드는지 보는 함수를 만든다. 예: ['sensor.seoul_*', 'binary_sensor.x']
export function globs(patterns = []) {
	const res = (Array.isArray(patterns) ? patterns : []).filter(p => typeof p === 'string' && p)
		.map(p => new RegExp(`^${p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`))
	return id => res.some(r => r.test(id))
}
// "2026-11-11 15:20" (KST)
export const fmt = ms => (ms == null || !Number.isFinite(ms) ? null : kst(new Date(ms)).iso.slice(0, 16).replace('T', ' '))

// "18분 뒤", "5시간 48분 전", "3일 전"
export function relText(ms, now = Date.now()) {
	const diff = Math.round((ms - now) / 60000)
	if (diff === 0) return '지금'
	const a = Math.abs(diff)
	const d = Math.floor(a / 1440), h = Math.floor((a % 1440) / 60), m = a % 60
	const span = d >= 2 ? `${d}일` : d ? (h ? `1일 ${h}시간` : '1일') : h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`
	return `${span} ${diff > 0 ? '뒤' : '전'}`
}

// HA가 주는 시각 문자열을 KST로 바꾼다. 시간대가 붙은 ISO(UTC "2026-11-20T18:09:41+00:00" 등)와
// 시간대 없는 HA 현지 시각(input_datetime "2026-11-20 20:47:01")을 다룬다. 시각이 아니면 그대로 돌려준다.
// LLM이 UTC 값을 KST 현재 시각과 날짜만 보고 비교해 "이미 지난 시각"으로 잘못 읽는 일을 막는다.
// rel=true면 지금 기준 몇 분 전/뒤인지 덧붙인다(기록 행처럼 지금과 비교할 뜻이 없는 값에는 false).
const TS_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/
export function localTime(v, now = Date.now(), rel = true) {
	if (typeof v !== 'string' || v.length > 40) return v
	const m = TS_RE.exec(v)
	if (!m) return v
	const zone = !m[3] ? '+09:00' : m[3] === 'Z' ? 'Z' : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2')
	const ms = Date.parse(`${m[1]}T${m[2]}${zone}`)
	if (!Number.isFinite(ms)) return v
	return rel ? `${fmt(ms)} KST (${relText(ms, now)})` : `${fmt(ms)} KST`
}

// 객체·배열 안의 시각 문자열을 모두 localTime으로 바꾼다(엔티티 속성용).
export function localizeDeep(v, now = Date.now(), depth = 0) {
	if (typeof v === 'string') return localTime(v, now)
	if (v == null || typeof v !== 'object' || depth > 4) return v
	if (Array.isArray(v)) return v.map(x => localizeDeep(x, now, depth + 1))
	return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, localizeDeep(x, now, depth + 1)]))
}
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
export const log = (...a) => console.log(`[${fmt(Date.now())}]`, ...a)
