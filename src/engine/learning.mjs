// 데이터 기반 자가개선 엔진:
// 1) 암묵적 피드백(Implicit Feedback) 자동 수집 (행동 되돌림, 대화 마찰, 알림 해결, 제안 결과)
// 2) HA 재시작 스파이크 필터 + 정량 루틴 마이너(Routine Miner)
// 3) 규칙 정밀도 스코어카드(Rule Precision Scorecard)
// 4) 실패 사례 → 회귀 평가셋(Eval Cases) 자동 축적
// 5) Tier 2 자가 튜닝 제안 생성(별칭, 소음 엔티티, STT 엔드포인트, 교훈)
// 6) 변경 사후 효과 검증 원장(Change Experiment Ledger)
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { P, DAY, kst, readJson, writeJson, newId, globs } from '../util.mjs'
import { recentFires } from '../rules.mjs'
import { jaccard, tokenize } from '../core/embeddings.mjs'
import { HUMAN_ORIGINS, isHumanChange } from './origin.mjs'

const MIN = 60000
const CORRECTION_RE = /(아니야|아니[,.\s]|그게\s*아니|취소해|왜\s*껐|왜\s*켰|잘못\s*(?:껐|켰|바꿨|알아)|다시\s*원래대로|그만해)/
const ROUTINE_DOMAINS = new Set(['light', 'switch', 'media_player', 'fan', 'climate', 'input_boolean', 'cover'])
const ACTIVE_STATES = new Set(['on', 'playing', 'open', 'heat', 'cool', 'auto'])
const INACTIVE_STATES = new Set(['off', 'closed', 'standby'])

// ── 1) HA 재시작/재연결 스파이크 필터 ──
// 짧은 창(기본 90초) 안에 서로 다른 엔티티가 N개(기본 15개) 이상 한꺼번에 바뀌면 재부팅/재연결 버스트로 간주해 제외한다.
export function filterRestartSpikes(events = [], { windowMs = 90000, minEntities = 15 } = {}) {
	if (!Array.isArray(events) || events.length < minEntities) return { events: events ?? [], removed: 0 }
	const sorted = [...events].sort((a, b) => a.t - b.t)
	const spikeBuckets = new Set()
	const byBucket = new Map()
	for (const e of sorted) {
		const b = Math.floor(e.t / windowMs)
		let set = byBucket.get(b)
		if (!set) { set = new Set(); byBucket.set(b, set) }
		set.add(e.id)
	}
	for (const [b, set] of byBucket) {
		if (set.size >= minEntities) {
			spikeBuckets.add(b)
			// 인접 버킷도 경계에 걸친 재시작 이벤트가 8개 이상이면 함께 제외
			if ((byBucket.get(b + 1)?.size ?? 0) >= Math.ceil(minEntities * 0.5)) spikeBuckets.add(b + 1)
		}
	}
	if (!spikeBuckets.size) return { events: sorted, removed: 0 }
	const kept = sorted.filter(e => !spikeBuckets.has(Math.floor(e.t / windowMs)))
	return { events: kept, removed: sorted.length - kept.length }
}

// ── 2) 실패 사례 → 회귀 평가셋(state/evals/cases.json) ──
export function evalCasesPath() {
	return join(P.state, 'evals', 'cases.json')
}

export function loadEvalCases(path = evalCasesPath()) {
	const list = readJson(path, [])
	return Array.isArray(list) ? list : []
}

export function recordEvalCase({ text, expect = null, source = 'auto', note = '', now = Date.now(), path = evalCasesPath(), maxCases = 50 } = {}) {
	const clean = String(text ?? '').trim()
	if (clean.length < 2) return null
	const list = loadEvalCases(path)
	const norm = clean.toLowerCase().replace(/\s+/g, '')
	const existing = list.find(c => String(c.text ?? '').toLowerCase().replace(/\s+/g, '') === norm)
	if (existing) {
		existing.hits = (existing.hits ?? 1) + 1
		existing.updated_at = new Date(now).toISOString()
		if (note && !String(existing.note ?? '').includes(note)) existing.note = `${existing.note ? `${existing.note}; ` : ''}${note}`.slice(0, 200)
		writeJson(path, list)
		return existing
	}
	const item = {
		id: `eval_${newId()}`,
		text: clean.slice(0, 200),
		expect: Array.isArray(expect) ? expect : null,
		source,
		note: String(note ?? '').slice(0, 200),
		hits: 1,
		created_at: new Date(now).toISOString(),
	}
	const next = [...list, item].slice(-maxCases)
	mkdirSync(dirname(path), { recursive: true })
	writeJson(path, next)
	return item
}

// ── 3) 암묵적 피드백 추적기 ──
export class ImplicitFeedbackTracker {
	constructor({ store = null, evalPath = null } = {}) {
		this.store = store
		this.evalPath = evalPath
		// 최근 에이전트가 실행한 제어 추적(entity_id → { aid, prevState, toState, ts, reason })
		this.recentControls = new Map()
		// 최근 HA 자동화가 바꾼 기기(entity_id → { automation, from, to, ts }) — 사람이 곧바로 되돌리면 자동화가 틀린 것
		this.recentAutomation = new Map()
		// 최근 보낸 규칙 알림({ nid, rule_ids, entity_ids, ts, acted }) — 알림 뒤 사람이 그 기기를 만지면 알림이 쓸모 있었던 것
		this.recentAlerts = []
	}

	trackAlert({ nid, rule_ids = [], entity_ids = [], ts = Date.now() } = {}) {
		const ents = [...new Set(entity_ids.filter(Boolean))]
		if (!nid || !ents.length) return
		this.recentAlerts.push({ nid, rule_ids, entity_ids: ents, ts, acted: false })
		if (this.recentAlerts.length > 50) this.recentAlerts.shift()
	}

	#evalPath() { return this.evalPath ?? evalCasesPath() }

