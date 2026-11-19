// 규칙 백테스트: AI가 만든 규칙을 지난 7일의 상태 기록에 돌려 보고 "그동안이면 몇 번 발동했을지"를 센다.
// 실제 판정과 같은 RuleEngine을 쓰므로 for_minutes·쿨다운·시간대·also가 똑같이 적용된다.
import { RuleEngine } from './rules.mjs'
import { DAY, fmt } from './util.mjs'

// 상태 기록만으로 다시 돌려 볼 수 있는 규칙인가. stale은 "보고 시각"이, 속성 조건은 속성 기록이 있어야 해서 뺀다.
export const backtestable = r => r.op !== 'stale' && !r.attribute && (r.also ?? []).every(c => !c.attribute)

// hist: HA history/history_during_period 결과({ 엔티티: [{ s, lu }] }, lu는 초). 기록이 없으면 null.
export function backtestRule(rule, hist, from, to, stepMs = 60000) {
	if (!backtestable(rule)) return null
	const ids = [...new Set([rule.entity_id, ...(rule.also ?? []).map(c => c.entity_id)])]
	const events = []
	for (const id of ids) {
		for (const x of hist?.[id] ?? []) {
			const t = Math.round(Number(x.lu ?? x.lc) * 1000)
			if (Number.isFinite(t) && typeof x.s === 'string') events.push({ t: Math.min(Math.max(t, from), to), id, s: x.s })
		}
	}
	if (!events.some(e => e.id === rule.entity_id)) return null
	events.sort((a, b) => a.t - b.t)
	const start = events[0].t
	const states = new Map()
	const put = e => {
		const prev = states.get(e.id), at = new Date(e.t).toISOString()
		const st = { entity_id: e.id, state: e.s, attributes: {}, last_changed: prev?.state === e.s ? prev.last_changed : at, last_updated: at }
		states.set(e.id, st)
		return st
	}
	// 구간이 시작될 때의 상태로 무장한다(그때 이미 참이던 것은 세지 않는다. 실제 규칙도 그렇다).
	let i = 0
	while (i < events.length && events[i].t === start) put(events[i++])
	const engine = new RuleEngine([rule], {})
	engine.initAll(states, start)
	let fires = 0, last = null, now = start
	const hit = (list, t) => { if (list.length) { fires += list.length; last = t } }
	const advance = until => { while (now + stepMs <= until) { now += stepMs; hit(engine.tick(states, now), now) } }
	for (; i < events.length; i++) {
		const e = events[i]
		advance(e.t)
		hit(engine.onState(e.id, put(e), e.t, states), e.t)
	}
	advance(to)
	return { fires, days: Math.round(((to - start) / DAY) * 10) / 10, last: fmt(last) }
}
