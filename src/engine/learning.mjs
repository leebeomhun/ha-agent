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

const MIN = 60000
const CORRECTION_RE = /(아니야|아니[,.\s]|그게\s*아니|취소해|왜\s*껐|왜\s*켰|잘못\s*(?:껐|켰|바꿨|알아)|다시\s*원래대로|그만해)/
const ROUTINE_DOMAINS = new Set(['light', 'switch', 'media_player', 'fan', 'climate', 'input_boolean', 'cover'])
const ACTIVE_STATES = new Set(['on', 'playing', 'open', 'heat', 'cool', 'auto'])

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

	// 에이전트 제어 후 15분 이내에 사람이 이전 상태로 되돌렸는지 실시간 감지
	onStateEvent(change, { now = Date.now(), windowMs = 15 * MIN } = {}) {
		if (!change?.id) return null
		const tracked = this.recentControls.get(change.id)
		if (!tracked) return null
		if (now - tracked.ts > windowMs) {
			this.recentControls.delete(change.id)
			return null
		}
		// 제어 직후 3초 이내의 바운스는 무시
		if (now - tracked.ts < 3000) return null
		if (String(change.to) === tracked.prevState && String(change.from) === tracked.toState) {
			this.recentControls.delete(change.id)
			const rec = {
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
				},
			}
			this.store?.recordImplicitFeedback(rec)
			return rec
		}
		return null
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

	// B) 반복 기기 활성화 루틴 (30분 슬롯 단위)
	const devSlots = new Map() // `${id}|${dayType}|${slot30}` -> { name, dates: Set }
	for (const e of events) {
		const dom = e.id.split('.')[0]
		if (!ROUTINE_DOMAINS.has(dom) || isNoise(e.id)) continue
		if (!ACTIVE_STATES.has(e.to)) continue
		const dt = dayTypeOf(e.t)
		const k = kst(new Date(e.t))
		const slot = Math.floor((k.h * 60 + k.mi) / 30)
		const key = `${e.id}|${dt}|${slot}`
		let rec = devSlots.get(key)
		if (!rec) { rec = { entity_id: e.id, name: e.name ?? e.id, day_type: dt, slot, dates: new Set() }; devSlots.set(key, rec) }
		rec.dates.add(k.date)
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
		device_routines: device_routines.slice(0, 15),
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
export function collectMetricsSnapshot(store, now = Date.now(), windowDays = 7) {
	if (!store) return null
	const since = now - windowDays * DAY
	const decs = store.decisionsInRange(since, now)
	const real = decs.filter(d => !d.skipped && !d.deferred)
	const okRuns = real.filter(d => !d.error)
	const noop = okRuns.filter(d => !(d.applied?.notifications?.length || d.applied?.actions?.length || d.applied?.added?.length || d.applied?.changed?.length || d.applied?.deleted?.length || d.applied?.report)).length
	const acts = store.actionsInRange(since, now)
	const impl = store.recentImplicitFeedback({ sinceMs: since, limit: 500 })
	const fbs = store.feedbackInRange(since, now)
	return {
		at: new Date(now).toISOString(),
		window_days: windowDays,
		runs: real.length,
		errors: real.filter(d => d.error).length,
		noop_pct: okRuns.length ? Math.round((noop / okRuns.length) * 1000) / 10 : 0,
		actions_undone: acts.filter(a => a.status === 'undone').length,
		actions_declined: acts.filter(a => a.status === 'declined').length,
		negative_implicit: impl.filter(i => i.score < 0).length,
		fb_mute: fbs.filter(f => f.kind === 'mute').length,
		fb_less: fbs.filter(f => f.kind === 'less').length,
	}
}

export function registerExperiment(store, { kind, ref_id = null, title, evalDays = 7, now = Date.now() }) {
	if (!store) return null
	const baseline = collectMetricsSnapshot(store, now, 7)
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
	const after = collectMetricsSnapshot(store, now, 7)
	const before = exp.baseline_metrics ?? {}

	const negBefore = (before.negative_implicit ?? 0) + (before.actions_undone ?? 0) + (before.fb_mute ?? 0) + (before.errors ?? 0)
	const negAfter = (after.negative_implicit ?? 0) + (after.actions_undone ?? 0) + (after.fb_mute ?? 0) + (after.errors ?? 0)
	const noopDelta = (after.noop_pct ?? 0) - (before.noop_pct ?? 0)

	let verdict = 'neutral'
	let notes = `부정 신호 ${negBefore}→${negAfter}, 빈 호출(noop) ${before.noop_pct ?? 0}%→${after.noop_pct ?? 0}%`
	if (negAfter > negBefore + 1 || (after.errors ?? 0) > (before.errors ?? 0) + 1) {
		verdict = 'regressed'
		notes += ' (악화 감지: 롤백 또는 재조정 검토 권장)'
	} else if (negAfter < negBefore || noopDelta <= -5) {
		verdict = 'improved'
		notes += ' (개선 확인)'
	}

	const updated = store.upsertExperiment({
		...exp,
		evaluated_at: now,
		after_metrics: after,
		verdict,
		notes,
		status: verdict,
	})

	// 교훈 기반 실험이면 결과에 따라 교훈 신뢰도 자동 보정
	if (exp.kind === 'lesson' && exp.ref_id) {
		const l = store.getLesson(exp.ref_id)
		if (l) {
			const nextConf = verdict === 'improved' ? Math.min(1, l.confidence + 0.1)
				: verdict === 'regressed' ? Math.max(0.1, l.confidence - 0.25) : l.confidence
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
		sections.push(`- 통계적 반복 기기 조작: ${routines.device_routines.slice(0, 5).map(r => `${r.name}(${r.entity_id}) ${r.day_type} ${r.window} (${r.observed_days}/${r.total_days}일 ${r.consistency_pct}%)`).join(' / ')}`)
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
