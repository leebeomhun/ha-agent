// 주간 분석 자료: HA 활동 기록(logbook) 7일치에서 자동화 실행과 기기 조작을 간추린다.
import { fmt, kst } from './util.mjs'

// 사람이 직접 다루거나 자동화가 움직이는 기기 도메인
export const DEVICE_DOMAINS = new Set(['light', 'switch', 'fan', 'climate', 'media_player', 'cover', 'humidifier', 'vacuum', 'lock', 'input_boolean'])
export const WEEKLY_HOURS = 168

const inc = (m, k) => { m[k] = (m[k] ?? 0) + 1 }
const top = (m, n) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n))
const ms = r => r.when * 1000
const dayKey = t => { const k = kst(new Date(t)); return `${k.date.slice(5)}(${k.wd})` }
const stamp = t => { const k = kst(new Date(t)); return `${k.date.slice(5)}(${k.wd}) ${k.hm}` }
const valid = rows => (Array.isArray(rows) ? rows : []).filter(r => r?.entity_id && Number.isFinite(r.when)).sort((a, b) => a.when - b.when)
// HA가 기록을 7일보다 짧게 갖고 있으면 분석 기간도 그만큼이다.
const periodOf = (rows, { from, to }) => ({ from: fmt(from), to: fmt(to), oldest_record: rows.length ? fmt(ms(rows[0])) : null })

// 자동화별 실행 횟수·날짜별·시간대별 분포와 무엇이 실행시켰는지. automations는 automationList()의 결과.
export function automationRuns(rows, automations, period) {
	rows = valid(rows)
	const by = new Map()
	for (const r of rows) {
		if (r.state !== undefined) continue // 자동화를 켜고 끈 기록은 실행이 아니다
		if (!by.has(r.entity_id)) by.set(r.entity_id, [])
		by.get(r.entity_id).push(r)
	}
	const list = automations.map(a => {
		const runs = by.get(a.id) ?? []
		const o = { id: a.id, name: a.name, state: a.state, runs: runs.length, last_triggered: a.last_triggered ?? null }
		if (!runs.length) return o
		const days = {}, hours = {}, triggers = {}
		for (const r of runs) {
			inc(days, dayKey(ms(r)))
			inc(hours, `${String(kst(new Date(ms(r))).h).padStart(2, '0')}시`)
			inc(triggers, r.source || String(r.message ?? '').replace(/^triggered( by )?/, '') || '출처 없음')
		}
		return { ...o, first: stamp(ms(runs[0])), last: stamp(ms(runs.at(-1))), by_day: days, by_hour: Object.fromEntries(Object.entries(hours).sort()), triggers: top(triggers, 8) }
	})
	return { period: periodOf(rows, period), automations: list.sort((a, b) => b.runs - a.runs) }
}

// 상태 변화를 누가 일으켰는지. 자동화·스크립트가 아닌 것은 사람이 했거나 기기가 스스로 바뀐 것이다.
function sourceOf(r) {
	const t = r.context_event_type
	if (t === 'automation_triggered' || r.context_domain === 'automation') return { auto: true, trigger: r.context_source ?? null, label: `자동화: ${r.context_name ?? r.context_entity_id ?? '?'}` }
	if (t === 'script_started' || r.context_domain === 'script') return { auto: true, trigger: null, label: `스크립트: ${r.context_name ?? `script.${r.context_service ?? '?'}`}` }
	if (t === 'call_service') return { auto: false, label: '서비스 호출(앱·대시보드·음성·집 비서)' }
	if (t === 'homekit_state_change' || r.context_domain === 'homekit') return { auto: false, label: 'HomeKit' }
	if (t) return { auto: false, label: t }
	return { auto: false, label: '기기에서 직접(물리 버튼·리모컨·기기 자체)' }
}

const GONE = new Set(['unavailable', 'unknown'])

// 기기별 상태 변화의 출처, 자동화가 아닌 조작 목록, 자동화와 사람이 서로 되돌린 일.
export function deviceActivity(rows, states, areaOf, period, { withinMinutes = 10, maxManual = 30, maxNotes = 12 } = {}) {
	rows = valid(rows)
	const by = new Map()
	for (const r of rows) {
		if (!by.has(r.entity_id)) by.set(r.entity_id, [])
		by.get(r.entity_id).push(r)
	}
	const devices = []
	for (const [id, list] of by) {
		const st = states.get(id)
		const o = { id, name: st?.attributes?.friendly_name ?? id }
		const area = areaOf?.get(id)
		if (area) o.area = area
		const sources = {}, manual = [], reverted = [], overridden = [], notes = []
		let changes = 0, gone = 0, manualCount = 0
		let prev = null // 직전 상태 변화 { state, before, t, src }
		let back = false // 연결이 끊겼다 돌아온 직후
		for (const r of list) {
			const src = sourceOf(r)
			if (r.state === undefined) {
				// 자동화가 남긴 설명 기록(예: "켬: 습도 급상승"). 왜 움직였는지 알 수 있다.
				if (r.message) notes.push(`${stamp(ms(r))} ${r.message}${src.auto ? ` ← ${src.label}` : ''}`)
				continue
			}
			if (GONE.has(r.state)) { gone++; prev = null; back = true; continue }
			const cur = { state: r.state, before: prev?.state ?? null, t: ms(r), src }
			// 연결이 돌아오며 찍힌 첫 상태는 누가 바꾼 것이 아니다.
			if (back) { back = false; prev = cur; continue }
			changes++
			inc(sources, src.label)
			if (!src.auto) {
				manualCount++
				manual.push(`${stamp(cur.t)} ${r.state} · ${src.label}`)
			}
			const undo = prev && cur.state !== prev.state && cur.state === prev.before && cur.t - prev.t <= withinMinutes * 60000
			if (undo && prev.src.auto && !src.auto) reverted.push({ at: stamp(cur.t), automation: prev.src.label, trigger: prev.src.trigger ?? undefined, did: `${prev.before} → ${prev.state}`, undone_after_min: Math.round((cur.t - prev.t) / 60000), by: src.label })
			if (undo && !prev.src.auto && src.auto) overridden.push({ at: stamp(cur.t), person_did: `${prev.before} → ${prev.state}`, undone_after_min: Math.round((cur.t - prev.t) / 60000), by: src.label, trigger: src.trigger ?? undefined })
			prev = cur
		}
		if (!changes && !gone && !notes.length) continue
		o.changes = changes
		o.by_source = top(sources, 8)
		if (gone) o.unavailable_count = gone
		o.manual_count = manualCount
		if (manual.length) o.manual = manual.slice(-maxManual)
		if (reverted.length) o.reverted = reverted.slice(-20)
		if (overridden.length) o.overridden = overridden.slice(-20)
		if (notes.length) o.automation_notes = notes.slice(-maxNotes)
		devices.push(o)
	}
	return { period: periodOf(rows, period), devices: devices.sort((a, b) => b.manual_count - a.manual_count) }
}
