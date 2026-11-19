// 기록 관리: 판단 원문 보관(다시 돌려보기용), 규칙·메모 이전 판, 하루 요약, 주간 분석 보고서, 주간 지표, 기록 파일 정리
import { mkdirSync, writeFileSync, readdirSync, rmSync, cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { P, DAY, kst, readJson, writeJson, readJsonlAll, rotateIfBig, latestBy } from './util.mjs'

const stamp = ms => kst(new Date(ms)).iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
const list = dir => { try { return readdirSync(dir).sort() } catch { return [] } }
function prune(dir, keep, match = () => true) {
	const names = list(dir).filter(match)
	for (const n of names.slice(0, Math.max(0, names.length - keep))) rmSync(join(dir, n), { recursive: true, force: true })
}

// ── 판단 원문: 프롬프트 재료(input.json), 프롬프트, 답, 그때의 참고 파일 ──
export function archiveRun({ started, reasons, input, rounds, keep }) {
	const dir = join(P.runs, `${stamp(started)}-${reasons.map(r => r.type).join('+').slice(0, 40)}`)
	mkdirSync(dir, { recursive: true })
	// input은 본체가 판단 직전에 문자열로 굳혀 둔 것이다(다시 감싸면 replay가 읽지 못한다).
	writeFileSync(join(dir, 'input.json'), typeof input === 'string' ? input : JSON.stringify(input))
	rounds.forEach((r, i) => {
		writeFileSync(join(dir, `prompt-${i + 1}.md`), r.prompt)
		writeFileSync(join(dir, `answer-${i + 1}.json`), JSON.stringify(r.answer, null, 1))
	})
	// 자동화 설정 원문은 크고 잘 안 바뀌므로 빼고 보관한다.
	if (existsSync(P.run)) cpSync(P.run, join(dir, 'files'), { recursive: true, filter: src => !/(automation-configs|answer)\.json$/.test(src) })
	prune(P.runs, keep)
	return dir
}
export const listRuns = () => list(P.runs)

// ── 규칙·메모 이전 판 ──
export function snapshot(kind, content, at, keep) {
	if (content == null || content === '') return null
	const ext = kind === 'rules' ? 'json' : 'md'
	mkdirSync(P.history, { recursive: true })
	const name = `${kind}-${stamp(at)}.${ext}`
	writeFileSync(join(P.history, name), kind === 'rules' ? JSON.stringify(content, null, 1) : content)
	prune(P.history, keep, n => n.startsWith(`${kind}-`))
	return name
}
export const listSnapshots = () => list(P.history)
export function readSnapshot(name) {
	if (!/^(rules|memory)-[\d-]+\.(json|md)$/.test(name)) throw new Error('이전 판 파일 이름이 아님')
	const text = readFileSync(join(P.history, name), 'utf8')
	return name.startsWith('rules-') ? { kind: 'rules', content: JSON.parse(text) } : { kind: 'memory', content: text }
}

// ── 하루 요약: 엔티티별 변화 횟수·처음/마지막 시각·켜져 있던 시간 ──
const ACTIVE = new Set([
	'on', 'open', 'unlocked', 'home', 'playing', 'heat', 'cool', 'heating', 'cooling', 'cleaning', 'detected',
	'running', 'washing', 'rinsing', 'spinning', 'drying', 'prewash', 'steam_softening', 'refreshing',
	'auto', 'dry', 'fan_only', 'heat_cool',
])

export function dailyDigest(date, events, until = Infinity) {
	const start = Date.parse(`${date}T00:00:00+09:00`), end = Math.min(start + DAY, until)
	const by = new Map()
	for (const e of events) {
		if (e.t < start || e.t >= end) continue
		if (!by.has(e.id)) by.set(e.id, [])
		by.get(e.id).push(e)
	}
	const out = {}
	for (const [id, evs] of by) {
		evs.sort((a, b) => a.t - b.t)
		let active = 0, prevT = start, prevS = evs[0].from
		for (const e of evs) {
			if (ACTIVE.has(prevS)) active += e.t - prevT
			prevT = e.t
			prevS = e.to
		}
		if (ACTIVE.has(prevS)) active += end - prevT
		out[id] = { name: evs[0].name, changes: evs.length, first: kst(new Date(evs[0].t)).hm, last: kst(new Date(evs.at(-1).t)).hm, active_min: Math.round(active / 60000) }
	}
	return out
}

const inDay = (ts, date) => kst(new Date(ts)).date === date

// 날짜가 바뀔 때 전날 것을 state/daily/에 남긴다.
export function writeDaily(date, keepDays = 60) {
	const notes = latestBy(readJsonlAll(P.notifications), 'nid').filter(n => inDay(n.ts, date))
	const fb = readJsonlAll(P.feedback).filter(f => inDay(f.ts, date))
	const dec = readJsonlAll(P.decisions).filter(d => inDay(d.ts, date))
	const acts = latestBy(readJsonlAll(P.actions), 'aid').filter(a => inDay(a.ts, date))
	const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m }, {})
	const doc = {
		date, weekday: kst(new Date(`${date}T12:00:00+09:00`)).wd,
		runs: dec.filter(d => !d.skipped && !d.deferred).length, failed: dec.filter(d => d.error).length, tokens: dec.reduce((s, d) => s + (d.tokens ?? 0), 0),
		notifications: count(notes, n => `${n.kind}/${n.status}`),
		feedback: count(fb, f => f.kind),
		actions: count(acts, a => a.status),
		entities: dailyDigest(date, readJsonlAll(P.events)),
	}
	writeJson(join(P.daily, `${date}.json`), doc)
	prune(P.daily, keepDays)
	return doc
}
export const recentDaily = (days = 14) => list(P.daily).slice(-days).map(n => readJson(join(P.daily, n), null)).filter(Boolean)

