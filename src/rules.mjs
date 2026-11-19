// 감시 규칙: AI가 만들고, 이 코드가 실시간으로 판정한다.
// 규칙은 조건이 거짓→참으로 바뀌어 for_minutes 동안 이어질 때 한 번 발동한다.
// 조건 = 주 엔티티 조건 + 함께 참이어야 하는 조건(also) + 시간대(hour_from~hour_to).
import { kst } from './util.mjs'

export const OPS = ['eq', 'ne', 'in', 'not_in', 'gt', 'lt', 'unavailable', 'stale', 'changes_gt', 'rise_gt', 'drop_gt', 'older_than']
export const ALSO_OPS = ['eq', 'ne', 'in', 'not_in', 'gt', 'lt', 'unavailable', 'older_than']
// for_minutes가 "지속 시간"이 아니라 "살펴보는 구간"인 op
const WINDOW_OPS = ['stale', 'changes_gt', 'rise_gt', 'drop_gt']
const NUM_OPS = ['gt', 'lt', 'changes_gt', 'rise_gt', 'drop_gt', 'older_than']
const ID_RE = /^[a-z0-9_]{3,48}$/
const ATTR_RE = /^[A-Za-z0-9_]{1,64}$/
const DEAD = new Set(['unavailable', 'unknown'])
const MAX_ALSO = 3
const readValue = (rule, st) => (rule.attribute ? st?.attributes?.[rule.attribute] : st?.state)
export const recentFires = (rt, now = Date.now()) => (rt?.fire_log ?? []).filter(t => now - t < 7 * 86400000)
// 시각을 값으로 갖는 엔티티(timestamp 센서, last_triggered 같은 속성)의 값을 ms로. 시각 모양이 아니면 NaN.
const tsOf = v => {
	if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(v)) return NaN
	const iso = v.replace(' ', 'T')
	return Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}+09:00`)
}

function checkCond(c, states, ops, e, label = '') {
	if (!states.has(c.entity_id)) e.push(`${label}없는 엔티티 ${c.entity_id}`)
	if (!ops.includes(c.op)) e.push(`${label}알 수 없는 op ${c.op}`)
	if (NUM_OPS.includes(c.op) && (c.value === null || c.value === '' || !Number.isFinite(Number(c.value)))) e.push(`${label}${c.op}는 숫자 value 필요 (gt/lt 등)`)
	if (['eq', 'ne', 'in', 'not_in'].includes(c.op) && (c.value === null || c.value === undefined || c.value === '')) e.push(`${label}${c.op}는 value 필요`)
	if (c.attribute != null && (typeof c.attribute !== 'string' || !ATTR_RE.test(c.attribute))) e.push(`${label}attribute 형식`)
	if (c.op === 'older_than') {
		if (!(Number(c.value) > 0)) e.push(`${label}older_than의 value는 0보다 큰 분 수`)
		const st = states.get(c.entity_id)
		const val = readValue(c, st)
		const allowNull = c.attribute === 'last_triggered' && val == null
		if (st && !DEAD.has(st.state) && !allowNull && !Number.isFinite(tsOf(val))) e.push(`${label}older_than은 값이 시각(timestamp)인 엔티티·속성에만 쓴다 (지금 값 ${JSON.stringify(val ?? null)})`)
	}
}

export function validateRule(r, states) {
	const e = []
	if (!r || typeof r !== 'object') return { ok: false, error: '규칙이 객체가 아님' }
	if (!ID_RE.test(r.id ?? '')) e.push('id는 영문 소문자·숫자·밑줄 3~48자')
	if (typeof r.description !== 'string' || !r.description.trim() || r.description.length > 120) e.push('description은 1~120자')
	checkCond(r, states, OPS, e)
	if (!(Number(r.for_minutes) >= 0 && Number(r.for_minutes) <= 10080)) e.push('for_minutes는 0~10080')
	if (r.op === 'stale' && !(Number(r.for_minutes) >= 10)) e.push('stale은 for_minutes 10 이상')
	if (['changes_gt', 'rise_gt', 'drop_gt'].includes(r.op) && !(Number(r.for_minutes) >= 1 && Number(r.for_minutes) <= 1440)) e.push(`${r.op}의 for_minutes(살펴보는 구간)는 1~1440`)
	if (r.op === 'older_than' && Number(r.for_minutes) !== 0) e.push('older_than의 for_minutes는 0 (기간은 value에 분으로 적는다)')
	if (!(Number(r.cooldown_minutes) >= 0 && Number(r.cooldown_minutes) <= 10080)) e.push('cooldown_minutes는 0~10080')
	if (!['urgent', 'normal'].includes(r.priority)) e.push('priority는 urgent 또는 normal')
	const also = r.also ?? []
	if (!Array.isArray(also) || also.length > MAX_ALSO) e.push(`also는 ${MAX_ALSO}개까지의 배열`)
	else also.forEach((c, i) => (c && typeof c === 'object' ? checkCond(c, states, ALSO_OPS, e, `also[${i}] `) : e.push(`also[${i}]가 객체가 아님`)))
	const hf = r.hour_from ?? null, ht = r.hour_to ?? null
	if ((hf === null) !== (ht === null)) e.push('hour_from과 hour_to는 둘 다 쓰거나 둘 다 null')
	else if (hf !== null && !(Number.isInteger(hf) && Number.isInteger(ht) && hf >= 0 && hf <= 23 && ht >= 0 && ht <= 24 && hf !== ht)) e.push('hour_from은 0~23, hour_to는 0~24 정수(서로 달라야 함)')
	if (e.length) return { ok: false, error: e.join(', ') }
	return {
		ok: true,
		rule: {
			id: r.id, description: r.description.trim(), entity_id: r.entity_id,
			attribute: r.attribute ?? null, op: r.op, value: r.value ?? null,
			for_minutes: Number(r.for_minutes), priority: r.priority, cooldown_minutes: Number(r.cooldown_minutes),
			also: also.map(c => ({ entity_id: c.entity_id, attribute: c.attribute ?? null, op: c.op, value: c.value ?? null })),
			hour_from: hf, hour_to: ht,
		},
	}
}

// 조건이 달라지면 key가 달라져 규칙이 새로 무장된다. 덧붙은 조건이 없는 규칙은 예전 key 그대로다.
export function ruleKey(r) {
	const base = [r.entity_id, r.attribute, r.op, r.value, r.for_minutes]
	const extra = (r.also?.length ?? 0) > 0 || r.hour_from != null
	return JSON.stringify(extra ? [...base, r.also ?? [], r.hour_from ?? null, r.hour_to ?? null] : base)
}
const splitVals = v => String(v).split('|').map(s => s.trim()).filter(Boolean)
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v))
// 값이 그대로여도 보고가 오면 last_reported는 갱신된다(last_updated는 값·속성이 바뀔 때만).
const reportedAt = st => Date.parse(st.last_reported ?? st.last_updated ?? st.last_changed)

// 구간 안의 표본과, 구간이 시작될 때의 값(직전 표본 하나)을 돌려준다.
function windowed(samples, now, win) {
	const i = samples.findIndex(x => now - x[0] <= win)
	return i > 0 ? samples.slice(i - 1) : i < 0 ? samples.slice(-1) : samples
}

export function inHours(rule, now) {
	if (rule.hour_from == null || rule.hour_to == null) return true
	const h = kst(new Date(now)).h
	return rule.hour_from < rule.hour_to ? h >= rule.hour_from && h < rule.hour_to : h >= rule.hour_from || h < rule.hour_to
}

// 엔티티 하나에 대한 조건. hist는 changes_gt·rise_gt·drop_gt가 쓰는 최근 기록.
export function condition(rule, st, now, hist = null) {
	if (!st) return false
	const v = readValue(rule, st)
	const alive = !DEAD.has(st.state)
	const win = rule.for_minutes * 60000
	switch (rule.op) {
		case 'unavailable': return DEAD.has(st.state)
		case 'stale': return now - reportedAt(st) >= win
		case 'eq': return v != null && String(v) === String(rule.value)
		case 'ne': return alive && v != null && String(v) !== String(rule.value)
		case 'in': return v != null && splitVals(rule.value).includes(String(v))
		case 'not_in': return alive && v != null && !splitVals(rule.value).includes(String(v))
		case 'gt': return alive && Number.isFinite(num(v)) && num(v) > Number(rule.value)
		case 'lt': return alive && Number.isFinite(num(v)) && num(v) < Number(rule.value)
		// 값이 가리키는 시각이 value분보다 오래됐다(예: 마지막 백업 성공 시각이 48시간 전보다 이전).
		case 'older_than': return alive && Number.isFinite(tsOf(v)) && now - tsOf(v) > Number(rule.value) * 60000
		case 'changes_gt': return (hist?.changes ?? []).filter(t => now - t <= win).length > Number(rule.value)
		case 'rise_gt':
		case 'drop_gt': {
			const s = windowed(hist?.samples ?? [], now, win)
			if (!alive || !Number.isFinite(num(v)) || !s.length) return false
			const vals = s.map(x => x[1])
			return rule.op === 'rise_gt' ? num(v) - Math.min(...vals) > Number(rule.value) : Math.max(...vals) - num(v) > Number(rule.value)
		}
		default: return false
	}
}

export class RuleEngine {
	// rt는 state/runtime.json의 rules 객체를 그대로 받아 고친다(저장은 호출한 쪽에서).
	constructor(rules = [], rt = {}) {
		this.rules = rules
		this.rt = rt
		this.hist = new Map() // 규칙 id → { last, changes: [시각], samples: [[시각, 값]] } (메모리에만)
	}

	#fresh(rule) {
		const old = this.rt[rule.id]
		return (this.rt[rule.id] = { key: ruleKey(rule), since: null, fired: false, last_fired: null, fire_log: old?.fire_log ?? [], clear_log: old?.clear_log ?? [], muted_until: old?.muted_until ?? null })
	}

	#holds(rule, get, now) {
		if (!inHours(rule, now)) return false
		if (!condition(rule, get(rule.entity_id), now, this.hist.get(rule.id))) return false
		return (rule.also ?? []).every(c => condition(c, get(c.entity_id), now))
	}

	// 변화 횟수·변화 폭을 보는 규칙을 위해 주 엔티티의 값을 적어 둔다.
	#record(rule, st, now) {
		if (!['changes_gt', 'rise_gt', 'drop_gt'].includes(rule.op) || !st) return
		const h = this.hist.get(rule.id) ?? this.hist.set(rule.id, { last: undefined, changes: [], samples: [] }).get(rule.id)
		const v = readValue(rule, st)
		const win = rule.for_minutes * 60000
		if (rule.op === 'changes_gt') {
			if (h.last !== undefined && String(v) !== String(h.last) && !DEAD.has(st.state)) h.changes.push(now)
			if (!DEAD.has(st.state)) h.last = v
			h.changes = h.changes.filter(t => now - t <= win).slice(-500)
		} else if (Number.isFinite(num(v)) && !DEAD.has(st.state)) {
			const lastS = h.samples.at(-1)
			if (!lastS || lastS[1] !== num(v)) h.samples.push([now, num(v)])
			h.samples = windowed(h.samples, now, win).slice(-500)
		}
	}

	// 새로 만들거나 바뀐 규칙: 지금 이미 참이면 알고 있는 상황으로 보고 다음 변화부터 본다.
	arm(rule, get, now) {
		const rt = this.#fresh(rule)
		this.hist.delete(rule.id)
		this.#record(rule, get(rule.entity_id), now)
		if (this.#holds(rule, get, now)) { rt.fired = true; rt.since = now }
	}

	evaluate(rule, get, now, initial = false) {
		const rt = this.rt[rule.id]
		if (!rt || rt.key !== ruleKey(rule)) { this.arm(rule, get, now); return null }
		if (!this.#holds(rule, get, now)) {
			// 발동했던 상황이 풀린 시각을 남긴다(알림 뒤에 실제로 해결됐는지 보는 자료).
			if (rt.fired && rt.open) rt.clear_log = [...(rt.clear_log ?? []).slice(-9), [rt.open, now]]
			rt.open = null
			rt.since = null
			rt.fired = false
			rt.waiting = false
			return null
		}
		if (rt.fired && !rt.waiting) return null
		if (!rt.fired) {
			if (!WINDOW_OPS.includes(rule.op)) {
				if (rt.since == null) {
					const ids = [rule, ...(rule.also ?? [])]
					const changed = Math.max(...ids.map(c => Date.parse(c.attribute ? get(c.entity_id)?.last_updated : get(c.entity_id)?.last_changed)))
					rt.since = initial && rule.hour_from == null && Number.isFinite(changed) ? changed : now
				}
				if (now - rt.since < rule.for_minutes * 60000) return null
			}
			rt.fired = true
		}
		// 쉬는 중이거나 쿨다운 중이면 미뤄 둔다(waiting). 그 시간이 끝났을 때 아직 참이면 그때 발동한다.
		// (예전에는 여기서 버려서, 쿨다운 안에 다시 시작돼 계속 이어지는 상황을 끝내 알리지 않았다.)
		if ((rt.muted_until && now < rt.muted_until) || (rt.last_fired && now - rt.last_fired < rule.cooldown_minutes * 60000)) {
			rt.waiting = true
			return null
		}
		rt.waiting = false
		rt.last_fired = now
		rt.open = now
		rt.fire_log = [...(rt.fire_log ?? []).filter(t => now - t < 7 * 86400000), now]
		return { rule, value: readValue(rule, get(rule.entity_id)), since: rt.since ?? now }
	}

	// states를 주면 also에 적힌 다른 엔티티도 함께 본다.
	onState(entityId, st, now, states = null) {
		const get = id => (id === entityId ? st : states?.get(id))
		const out = []
		for (const r of this.rules) {
			const main = r.entity_id === entityId
			if (!main && !(r.also ?? []).some(c => c.entity_id === entityId)) continue
			if (main) this.#record(r, st, now)
			const f = this.evaluate(r, get, now)
			if (f) out.push(f)
		}
		return out
	}

	tick(states, now) {
		const get = id => states.get(id)
		return this.rules.map(r => this.evaluate(r, get, now)).filter(Boolean)
	}

	// 데몬 시작: 꺼져 있던 동안 생긴 일은 마지막 변경 시각으로 따진다.
	initAll(states, now) {
		this.#prune()
		const get = id => states.get(id)
		for (const r of this.rules) if (!this.hist.has(r.id)) this.#record(r, get(r.entity_id), now)
		return this.rules.map(r => this.evaluate(r, get, now, true)).filter(Boolean)
	}

	setRules(rules, states, now, changedIds = []) {
		this.rules = rules
		this.#prune()
		for (const r of rules) if (changedIds.includes(r.id)) this.arm(r, id => states.get(id), now)
	}

	mute(id, until) {
		const rt = this.rt[id]
		if (!rt) return false
		rt.muted_until = until
		return true
	}

	#prune() {
		for (const id of Object.keys(this.rt)) if (!this.rules.some(r => r.id === id)) delete this.rt[id]
		for (const id of this.hist.keys()) if (!this.rules.some(r => r.id === id)) this.hist.delete(id)
	}
}
