// 생활 루틴 → HA 자동화 제안 파이프라인(결정론적, LLM 없음).
// 1) 루틴 분석기(mineRoutines)가 찾은 "같은 요일 유형·같은 시간대에 반복된 켜기/끄기"를 후보로 삼는다.
// 2) 그 조작을 사람이 했는지 확인한다(상태 변화의 조작 주체 기록, 없으면 HA logbook). 이미 자동화가 한 일이면 버린다.
// 3) 그 기기를 이미 움직이는 자동화가 있으면 버린다(중복 자동화 방지).
// 4) "정해진 시각" 트리거와 "귀가" 트리거를 각각 지난 기록으로 백테스트해 더 잘 맞는 쪽을 고른다.
// 5) 기준(맞은 날 수·정확도·재현율)을 넘으면 근거를 붙여 Tier 2 승인 제안(automation_upsert)으로 올린다.
import { DAY, kst } from '../util.mjs'
import { mineRoutines } from './learning.mjs'
import { HUMAN_ORIGINS, logbookOrigin } from './origin.mjs'

const MIN = 60000
// 제안할 수 있는 도메인과 방향. TV를 자동으로 켜는 것처럼 놀랄 만한 동작은 제안하지 않는다(미디어는 끄기만).
const SUGGEST_DIRECTIONS = { light: ['on', 'off'], switch: ['on', 'off'], fan: ['on', 'off'], input_boolean: ['on', 'off'], media_player: ['off'] }
const ON_STATES = new Set(['on', 'playing', 'paused', 'idle', 'open', 'buffering'])
const DEAD = new Set(['unavailable', 'unknown'])
export const SUGGEST_DEFAULTS = {
	lookback_days: 28, // 볼 기간
	min_days: 4, // 사람이 그 조작을 한 날이 이만큼은 있어야 한다
	min_consistency: 60, // 그 요일 유형 날 중 이 비율(%) 이상
	min_human_share: 0.6, // 주체를 아는 조작 중 사람이 한 비율
	min_agree: 3, // 백테스트에서 자동화가 사람과 같은 일을 했을 날
	min_precision: 0.6, // 자동화가 실행된 날 중 사람이 원했던 날의 비율
	min_recall: 0.5, // 사람이 원했던 날 중 자동화가 실행됐을 날의 비율
	max_new: 2, // 한 번에 새로 올릴 제안 수
}