// ── 주간 분석 보고서: state/weekly/YYYY-MM-DD.md ──
export const listWeekly = () => list(P.weekly).filter(n => /^\d{4}-\d\d-\d\d\.md$/.test(n))
export function saveWeekly(date, text, keep) {
	mkdirSync(P.weekly, { recursive: true })
	const name = `${date}.md`
	writeFileSync(join(P.weekly, name), text.trim() + '\n')
	prune(P.weekly, keep)
	return name
}
// name이 없으면 가장 최근 것. 없으면 null.
export function readWeekly(name = listWeekly().at(-1)) {
	if (!name || !/^\d{4}-\d\d-\d\d\.md$/.test(name)) return null
	try { return { name, text: readFileSync(join(P.weekly, name), 'utf8') } } catch { return null }
}

// ── 지난 7일 지표(하루 돌아보기 때 보여준다) ──
export function weekMetrics(now) {
	const since = now - 7 * DAY
	const recent = arr => arr.filter(x => Date.parse(x.ts) >= since)
	const dec = recent(readJsonlAll(P.decisions))
	const notes = recent(latestBy(readJsonlAll(P.notifications), 'nid')).filter(n => n.status === 'sent')
	const fb = recent(readJsonlAll(P.feedback))
	const acts = recent(latestBy(readJsonlAll(P.actions), 'aid'))
	const n = (arr, f) => arr.filter(f).length
	return {
		runs: n(dec, d => !d.skipped && !d.deferred), failed: n(dec, d => d.error), skipped_hourly: n(dec, d => d.skipped), deferred_disconnected: n(dec, d => d.deferred),
		tokens: dec.reduce((s, d) => s + (d.tokens ?? 0), 0),
		sent_alerts: n(notes, x => x.kind === 'alert'), sent_infos: n(notes, x => x.kind === 'info'), sent_summaries: n(notes, x => x.kind === 'hourly_summary'),
		// summary_less: 정각 요약의 [줄여 줘]. 요약에는 [도움됐어요]가 없으니 누르지 않은 것을 좋다는 뜻으로 읽지 않는다.
		feedback_up: n(fb, f => f.kind === 'up'), feedback_mute: n(fb, f => f.kind === 'mute'), summary_less: n(fb, f => f.kind === 'less'), replies: n(fb, f => f.kind === 'reply'),
		rule_wakes: dec.reduce((s, d) => s + (d.reasons ?? []).filter(r => r.startsWith('rule:')).length, 0),
		actions_done: n(acts, a => a.status === 'done'), actions_declined: n(acts, a => a.status === 'declined'), actions_undone: n(acts, a => a.status === 'undone'),
	}
}