	trackExecutedControl(rec, now = Date.now()) {
		if (!rec?.entity_id || rec.undo_of) return
		const toState = rec.service === 'turn_on' ? 'on' : rec.service === 'turn_off' ? 'off' : (rec.service_data?.option ?? null)
		if (!rec.prev || !toState || rec.prev === toState) return
		this.recentControls.set(rec.entity_id, {
			aid: rec.aid,
			prevState: String(rec.prev),
			toState: String(toState),
			ts: now,
			reason: rec.reason ?? '',
			requested: Boolean(rec.requested),
		})
	}

	// 상태 변화 하나로 세 가지를 본다. change.origin(user·device·automation·agent)이 없으면(예전 기록·시험) 사람 조작일 수도 있다고 본다.
	// 1) 집 비서가 제어한 기기를 사람이 15분 안에 되돌림 → action_reverted(-1)
	// 2) HA 자동화가 바꾼 기기를 사람이 15분 안에 되돌림 → automation_overridden(-1, ref_id=자동화)
	// 3) 규칙 알림 뒤 30분 안에 사람이 그 기기를 만짐 → notification_acted(+1, ref_id=알림)
	// 돌려주는 값: 기록한 것 중 첫 번째(없으면 null)
	onStateEvent(change, { now = Date.now(), windowMs = 15 * MIN, alertWindowMs = 30 * MIN } = {}) {
		if (!change?.id) return null
		const human = isHumanChange(change) // true·false·null(모름)
		const recorded = []
		const rec = r => { this.store?.recordImplicitFeedback(r); recorded.push(r) }

		const tracked = this.recentControls.get(change.id)
		if (tracked) {
			if (now - tracked.ts > windowMs) this.recentControls.delete(change.id)
			// 제어 직후 3초 이내의 바운스는 무시, 사람이 아닌 쪽(자동화·집 비서)이 되돌린 것도 사람의 거부가 아니다
			else if (now - tracked.ts >= 3000 && human !== false
				&& String(change.to) === tracked.prevState && String(change.from) === tracked.toState) {
				this.recentControls.delete(change.id)
				rec({
					ts: now,
					kind: 'action_reverted',
					entity_id: change.id,
					ref_id: tracked.aid,
					score: -1,
					detail: {
						from: tracked.toState,
						to: tracked.prevState,
						after_sec: Math.round((now - tracked.ts) / 1000),
						reason: tracked.reason,
						requested: tracked.requested,
						origin: change.origin ?? null,
					},
				})
			}
		}

		if (change.origin === 'automation') {
			this.recentAutomation.set(change.id, { automation: change.actor ?? null, from: String(change.from), to: String(change.to), ts: now })
			if (this.recentAutomation.size > 300) this.recentAutomation.delete(this.recentAutomation.keys().next().value)
		} else if (human === true) {
			const a = this.recentAutomation.get(change.id)
			if (a && now - a.ts <= windowMs && now - a.ts >= 3000 && String(change.to) === a.from && String(change.from) === a.to) {
				this.recentAutomation.delete(change.id)
				rec({
					ts: now,
					kind: 'automation_overridden',
					entity_id: change.id,
					ref_id: a.automation,
					score: -1,
					detail: { automation: a.automation, automation_set: a.to, user_set: String(change.to), after_sec: Math.round((now - a.ts) / 1000), origin: change.origin },
				})
			} else if (a && now - a.ts > windowMs) this.recentAutomation.delete(change.id)

			for (const al of this.recentAlerts) {
				if (al.acted || now - al.ts > alertWindowMs || now < al.ts || !al.entity_ids.includes(change.id)) continue
				al.acted = true
				rec({
					ts: now,
					kind: 'notification_acted',
					entity_id: change.id,
					ref_id: al.nid,
					score: 1,
					detail: { rule_ids: al.rule_ids, after_sec: Math.round((now - al.ts) / 1000), to: String(change.to) },
				})
			}
			this.recentAlerts = this.recentAlerts.filter(al => now - al.ts <= alertWindowMs)
		}
		return recorded[0] ?? null
	}

	onActionButtonOutcome(rec, status, now = Date.now()) {
		if (!rec) return
		if (status === 'undone' || status === 'declined') {
			this.recentControls.delete(rec.entity_id)
			this.store?.recordImplicitFeedback({
				ts: now,
				kind: status === 'undone' ? 'action_undone' : 'action_declined',
				entity_id: rec.entity_id,
				ref_id: rec.aid,
				score: -1,
				detail: { service: rec.service ?? rec.action, reason: rec.reason, requested: Boolean(rec.requested) },
			})
		}
	}

	onProposalOutcome(proposal, status, now = Date.now(), error = null) {
		if (!proposal) return
		const kindMap = {
			applied: ['proposal_applied', 1],
			rejected: ['proposal_rejected', -1],
			rolled_back: ['proposal_rolled_back', -1],
			rollback_failed: ['proposal_rollback_failed', -1],
			// 승인도 거절도 없이 기한이 지남 = 제안이 관심을 끌지 못함
			ignored: ['proposal_ignored', -0.5],
			// 집 비서가 만든 자동화를 사용자가 직접 고치거나 지움
			edited_by_user: ['proposal_edited_by_user', -0.5],
			deleted_by_user: ['proposal_deleted_by_user', -1],
			validation_failed: ['proposal_validation_failed', -0.5],
		}
		const mapped = kindMap[status]
		if (!mapped) return
		this.store?.recordImplicitFeedback({
			ts: now,
			kind: mapped[0],
			entity_id: proposal.target_id ?? null,
			ref_id: proposal.pid ?? null,
			score: mapped[1],
			detail: { kind: proposal.kind, title: proposal.title, error: error ?? proposal.error ?? null },
		})
	}

