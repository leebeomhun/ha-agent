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

export function readJson(path, fallback) {
	try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
export function writeJson(path, data) {
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.tmp`
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
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
export const log = (...a) => console.log(`[${fmt(Date.now())}]`, ...a)