// ── 기간별 운영 통계 (cli.mjs stats) ──
export function rangeStats(days = 7, now = Date.now()) {
	const since = now - days * DAY
	const recent = arr => arr.filter(x => Date.parse(x.ts) >= since)
	const dec = recent(readJsonlAll(P.decisions))
	const notes = recent(latestBy(readJsonlAll(P.notifications), 'nid'))
	const fb = recent(readJsonlAll(P.feedback))
	const acts = recent(latestBy(readJsonlAll(P.actions), 'aid'))
	const real = dec.filter(d => !d.skipped && !d.deferred)
	const okRuns = real.filter(d => !d.error)
	const noop = okRuns.filter(d => {
		const a = d.applied
		return !(a?.notifications?.length || a?.actions?.length || a?.added?.length || a?.changed?.length || a?.deleted?.length || a?.report)
	})
	const tokens = dec.reduce((s, d) => s + (d.tokens ?? 0), 0)
	const byBrain = {}, byReason = {}
	const usage = { input: 0, cached: 0, output: 0, reasoning: 0 }
	for (const d of real) {
		const bm = d.brain ?? 'codex'
		const b = (byBrain[bm] ??= { runs: 0, errors: 0, tokens: 0 })
		b.runs++
		if (d.error) b.errors++
		b.tokens += d.tokens ?? 0
		const rk = (d.reasons ?? []).map(r => r.split(':')[0]).join('+') || 'unknown'
		const r = (byReason[rk] ??= { runs: 0, tokens: 0, noop: 0 })
		r.runs++
		r.tokens += d.tokens ?? 0
		if (noop.includes(d)) r.noop++
		if (d.usage) {
			usage.input += d.usage.input ?? 0
			usage.cached += d.usage.cached ?? 0
			usage.output += d.usage.output ?? 0
			usage.reasoning += d.usage.reasoning ?? 0
		}
	}
	const hasUsage = usage.input || usage.cached || usage.output || usage.reasoning
	const sent = notes.filter(n => n.status === 'sent')
	const n = (arr, f) => arr.filter(f).length
	return {
		days,
		total: dec.length,
		real: real.length,
		skipped: n(dec, d => d.skipped),
		deferred: n(dec, d => d.deferred),
		errors: n(real, d => d.error),
		noop: noop.length,
		noop_pct: okRuns.length ? Math.round((noop.length / okRuns.length) * 1000) / 10 : 0,
		tokens,
		avg_tokens: okRuns.length ? Math.round(tokens / okRuns.length) : 0,
		usage: hasUsage ? usage : null,
		by_brain: byBrain,
		by_reason: byReason,
		notifications: {
			sent_alerts: n(sent, x => x.kind === 'alert'),
			sent_infos: n(sent, x => x.kind === 'info'),
			sent_summaries: n(sent, x => x.kind === 'hourly_summary'),
			other: n(notes, x => x.status !== 'sent'),
		},
		feedback: { up: n(fb, f => f.kind === 'up'), mute: n(fb, f => f.kind === 'mute'), less: n(fb, f => f.kind === 'less'), reply: n(fb, f => f.kind === 'reply') },
		actions: { done: n(acts, a => a.status === 'done'), declined: n(acts, a => a.status === 'declined'), undone: n(acts, a => a.status === 'undone'), error: n(acts, a => a.status === 'error') },
	}
}

// ── 날짜가 바뀔 때: 커진 기록 파일을 한 세대만 남기고 새로 시작 ──
export function rotateLogs() {
	const MB = 1024 * 1024
	for (const [p, max] of [[P.events, 5 * MB], [P.decisions, 5 * MB], [P.notifications, 2 * MB], [P.feedback, 2 * MB], [P.actions, 2 * MB]]) rotateIfBig(p, max)
}