const isOn = s => ON_STATES.has(String(s))
const hm = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(Math.round(((m % 60) + 60) % 60)).padStart(2, '0')}`
const parseHm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m }
const kstMidnight = date => Date.parse(`${date}T00:00:00+09:00`)
const minOfDay = t => { const k = kst(new Date(t)); return k.h * 60 + k.mi }
const toMs = v => (typeof v === 'number' ? v : Date.parse(v))
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const josaObj = w => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '을' : '를' }

export function routineConfigId(entityId, direction, dayType) {
	return `haagent_routine_${slug(entityId)}_${direction}_${dayType === 'workday' ? 'wd' : 'we'}`.slice(0, 80)
}

function dayTypeResolver(events) {
	const byDate = new Map()
	for (const e of events) if (/workday_sensor/.test(e.id) && (e.to === 'on' || e.to === 'off')) byDate.set(kst(new Date(e.t)).date, e.to === 'on' ? 'workday' : 'holiday_weekend')
	return date => byDate.get(date) ?? (['토', '일'].includes(kst(new Date(kstMidnight(date) + 12 * 3600000)).wd) ? 'holiday_weekend' : 'workday')
}

function timelines(events) {
	const m = new Map()
	for (const e of events) { if (!m.has(e.id)) m.set(e.id, []); m.get(e.id).push(e) }
	return m
}

function stateAt(tl, id, t, fallback = null) {
	const list = tl.get(id)
	if (!list?.length) return fallback
	let last = null
	for (const e of list) { if (e.t <= t) last = e; else break }
	return last ? last.to : (list[0].from ?? fallback)
}

const directionOf = e => (e.to === 'on' && !isOn(e.from) ? 'on' : (e.to === 'off' && isOn(e.from)) ? 'off' : null)

// 이 엔티티를 동작(actions)에서 움직이는 기존 자동화 이름들
export function automationsTouching(autoCfg, entityId) {
	const hits = []
	for (const [aid, c] of Object.entries(autoCfg ?? {})) {
		if (!c) continue
		if (JSON.stringify(c.actions ?? c.action ?? []).includes(`"${entityId}"`)) hits.push(c.alias ?? aid)
	}
	return hits
}

// 날짜별 첫 조작(그 요일 유형, 시간대 ±30분)과 그 조작 주체
function occurrencesOf({ tl, entityId, direction, dayType, dayTypeOf, winStart, winEnd, logbook, agentActs }) {
	const out = new Map()
	for (const e of tl.get(entityId) ?? []) {
		if (directionOf(e) !== direction) continue
		const date = kst(new Date(e.t)).date
		if (dayTypeOf(date) !== dayType || out.has(date)) continue
		const m = minOfDay(e.t)
		if (m < winStart - 30 || m > winEnd + 30) continue
		let who = 'unknown'
		if (e.origin) who = HUMAN_ORIGINS.has(e.origin) ? 'human' : e.origin
		else if (agentActs.some(a => a.entity_id === entityId && Math.abs(toMs(a.done_at ?? a.ts) - e.t) <= 20000)) who = 'agent'
		else {
			const row = logbook.find(r => r.entity_id === entityId && Math.abs(Number(r.when) * 1000 - e.t) <= 5000 && String(r.state) === String(e.to))
			if (row) { const o = logbookOrigin(row); who = o === 'user' || o === 'device' ? 'human' : o }
		}
		out.set(date, { t: e.t, min: m, who })
	}
	return out
}

// 자동화가 있었다고 치고 날마다 따져 본다.
// agree: 자동화가 실행됐을 날 = 사람이 실제로 그 일을 한 날, unwanted: 실행됐는데 사람은 안 했고 기기를 실제로 바꿨을 날, missed: 사람은 했는데 실행 안 됐을 날
function backtest({ trigger, dates, occ, tl, entityId, direction, timeMin, winStart, winEnd, arrivals, persons, states }) {
	let agree = 0, unwanted = 0, missed = 0
	const someoneHome = t => !persons.length || persons.some(p => stateAt(tl, p, t, states.get(p)?.state) === 'home')
	for (const date of dates) {
		const o = occ.get(date)
		const wanted = Boolean(o && (o.who === 'human' || o.who === 'unknown'))
		let fireAt = null
		if (trigger === 'time') {
			const t = kstMidnight(date) + timeMin * MIN
			if (someoneHome(t)) fireAt = t
		} else {
			const a = arrivals.find(x => kst(new Date(x.t)).date === date && x.min >= winStart - 30 && x.min <= winEnd + 60)
			if (a) fireAt = a.t
		}
		if (fireAt != null && wanted) agree++
		else if (fireAt != null) {
			const cur = stateAt(tl, entityId, fireAt - 1000, states.get(entityId)?.state)
			if (direction === 'on' ? !isOn(cur) : isOn(cur)) unwanted++
		} else if (wanted) missed++
	}
	const fired = agree + unwanted
	const precision = fired ? agree / fired : 0
	const recall = agree + missed ? agree / (agree + missed) : 0
	const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
	return { trigger, agree, unwanted, missed, precision: Math.round(precision * 100) / 100, recall: Math.round(recall * 100) / 100, f1 }
}

export function buildRoutineAutomation({ configId, entityId, name, direction, dayType, trigger, timeMin, winStart, winEnd, persons, states, evidenceText }) {
	const domain = entityId.split('.')[0]
	const workday = [...states.keys()].find(id => /^binary_sensor\..*workday/.test(id))
	const dayCond = workday
		? { condition: 'state', entity_id: workday, state: dayType === 'workday' ? 'on' : 'off' }
		: { condition: 'time', weekday: dayType === 'workday' ? ['mon', 'tue', 'wed', 'thu', 'fri'] : ['sat', 'sun'] }
	const presence = states.has('zone.home')
		? { condition: 'numeric_state', entity_id: 'zone.home', above: 0 }
		: persons.length === 1 ? { condition: 'state', entity_id: persons[0], state: 'home' } : null
	const dayLabel = dayType === 'workday' ? '평일' : '주말·휴일'
	const verb = direction === 'on' ? '켜기' : '끄기'
	const when = trigger === 'arrival' ? `귀가 시(${hm(winStart - 30)}~${hm(winEnd + 60)})` : `${hm(timeMin)}`
	return {
		id: configId,
		alias: `[집 비서] ${dayLabel} ${when} ${name} ${verb}`,
		description: `집 비서가 생활 기록으로 제안한 자동화. ${evidenceText}`.slice(0, 480),
		mode: 'single',
		triggers: trigger === 'arrival'
			? [{ trigger: 'state', entity_id: persons.length === 1 ? persons[0] : persons, to: 'home' }]
			: [{ trigger: 'time', at: `${hm(timeMin)}:00` }],
		conditions: [
			dayCond,
			...(trigger === 'arrival' ? [{ condition: 'time', after: `${hm(winStart - 30)}:00`, before: `${hm(winEnd + 60)}:00` }] : presence ? [presence] : []),
			{ condition: 'state', entity_id: entityId, state: direction === 'on' ? 'off' : (domain === 'media_player' ? ['on', 'playing', 'paused', 'idle'] : 'on') },
		],
		actions: [{ action: `${domain}.turn_${direction}`, target: { entity_id: entityId } }],
	}
}

// 후보를 평가하고(dry면 여기까지) 기준을 넘는 것을 제안으로 올린다. propose(req)는 agent.createAndNotifyProposal.
export async function suggestAutomations({
	store, ha = null, states, meta = {}, policy = null, cfg = {}, isNoise = () => false, proposals = [], propose = null,
	now = Date.now(), dry = true, options = {},
} = {}) {
	const o = { ...SUGGEST_DEFAULTS, ...(cfg.learning?.suggest ?? {}), ...options }
	if (!store || !states?.size) return { ok: false, error: '저장소·HA 상태가 없어 자동화 제안을 계산할 수 없다', candidates: [], created: [] }
	const since = now - o.lookback_days * DAY
	const events = store.eventsInRange(since, now)
	if (!events.length) return { ok: true, candidates: [], created: [] }
	const tl = timelines(events)
	const dayTypeOf = dayTypeResolver(events)
	const firstDate = kst(new Date(events[0].t)).date
	const today = kst(new Date(now)).date
	const persons = [...states.keys()].filter(id => id.startsWith('person.'))
	const arrivals = events.filter(e => e.id.startsWith('person.') && e.to === 'home' && e.from !== 'home' && !DEAD.has(e.from))
		.map(e => ({ t: e.t, min: minOfDay(e.t), id: e.id }))
	const agentActs = store.actionsInRange(since, now).filter(a => ['done', 'unverified'].includes(a.status))

	const routines = mineRoutines({ store, now, days: o.lookback_days, isNoise }).device_routines
		.filter(r => r.observed_days >= o.min_days && r.consistency_pct >= o.min_consistency && (SUGGEST_DIRECTIONS[r.entity_id.split('.')[0]] ?? []).includes(r.direction))

	// 사람 조작인지 확인할 logbook(녹화 보관 기간 안의 것만 있다). 실패해도 주체 기록·백테스트로 계속한다.
	let logbook = []
	const ids = [...new Set(routines.map(r => r.entity_id))]
	if (ha?.logbook && ids.length) {
		try { logbook = (await ha.logbook(ids, o.lookback_days * 24)) ?? [] } catch { logbook = [] }
	}

	const candidates = []
	const seenKeys = new Set()
	for (const r of routines) {
		const entityId = r.entity_id
		const key = `${entityId}|${r.direction}|${r.day_type}`
		if (seenKeys.has(key)) continue // 같은 기기·방향·요일 유형은 가장 일관된 시간대 하나만
		seenKeys.add(key)
		const [ws, we] = r.window.split('~')
		const winStart = parseHm(ws), winEnd = parseHm(we) === 0 ? 1440 : parseHm(we)
		const cand = { entity_id: entityId, name: r.name, direction: r.direction, day_type: r.day_type, window: r.window, observed_days: r.observed_days, consistency_pct: r.consistency_pct }
		candidates.push(cand)
		const skip = (reason, extra = {}) => Object.assign(cand, { status: 'skipped', reason, ...extra })

		if (!states.has(entityId)) { skip('entity_missing'); continue }
		if (policy?.isTier3Blocked?.(entityId)) { skip('tier3'); continue }
		const existing = automationsTouching(meta.autoCfg, entityId)
		if (existing.length) { skip('existing_automation', { automations: existing.slice(0, 3) }); continue }

		const occ = occurrencesOf({ tl, entityId, direction: r.direction, dayType: r.day_type, dayTypeOf, winStart, winEnd, logbook, agentActs })
		const who = { human: 0, automation: 0, agent: 0, unknown: 0 }
		for (const v of occ.values()) who[v.who] = (who[v.who] ?? 0) + 1
		const known = who.human + who.automation + who.agent
		cand.attribution = who
		if (known >= 2 && who.human / known < o.min_human_share) { skip('automation_driven'); continue }
		if (who.human + who.unknown < o.min_days) { skip('too_few_human_days'); continue }

		const dates = []
		for (let d = kstMidnight(firstDate); d <= kstMidnight(today) - DAY; d += DAY) {
			const date = kst(new Date(d + 12 * 3600000)).date
			if (dayTypeOf(date) === r.day_type) dates.push(date)
		}
		const humanMins = [...occ.values()].filter(v => v.who === 'human' || v.who === 'unknown').map(v => v.min).sort((a, b) => a - b)
		const timeMin = humanMins.length ? humanMins[Math.floor((humanMins.length - 1) / 2)] : parseHm(r.median_time)
		const common = { dates, occ, tl, entityId, direction: r.direction, timeMin, winStart, winEnd, arrivals, persons, states }
		const tests = [backtest({ ...common, trigger: 'time' })]
		if (r.direction === 'on' && persons.length && arrivals.length) tests.push(backtest({ ...common, trigger: 'arrival' }))
		tests.sort((a, b) => b.f1 - a.f1 || (a.trigger === 'arrival' ? -1 : 1))
		const best = tests[0]
		cand.backtest = tests
		cand.trigger = best.trigger
		cand.time = hm(timeMin)
		if (best.agree < o.min_agree || best.precision < o.min_precision || best.recall < o.min_recall) { skip('backtest_failed'); continue }

		const configId = routineConfigId(entityId, r.direction, r.day_type)
		cand.config_id = configId
		const prev = proposals.filter(p => p.payload?.config_id === configId)
		if (prev.some(p => p.status === 'rejected')) { skip('rejected_before'); continue }
		if (prev.some(p => ['pending', 'applying', 'applied', 'interrupted', 'rollback_failed'].includes(p.status))) { skip('already_proposed'); continue }
		if (prev.some(p => now - (p.decided_at ?? p.ts) < 14 * DAY)) { skip('recently_proposed'); continue }

		const dayLabel = r.day_type === 'workday' ? '평일' : '주말·휴일'
		const verbPast = r.direction === 'on' ? '켰어요' : '껐어요'
		const total = dates.length
		const evidenceText = `지난 ${total}일(${dayLabel}) 중 ${occ.size}일, ${r.window} 무렵 ${r.name}${josaObj(r.name)} 직접 ${verbPast}`
			+ ` (사람 조작 확인 ${who.human}회${who.unknown ? `, 주체 기록 없음 ${who.unknown}회` : ''}${who.automation + who.agent ? `, 자동화·집 비서 ${who.automation + who.agent}회` : ''}).`
			+ ` 이 자동화가 있었다면 ${best.agree + best.unwanted}일 실행됐고 그중 ${best.agree}일은 실제로 ${verbPast.replace('어요', '던')} 날과 맞았어요(정확도 ${Math.round(best.precision * 100)}%, 놓쳤을 날 ${best.missed}일).`
			+ ` 방식: ${best.trigger === 'arrival' ? '귀가하면 실행' : `${hm(timeMin)}에 집에 누가 있으면 실행`}, 이미 그 상태면 아무것도 하지 않음.`
		const config = buildRoutineAutomation({ configId, entityId, name: r.name, direction: r.direction, dayType: r.day_type, trigger: best.trigger, timeMin, winStart, winEnd, persons, states, evidenceText })
		cand.config = config
		cand.evidence = evidenceText
		cand.status = 'eligible'
	}

	const created = []
	if (!dry && propose) {
		for (const cand of candidates.filter(c => c.status === 'eligible').sort((a, b) => (b.backtest?.[0]?.f1 ?? 0) - (a.backtest?.[0]?.f1 ?? 0))) {
			if (created.length >= o.max_new) break
			const dayLabel = cand.day_type === 'workday' ? '평일' : '주말·휴일'
			const res = await propose({
				kind: 'automation_upsert',
				target_id: `automation.${cand.config_id}`,
				title: `생활 루틴 자동화: ${dayLabel} ${cand.trigger === 'arrival' ? '귀가 시' : cand.time} ${cand.name} ${cand.direction === 'on' ? '켜기' : '끄기'}`.slice(0, 80),
				summary: cand.evidence,
				payload: { config_id: cand.config_id, config: cand.config, source: 'routine_suggest' },
			})
			if (res?.ok) { cand.status = 'proposed'; cand.pid = res.proposal.pid; created.push(res.proposal) }
			else Object.assign(cand, { status: 'skipped', reason: 'proposal_rejected_by_validation', error: res?.error })
		}
	}
	return { ok: true, period_days: o.lookback_days, candidates, created }
}