	onAssistTurn({
		text, speech = '', prevUserMsgs = [], hadUnexecutedClaim = false, fellBack = false,
		actions = [], now = Date.now(),
	} = {}) {
		const recorded = []
		const clean = String(text ?? '').trim()

		if (hadUnexecutedClaim) {
			const r = { ts: now, kind: 'assist_unexecuted_claim', score: -1, detail: { text: clean, speech } }
			this.store?.recordImplicitFeedback(r)
			recorded.push(r)
			recordEvalCase({ text: clean, source: 'assist_unexecuted_claim', note: '도구 호출 없이 제어했다고 응답', now, path: this.#evalPath() })
		}

		if (fellBack) {
			const r = { ts: now, kind: 'assist_fallback', score: -0.3, detail: { text: clean } }
			this.store?.recordImplicitFeedback(r)
			recorded.push(r)
		}

		// 90초 내 유사 명령 재발화 탐지
		const prev = prevUserMsgs.filter(m => now - m.ts <= 90000 && now - m.ts >= 1000).at(-1)
		if (prev && clean.length >= 3) {
			const sim = jaccard(tokenize(clean), tokenize(prev.text))
			if (sim >= 0.7) {
				const r = { ts: now, kind: 'assist_retry', score: -0.5, detail: { prev: prev.text, cur: clean, similarity: Math.round(sim * 100) / 100 } }
				this.store?.recordImplicitFeedback(r)
				recorded.push(r)
			}
		}

		// 사용자 정정·불만 발화 탐지
		if (CORRECTION_RE.test(clean)) {
			const prevTurn = prevUserMsgs.at(-1)
			const r = { ts: now, kind: 'assist_correction', score: -1, detail: { text: clean, prev_user: prevTurn?.text ?? null } }
			this.store?.recordImplicitFeedback(r)
			recorded.push(r)
			if (prevTurn?.text) {
				recordEvalCase({ text: prevTurn.text, expect: [], source: 'assist_correction', note: `후속 정정: ${clean.slice(0, 80)}`, now, path: this.#evalPath() })
			}
		}

		// 의향 질문("~어때?", "~할까?")에서 제어 실행이 발생했으면 회귀 케이스 자동 등록
		if (/(어때\??|할까\??|어떨까\??|좋을까\??)$/.test(clean) && actions.some(a => a?.status === 'done')) {
			recordEvalCase({ text: clean, expect: [], source: 'intent_question_executed', note: '의향 질문에 즉시 제어 실행됨', now, path: this.#evalPath() })
		}

		return recorded
	}

	summarize({ sinceMs = Date.now() - 14 * DAY } = {}) {
		if (!this.store) return { total: 0, by_kind: {}, top_entities: [] }
		const rows = this.store.recentImplicitFeedback({ sinceMs, limit: 500 })
		const byKind = {}
		const byEnt = {}
		for (const r of rows) {
			byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
			if (r.entity_id && r.score < 0) byEnt[r.entity_id] = (byEnt[r.entity_id] ?? 0) + 1
		}
		const topEntities = Object.entries(byEnt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([entity_id, count]) => ({ entity_id, count }))
		return { total: rows.length, by_kind: byKind, top_entities: topEntities }
	}
}

// ── 4) 정량 루틴 마이너(Routine Miner) ──
function median(nums) {
	if (!nums.length) return null
	const s = [...nums].sort((a, b) => a - b)
	const mid = Math.floor(s.length / 2)
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function iqr(nums) {
	if (nums.length < 4) return null
	const s = [...nums].sort((a, b) => a - b)
	const q1 = s[Math.floor(s.length * 0.25)]
	const q3 = s[Math.floor(s.length * 0.75)]
	return Math.round(q3 - q1)
}

const fmtMin = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`

export function mineRoutines({ store, now = Date.now(), days = 42, isNoise = () => false } = {}) {
	if (!store) return { period_days: days, filtered_restart_events: 0, presence_routines: [], device_routines: [] }
	const raw = store.eventsInRange(now - days * DAY, now)
	const { events, removed } = filterRestartSpikes(raw)

	// 날짜별 평일/휴일 분류(Workday 센서 기록이 있으면 우선 반영)
	const workdayStateByDate = new Map()
	for (const e of events) {
		if (/workday_sensor/.test(e.id) && (e.to === 'on' || e.to === 'off')) {
			workdayStateByDate.set(kst(new Date(e.t)).date, e.to === 'on' ? 'workday' : 'holiday_weekend')
		}
	}
	const dayTypeOf = t => {
		const k = kst(new Date(t))
		if (workdayStateByDate.has(k.date)) return workdayStateByDate.get(k.date)
		return (k.wd === '토' || k.wd === '일') ? 'holiday_weekend' : 'workday'
	}

	// 관측된 날짜 수 집계(평일/주말)
	const daysSeen = { workday: new Set(), holiday_weekend: new Set() }
	for (const e of events) {
		const k = kst(new Date(e.t))
		daysSeen[dayTypeOf(e.t)].add(k.date)
	}

	// A) 재실 이동(출근·귀가) 루틴
	const presenceBuckets = new Map() // `${id}|${dayType}|${dir}` -> Map(date -> minOfDay)
	for (const e of events) {
		if (!e.id.startsWith('person.') || isNoise(e.id)) continue
		let dir = null
		if (e.from === 'home' && e.to !== 'home' && e.to !== 'unavailable' && e.to !== 'unknown') dir = 'leave'
		else if (e.from !== 'home' && e.to === 'home' && e.from !== 'unavailable' && e.from !== 'unknown') dir = 'arrive'
		if (!dir) continue
		const dt = dayTypeOf(e.t)
		const k = kst(new Date(e.t))
		const minOfDay = k.h * 60 + k.mi
		const key = `${e.id}|${dt}|${dir}`
		let byDate = presenceBuckets.get(key)
		if (!byDate) { byDate = new Map(); presenceBuckets.set(key, byDate) }
		// leave는 하루 첫 외출, arrive는 하루 마지막 귀가 기록
		if (dir === 'leave') { if (!byDate.has(k.date)) byDate.set(k.date, minOfDay) }
		else byDate.set(k.date, minOfDay)
	}

	const presence_routines = []
	for (const [key, byDate] of presenceBuckets) {
		if (byDate.size < 3) continue
		const [entity_id, day_type, direction] = key.split('|')
		const mins = [...byDate.values()]
		const med = median(mins)
		const spread = iqr(mins)
		const totalDays = Math.max(daysSeen[day_type].size, byDate.size)
		const consistency = Math.round((byDate.size / totalDays) * 100)
		presence_routines.push({
			entity_id,
			day_type,
			direction,
			median_time: fmtMin(med),
			iqr_min: spread,
			observed_days: byDate.size,
			total_days: totalDays,
			consistency_pct: consistency,
		})
	}
	presence_routines.sort((a, b) => b.observed_days - a.observed_days)

	// B) 반복 기기 켜기·끄기 루틴 (30분 슬롯 단위). 조작 주체가 기록된 변화는 사람(앱·벽 스위치) 조작만 센다
	//    — 이미 있는 자동화가 한 일을 루틴으로 보면 같은 자동화를 또 제안하게 된다.
	const devSlots = new Map() // `${id}|${dayType}|${direction}|${slot30}` -> { name, dates: Set, mins: [] }
	for (const e of events) {
		const dom = e.id.split('.')[0]
		if (!ROUTINE_DOMAINS.has(dom) || isNoise(e.id)) continue
		if (e.origin && !HUMAN_ORIGINS.has(e.origin)) continue
		const direction = ACTIVE_STATES.has(e.to) ? 'on' : (INACTIVE_STATES.has(e.to) && ACTIVE_STATES.has(e.from)) ? 'off' : null
		if (!direction) continue
		const dt = dayTypeOf(e.t)
		const k = kst(new Date(e.t))
		const minOfDay = k.h * 60 + k.mi
		const slot = Math.floor(minOfDay / 30)
		const key = `${e.id}|${dt}|${direction}|${slot}`
		let rec = devSlots.get(key)
		if (!rec) { rec = { entity_id: e.id, name: e.name ?? e.id, day_type: dt, direction, slot, dates: new Set(), mins: new Map() }; devSlots.set(key, rec) }
		rec.dates.add(k.date)
		if (!rec.mins.has(k.date)) rec.mins.set(k.date, minOfDay)
	}

	const device_routines = []
	for (const rec of devSlots.values()) {
		if (rec.dates.size < 3) continue
		const totalDays = Math.max(daysSeen[rec.day_type].size, rec.dates.size)
		const consistency = Math.round((rec.dates.size / totalDays) * 100)
		if (consistency < 40) continue
		device_routines.push({
			entity_id: rec.entity_id,
			name: rec.name,
			day_type: rec.day_type,
			direction: rec.direction,
			median_time: fmtMin(median([...rec.mins.values()])),
			dates: [...rec.dates].sort(),
			window: `${fmtMin(rec.slot * 30)}~${fmtMin((rec.slot + 1) * 30)}`,
			observed_days: rec.dates.size,
			total_days: totalDays,
			consistency_pct: consistency,
		})
	}
	device_routines.sort((a, b) => b.consistency_pct - a.consistency_pct || b.observed_days - a.observed_days)

	return {
		period_days: days,
		filtered_restart_events: removed,
		presence_routines: presence_routines.slice(0, 10),
		device_routines: device_routines.slice(0, 20),
	}
}

// ── 5) 규칙 정밀도 스코어카드(Rule Precision Scorecard) ──
export function scoreRules({ rules = [], runtime = {}, store = null, now = Date.now(), days = 14 } = {}) {
	const sinceMs = now - days * DAY
	const decisions = store ? store.decisionsInRange(sinceMs, now) : []
	const feedbacks = store ? store.feedbackInRange(sinceMs, now) : []

	const wakeStats = new Map()
	for (const d of decisions) {
		if (d.skipped || d.deferred) continue
		const ruleReasons = (d.reasons ?? []).filter(r => typeof r === 'string' && r.startsWith('rule:')).map(r => r.slice(5))
		if (!ruleReasons.length) continue
		const sentNotes = (d.applied?.notifications ?? []).length > 0 || (d.applied?.actions ?? []).length > 0
		for (const rid of ruleReasons) {
			const s = wakeStats.get(rid) ?? { wakes: 0, notified: 0, noop: 0 }
			s.wakes++
			if (sentNotes) s.notified++
			else s.noop++
			wakeStats.set(rid, s)
		}
	}

	const fbStats = new Map()
	for (const f of feedbacks) {
		for (const rid of f.rules ?? []) {
			const s = fbStats.get(rid) ?? { up: 0, mute: 0 }
			if (f.kind === 'up') s.up++
			if (f.kind === 'mute') s.mute++
			fbStats.set(rid, s)
		}
	}

	return rules.map(r => {
		const rt = runtime[r.id] ?? {}
		const fires7d = recentFires(rt, now).length
		const ws = wakeStats.get(r.id) ?? { wakes: 0, notified: 0, noop: 0 }
		const fs = fbStats.get(r.id) ?? { up: 0, mute: 0 }
		const clears = (rt.clear_log ?? []).map(([a, b]) => Math.round((b - a) / MIN)).filter(m => Number.isFinite(m) && m >= 0)
		const avgClear = clears.length ? Math.round(clears.reduce((s, v) => s + v, 0) / clears.length) : null
		const noopRate = ws.wakes > 0 ? Math.round((ws.noop / ws.wakes) * 100) : null
		const muted = Boolean(rt.muted_until && rt.muted_until > now)

		let grade = 'ok'
		let suggestion = null
		if (muted || fs.mute > 0) {
			grade = 'muted'
			suggestion = '사용자가 쉼 처리함: 조건·시간대·임계값 재조정 또는 삭제 검토'
		} else if (ws.wakes >= 3 && noopRate >= 80) {
			grade = 'noisy'
			suggestion = `깨움 ${ws.wakes}회 중 ${noopRate}%가 무조치(noop): for_minutes/cooldown 증가 또는 also 조건 보강 권장`
		} else if (fires7d >= 10) {
			grade = 'noisy'
			suggestion = `7일 발동 ${fires7d}회로 과다: 임계값·쿨다운 상향 검토`
		} else if (fires7d === 0 && ws.wakes === 0) {
			grade = 'quiet'
		}

		return {
			id: r.id,
			description: r.description,
			fires_7d: fires7d,
			wakes: ws.wakes,
			notified: ws.notified,
			noop_wakes: ws.noop,
			noop_rate_pct: noopRate,
			avg_clear_min: avgClear,
			fb_up: fs.up,
			fb_mute: fs.mute,
			muted,
			grade,
			suggestion,
		}
	})
}

// ── 6) 자기 설정/교훈 개선 후보(Tier 2 Proposal 생성용) ──
const SIMPLE_VERB_STRIP = /(?:을|를|은|는|도)?\s*(?:좀|지금|바로|다시)?\s*(?:켜(?:줘요?|주세요|줄래요?|주라|라|요|봐|자)?|꺼(?:줘요?|주세요|줄래요?|주라|라|요|봐)?|끄(?:자|죠))[.!?~]*$/

export function generateSelfProposals({ store, cfg = {}, rules = [], states = new Map(), sttFailuresDir = P.sttFailures, now = Date.now() } = {}) {
	const candidates = []
	const existingPending = store ? store.listProposals({ status: 'pending', limit: 50 }) : []
	const alreadyPending = (kind, target) => existingPending.some(p => p.kind === kind && p.target_id === target)

	if (store) {
		const since14 = now - 14 * DAY
		// A) 별칭(self_alias_proposal) 후보: Assist에서 LLM을 통해 단순 켜기/끄기 실행된 표현 중 aliases에 없는 것
		const acts = store.actionsInRange(since14, now).filter(a => a.status === 'done' && (a.service === 'turn_on' || a.service === 'turn_off') && a.requested)
		const msgs = store.messagesInRange(since14, now).filter(m => m.role === 'user')
		const currentAliases = cfg.assist?.aliases ?? {}
		const phraseHits = new Map() // `${entity_id}|${phrase}` -> count
		for (const a of acts) {
			const aTs = Date.parse(a.ts)
			if (!Number.isFinite(aTs)) continue
			// 액션 직전 20초 내 사용자 발화 매칭
			const u = msgs.filter(m => m.ts <= aTs && aTs - m.ts <= 20000).at(-1)
			if (!u?.text || u.text.length > 30) continue
			const phrase = u.text.trim().replace(SIMPLE_VERB_STRIP, '').trim()
			if (phrase.length < 2 || phrase.length > 16) continue
			const known = [
				...(currentAliases[a.entity_id] ?? []),
				states.get(a.entity_id)?.attributes?.friendly_name ?? '',
			].map(s => String(s).replace(/\s+/g, '').toLowerCase())
			if (known.includes(phrase.replace(/\s+/g, '').toLowerCase())) continue
			const k = `${a.entity_id}|${phrase}`
			phraseHits.set(k, (phraseHits.get(k) ?? 0) + 1)
		}
		for (const [k, count] of phraseHits) {
			if (count < 2) continue
			const [entity_id, alias] = k.split('|')
			if (alreadyPending('self_alias_proposal', entity_id)) continue
			candidates.push({
				kind: 'self_alias_proposal',
				target_id: entity_id,
				title: `빠른 경로 별칭 추가: "${alias}"`,
				summary: `최근 14일간 "${alias}" 표현으로 ${entity_id} 제어가 ${count}회 LLM 경로를 탔어요. 별칭과 STT 힌트에 추가하면 지연과 토큰을 줄일 수 있어요.`,
				payload: { entity_id, alias, add_stt_hint: true, hits: count },
			})
		}

		// B) 소음 엔티티(self_noise_proposal) 후보: 7일간 20회 이상 바뀌었지만 규칙·행동·알림에 전혀 쓰이지 않은 엔티티
		const ev7 = filterRestartSpikes(store.eventsInRange(now - 7 * DAY, now)).events
		const churn = new Map()
		for (const e of ev7) {
			if (e.is_noise) continue
			churn.set(e.id, (churn.get(e.id) ?? 0) + 1)
		}
		const ruleRefs = new Set(rules.flatMap(r => [r.entity_id, ...(r.also ?? []).map(c => c.entity_id)]))
		const actRefs = new Set(store.actionsInRange(now - 30 * DAY, now).map(a => a.entity_id))
		const isNoiseAlready = globs(cfg.noise_entities ?? [])
		for (const [eid, count] of [...churn.entries()].sort((a, b) => b[1] - a[1])) {
			if (count < 20) break
			if (ruleRefs.has(eid) || actRefs.has(eid) || isNoiseAlready(eid)) continue
			if (eid.startsWith('person.') || eid.startsWith('lock.') || eid.startsWith('alarm_control_panel.')) continue
			if (alreadyPending('self_noise_proposal', eid)) continue
			candidates.push({
				kind: 'self_noise_proposal',
				target_id: eid,
				title: `소음 엔티티 등록: ${eid}`,
				summary: `지난 7일간 ${count}회 상태가 바뀌었지만 규칙·행동에 쓰이지 않는 엔티티예요. noise_entities에 추가하면 불필요한 정각 점검(noop)과 프롬프트 노이즈를 줄일 수 있어요.`,
				payload: { entity_id: eid, changes_7d: count },
			})
			if (candidates.filter(c => c.kind === 'self_noise_proposal').length >= 3) break
		}

		// C) 반복 암묵적 실패 → 교훈(self_lesson_proposal) 후보
		const impl = store.recentImplicitFeedback({ sinceMs: since14, limit: 300 })
		const failByKind = new Map()
		for (const r of impl) {
			if (r.score >= 0) continue
			if (!failByKind.has(r.kind)) failByKind.set(r.kind, [])
			failByKind.get(r.kind).push(r)
		}
		const existingLessons = new Set(store.listLessons({ limit: 100 }).map(l => l.key))
		for (const [fKind, list] of failByKind) {
			if (list.length < 2) continue
			const key = `lesson_${fKind}`
			if (existingLessons.has(key) || alreadyPending('self_lesson_proposal', key)) continue
			const presets = {
				assist_unexecuted_claim: ['assist', '사용자가 기기 제어를 요청했을 때', 'ha_control_device 호출 성공을 확인하기 전에는 절대 켰다/껐다고 답하지 않는다.'],
				assist_correction: ['assist', '사용자의 의도가 질문·확인인지 실행 지시인지 모호할 때', '바로 기기를 제어하지 말고 먼저 의도를 확인한다.'],
				action_reverted: ['cycle', '자율 기기 제어를 판단할 때', '최근 사람이 곧바로 되돌린 기기는 재실·사용 맥락을 더 보수적으로 확인한다.'],
				proposal_validation_failed: ['weekly', 'HA 자동화/스크립트 변경 제안을 작성할 때', '모든 참조 엔티티의 존재와 Jinja 변수 선언(variables/trigger)을 사전 점검한다.'],
			}
			const p = presets[fKind]
			if (!p) continue
			candidates.push({
				kind: 'self_lesson_proposal',
				target_id: key,
				title: `절차적 교훈 등록: ${fKind}`,
				summary: `최근 14일간 ${fKind} 실패가 ${list.length}회 반복됐어요. 교훈(Playbook)에 등록해 재발을 막을까요?`,
				payload: { key, scope: p[0], condition_text: p[1], rule_text: p[2], evidence: `${fKind} ${list.length}회 관측`, evidence_count: list.length },
			})
		}
	}

	// D) STT 실패 오디오 통계 기반 튜닝 후보(self_stt_tune)
	if (sttFailuresDir && existsSync(sttFailuresDir)) {
		try {
			const files = readdirSync(sttFailuresDir).filter(f => f.endsWith('.json')).sort().slice(-20)
			const recs = files.map(f => readJson(join(sttFailuresDir, f), null)).filter(Boolean)
			const loudEmpty = recs.filter(r => !r.text && r.stats && r.stats.peakDbfs > -30 && r.stats.activeMs >= 200)
			const maxCuts = recs.filter(r => r.endpoint?.reason === 'max')
			const noSpeech = recs.filter(r => r.endpoint?.reason === 'no_speech')
			const curEp = cfg.assist?.voice?.endpoint ?? { silence_ms: 700, max_seconds: 10, no_speech_seconds: 6 }
			if (loudEmpty.length >= 3 && !alreadyPending('self_stt_tune', 'assist.voice.endpoint')) {
				const nextSilence = Math.min(1200, (curEp.silence_ms ?? 700) + 150)
				candidates.push({
					kind: 'self_stt_tune',
					target_id: 'assist.voice.endpoint',
					title: 'STT 음성 끝 감지(silence_ms) 여유 확대',
					summary: `최근 STT 실패 ${recs.length}건 중 유음(peak > -30dBFS)인데 빈 전사가 ${loudEmpty.length}건 발생했어요. silence_ms를 ${curEp.silence_ms ?? 700}→${nextSilence}ms로 소폭 늘려 말끝 잘림을 완화할 수 있어요.`,
					payload: { endpoint: { ...curEp, silence_ms: nextSilence }, stats: { total: recs.length, loud_empty: loudEmpty.length, max_cuts: maxCuts.length, no_speech: noSpeech.length } },
				})
			} else if (maxCuts.length >= 3 && !alreadyPending('self_stt_tune', 'assist.voice.endpoint')) {
				const nextMax = Math.min(15, (curEp.max_seconds ?? 10) + 3)
				candidates.push({
					kind: 'self_stt_tune',
					target_id: 'assist.voice.endpoint',
					title: 'STT 최대 녹음 시간(max_seconds) 확대',
					summary: `최근 STT 실패 중 상한(max) 도달이 ${maxCuts.length}건이에요. max_seconds를 ${curEp.max_seconds ?? 10}→${nextMax}초로 늘리는 것을 제안해요.`,
					payload: { endpoint: { ...curEp, max_seconds: nextMax }, stats: { total: recs.length, max_cuts: maxCuts.length } },
				})
			}
		} catch {}
	}

	return candidates
}

// ── 7) 변경 실험 원장(Change Experiment Ledger) ──
// 실험 하나는 "무엇을 바꿨는지"에 맞는 신호만 비교한다(scope). 집 전체 신호로 판정하면 다른 변경·우연이 결과를 뒤집는다.
//  rule_ids   → 그 규칙 알림에 대한 🔕(mute)/🔽(less) 부정, 👍(up) 긍정
//  entity_ids → 그 엔티티의 부정 암묵적 피드백(되돌림·거절 등), 되돌리거나 거절한 행동
//  channel    → 'assist'(Assist 대화 부정 신호) | 'cycle'(자율 제어 되돌림·판단 오류·🔕/🔽) | 'proposal'(제안 거절·롤백·검증 실패)
// scope가 없으면 예전처럼 집 전체 지표를 쓰되, 아래 최소 표본·차이 기준은 똑같이 적용한다.
export const EXPERIMENT_MIN_SIGNALS = 3
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/
const CYCLE_IMPLICIT_KINDS = new Set(['action_reverted', 'action_undone', 'action_declined'])

export function lessonExperimentScope(lessonScope) {
	if (lessonScope === 'assist') return { channel: 'assist' }
	if (lessonScope === 'cycle') return { channel: 'cycle' }
	if (lessonScope === 'weekly') return { channel: 'proposal' }
	return null
}

// 적용된 관리·자가 튜닝 제안을 어떤 신호로 검증할지
export function proposalExperimentScope(p) {
	if (!p) return null
	if (p.kind === 'self_lesson_proposal') return lessonExperimentScope(p.payload?.scope)
	const ids = [...new Set([p.payload?.entity_id, p.target_id].filter(id => typeof id === 'string' && ENTITY_ID_RE.test(id)))]
	const ents = ids.length ? { entity_ids: ids } : {}
	if (p.kind === 'self_alias_proposal' || p.kind === 'self_stt_tune') return { channel: 'assist', ...ents }
	if (p.kind === 'promote_rule' && p.payload?.rule_id) return { rule_ids: [p.payload.rule_id], ...ents }
	return ids.length ? ents : null
}

function scopedSignals(store, since, now, scope) {
	const ruleIds = new Set(scope.rule_ids ?? [])
	const ents = new Set(scope.entity_ids ?? [])
	const channel = scope.channel ?? null
	const parts = {}
	const add = (k, n) => { if (n) parts[k] = (parts[k] ?? 0) + n }
	const impl = store.recentImplicitFeedback({ sinceMs: since, limit: 5000 }).filter(i => i.ts <= now && i.score < 0)
	const fbs = store.feedbackInRange(since, now + 1)
	let positive = 0
	if (ruleIds.size) {
		const mine = fbs.filter(f => (f.rules ?? []).some(r => ruleIds.has(r)))
		add('rule_mute_less', mine.filter(f => f.kind === 'mute' || f.kind === 'less').length)
		positive += mine.filter(f => f.kind === 'up').length
	}
	if (ents.size) {
		add('entity_negative_implicit', impl.filter(i => ents.has(i.entity_id)).length)
		add('entity_actions_declined', store.actionsInRange(since, now + 1).filter(a => ents.has(a.entity_id) && (a.status === 'undone' || a.status === 'declined')).length)
	}
	if (channel === 'assist') add('assist_negative', impl.filter(i => String(i.kind).startsWith('assist_')).length)
	if (channel === 'cycle') {
		add('cycle_reverted', impl.filter(i => CYCLE_IMPLICIT_KINDS.has(i.kind)).length)
		add('cycle_errors', store.decisionsInRange(since, now + 1).filter(d => !d.skipped && !d.deferred && d.error && !(d.reasons ?? []).includes('assist')).length)
		add('fb_mute_less', fbs.filter(f => f.kind === 'mute' || f.kind === 'less').length)
	}
	if (channel === 'proposal') add('proposal_negative', impl.filter(i => String(i.kind).startsWith('proposal_')).length)
	const negative = Object.values(parts).reduce((a, b) => a + b, 0)
	return { negative, positive, parts }
}

export function collectMetricsSnapshot(store, now = Date.now(), windowDays = 7, scope = null) {
	if (!store) return null
	const since = now - windowDays * DAY
	const decs = store.decisionsInRange(since, now)
	const real = decs.filter(d => !d.skipped && !d.deferred)
	const okRuns = real.filter(d => !d.error)
	const noop = okRuns.filter(d => !(d.applied?.notifications?.length || d.applied?.actions?.length || d.applied?.added?.length || d.applied?.changed?.length || d.applied?.deleted?.length || d.applied?.report)).length
	const acts = store.actionsInRange(since, now)
	const impl = store.recentImplicitFeedback({ sinceMs: since, limit: 500 })
	const fbs = store.feedbackInRange(since, now)
	const snap = {
		at: new Date(now).toISOString(),
		window_days: windowDays,
		runs: real.length,
		// Assist 요청 실패도 판단 기록에 남게 됐지만, 실험 전후 비교의 기준이 바뀌지 않게 오류 수는 정기 판단만 센다.
		errors: real.filter(d => d.error && !(d.reasons ?? []).includes('assist')).length,
		noop_pct: okRuns.length ? Math.round((noop / okRuns.length) * 1000) / 10 : 0,
		actions_undone: acts.filter(a => a.status === 'undone').length,
		actions_declined: acts.filter(a => a.status === 'declined').length,
		negative_implicit: impl.filter(i => i.score < 0).length,
		fb_mute: fbs.filter(f => f.kind === 'mute').length,
		fb_less: fbs.filter(f => f.kind === 'less').length,
	}
	if (scope && (scope.rule_ids?.length || scope.entity_ids?.length || scope.channel)) {
		snap.scope = scope
		snap.scoped = scopedSignals(store, since, now, scope)
	}
	return snap
}

const globalNegative = m => (m?.negative_implicit ?? 0) + (m?.actions_undone ?? 0) + (m?.fb_mute ?? 0) + (m?.errors ?? 0)

// 전후 지표로 판정한다. 신호가 적으면 우연과 구분할 수 없으니 'inconclusive'로 두고 아무것도 보정하지 않는다.
export function judgeExperiment(before = {}, after = {}) {
	const scoped = Boolean(before?.scoped && after?.scoped)
	const negB = scoped ? before.scoped.negative : globalNegative(before)
	const negA = scoped ? after.scoped.negative : globalNegative(after)
	const posB = scoped ? (before.scoped.positive ?? 0) : 0
	const posA = scoped ? (after.scoped.positive ?? 0) : 0
	const signals = negB + negA + posB + posA
	// 빈 호출 비율은 범위 없는(집 전체) 실험에서, 양쪽 판단이 10회 이상일 때만 본다.
	const noopComparable = !scoped && (before?.runs ?? 0) >= 10 && (after?.runs ?? 0) >= 10
	const noopDelta = Math.round(((after?.noop_pct ?? 0) - (before?.noop_pct ?? 0)) * 10) / 10
	const margin = Math.max(2, Math.ceil(negB * 0.5))
	let notes = `${scoped ? '대상 범위' : '집 전체'} 부정 신호 ${negB}→${negA}${scoped && (posB || posA) ? `, 긍정 ${posB}→${posA}` : ''}${noopComparable ? `, 빈 호출 ${before.noop_pct}%→${after.noop_pct}%` : ''}`
	let verdict = 'neutral'
	if (signals < EXPERIMENT_MIN_SIGNALS && !(noopComparable && noopDelta <= -10)) {
		verdict = 'inconclusive'
		notes += ` (신호 ${signals}건으로 판단하기에 부족: ${EXPERIMENT_MIN_SIGNALS}건 이상 필요)`
	} else if (negA - negB >= margin) {
		verdict = 'regressed'
		notes += ' (악화 감지: 롤백 또는 재조정 검토 권장)'
	} else if (negB - negA >= margin || (noopComparable && noopDelta <= -10)) {
		verdict = 'improved'
		notes += ' (개선 확인)'
	}
	return { verdict, notes, signals }
}

export function registerExperiment(store, { kind, ref_id = null, title, evalDays = 7, now = Date.now(), scope = undefined, revert = null }) {
	if (!store) return null
	// 범위를 넘기지 않으면 종류에서 짐작한다(규칙 → 그 규칙, 교훈 → 그 교훈이 쓰이는 경로).
	const resolved = scope !== undefined ? scope
		: kind === 'rule' && ref_id ? { rule_ids: [ref_id] }
			: kind === 'lesson' && ref_id ? lessonExperimentScope(store.getLesson(ref_id)?.scope)
				: null
	const baseline = collectMetricsSnapshot(store, now, 7, resolved)
	// 악화로 판정되면 되돌릴 수 있게 바꾸기 전 모습을 함께 둔다(규칙: 이전 판, 새로 만든 규칙이면 null)
	if (revert) baseline.revert = revert
	return store.upsertExperiment({
		eid: `exp_${newId()}`,
		ts: now,
		kind,
		ref_id,
		title,
		baseline_metrics: baseline,
		eval_after_ts: now + evalDays * DAY,
		status: 'active',
	})
}

export function evaluateExperiment(store, eid, now = Date.now()) {
	if (!store) return null
	const exp = store.getExperiment(eid)
	if (!exp || exp.status !== 'active') return exp
	const before = exp.baseline_metrics ?? {}
	const after = collectMetricsSnapshot(store, now, 7, before.scope ?? null)
	const { verdict, notes } = judgeExperiment(before, after)

	const updated = store.upsertExperiment({
		...exp,
		evaluated_at: now,
		after_metrics: after,
		verdict,
		notes,
		status: verdict,
	})

	// 교훈 기반 실험이면 결과에 따라 교훈 신뢰도 자동 보정(판단 보류면 그대로 둔다)
	if (exp.kind === 'lesson' && exp.ref_id && (verdict === 'improved' || verdict === 'regressed')) {
		const l = store.getLesson(exp.ref_id)
		if (l) {
			const nextConf = verdict === 'improved' ? Math.min(1, l.confidence + 0.1) : Math.max(0.1, l.confidence - 0.25)
			store.upsertLesson({ ...l, confidence: nextConf, evidence_count: l.evidence_count, now })
		}
	}
	return updated
}

export function evaluateDueExperiments(store, now = Date.now()) {
	if (!store) return []
	const due = store.listExperiments({ status: 'active', dueBefore: now, limit: 20 })
	return due.map(e => evaluateExperiment(store, e.eid, now)).filter(Boolean)
}

// reflection / weekly 프롬프트에 넣을 자가학습 요약 텍스트 조립
export function buildLearningDigest({ store, rules = [], runtime = {}, cfg = {}, states = new Map(), sttFailuresDir = P.sttFailures, now = Date.now(), isNoise = () => false } = {}) {
	if (!store) return ''
	const sections = []

	// 1) 암묵적 피드백 요약
	const impl = new ImplicitFeedbackTracker({ store }).summarize({ sinceMs: now - 14 * DAY })
	if (impl.total > 0) {
		const parts = Object.entries(impl.by_kind).map(([k, v]) => `${k}=${v}`)
		sections.push(`- 암묵적 피드백(14일): ${parts.join(', ')}${impl.top_entities.length ? ` | 빈발 대상: ${impl.top_entities.slice(0, 4).map(e => `${e.entity_id}(${e.count})`).join(', ')}` : ''}`)
	}

	// 2) 규칙 정밀도 주의 항목
	const scores = scoreRules({ rules, runtime, store, now })
	const noisy = scores.filter(s => s.grade === 'noisy' || s.grade === 'muted')
	if (noisy.length) {
		sections.push(`- 규칙 정밀도 점검 필요: ${noisy.slice(0, 5).map(s => `${s.id}(${s.grade}: ${s.suggestion})`).join(' / ')}`)
	}

	// 3) 정량 루틴 마이너 결과
	const routines = mineRoutines({ store, now, isNoise })
	if (routines.presence_routines.length) {
		sections.push(`- 통계적 출퇴근·재실 루틴: ${routines.presence_routines.slice(0, 4).map(r => `${r.entity_id} ${r.day_type} ${r.direction} 중앙 ${r.median_time}(IQR ${r.iqr_min ?? '?'}분, ${r.observed_days}/${r.total_days}일 ${r.consistency_pct}%)`).join(' / ')}`)
	}
	if (routines.device_routines.length) {
		sections.push(`- 통계적 반복 기기 조작(사람 조작 기준): ${routines.device_routines.slice(0, 5).map(r => `${r.name}(${r.entity_id}) ${r.day_type} ${r.window} ${r.direction === 'off' ? '끄기' : '켜기'} (${r.observed_days}/${r.total_days}일 ${r.consistency_pct}%)`).join(' / ')}`)
	}

	// 4) 실험 원장 결과 (최근 평가 완료 또는 대기 중)
	const exps = store.listExperiments({ limit: 8 })
	if (exps.length) {
		sections.push(`- 변경 사후 검증(실험): ${exps.slice(0, 4).map(e => `[${e.status}] ${e.title}${e.notes ? ` — ${e.notes}` : ''}`).join(' / ')}`)
	}

	// 5) 자가 튜닝 제안 후보
	const selfCands = generateSelfProposals({ store, cfg, rules, states, sttFailuresDir, now })
	if (selfCands.length) {
		sections.push(`- 자가 튜닝 제안 후보(Tier 2 proposals로 제안 가능): ${selfCands.slice(0, 5).map(c => `(${c.kind}) ${c.title}`).join(' / ')}`)
	}

	return sections.join('\n')
}
