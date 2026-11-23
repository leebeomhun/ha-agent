// 기기 제어 실행기: 정책 평가, 승인 요청, 상태 변화 확인, 되돌리기(Undo) 및 버튼 처리
import { approvalPayload, actionResultPayload } from '../notify.mjs'
import { reached } from '../actions.mjs'
import { loadControl } from '../config.mjs'
import { scriptFieldsText } from '../core/policy.mjs'
import { DAY, newId, log } from '../util.mjs'

const MIN = 60000
const iso = ms => new Date(ms).toISOString()

export class ActionExecutor {
	constructor(agent) {
		this.agent = agent
	}

	isAwayOverrideOn() {
		const id = this.agent.cfg.away_override_entity
		return Boolean(id && this.agent.states.get(id)?.state === 'on')
	}

	actionContext() {
		const a = this.agent
		if (!a.tiers.size) return null
		const c = a.todayCounters(), since = a.clock() - 7 * DAY
		return {
			today: c.actions, perDay: a.cfg.actions.per_day, onRequest: !!a.cfg.actions.on_request,
			adminEnabled: Boolean(a.cfg.policy?.admin_enabled),
			tiers: [...a.tiers].map(([id, tier]) => ({ id, tier, name: a.states.get(id)?.attributes?.friendly_name, state: a.states.get(id)?.state ?? '없음', ...(id.startsWith('script.') ? { fields: a.meta.scriptFields?.has(id) ? scriptFieldsText(a.meta.scriptFields.get(id)) || '받는 값 없음' : '설정을 아직 받지 못해 실행 불가' } : {}) })),
			recent: a.journal.actions({ sinceMs: since, limit: 10 }),
		}
	}

	async executeControlItem(x, { byUser = false } = {}) {
		const ag = this.agent
		const a = ag.cfg.actions
		const direct = Boolean(a.on_request && byUser && x.requested === true)
		// 스크립트는 받는 필드를 알아야 안전하게 부를 수 있다(필드 없이 부르면 반대로 동작할 수 있음).
		if (typeof x.entity_id === 'string' && x.entity_id.startsWith('script.') && ag.tiers.has(x.entity_id)) await ag.loadScriptFields?.([x.entity_id])
		const v = ag.policy.evaluateControl(x, {
			states: ag.states,
			quiet: direct ? false : ag.isQuiet(),
			usedToday: ag.todayCounters().actions,
			perDay: a.per_day,
			pending: ag.pendingActs,
			awayOverrideOn: this.isAwayOverrideOn(),
			requested: direct,
			scriptFields: ag.meta.scriptFields,
		})
		if (!v.ok) return { ok: false, status: 'rejected', error: v.error }
		if (v.noop) return { ok: true, status: 'noop' }
		const st = ag.states.get(x.entity_id)
		const rec = {
			aid: newId(), ts: iso(ag.clock()), entity_id: x.entity_id,
			name: st.attributes?.friendly_name ?? x.entity_id,
			action: v.service, domain: v.domain, service: v.service,
			...(Object.keys(v.service_data ?? {}).length ? { service_data: v.service_data } : {}),
			reason: x.reason, tier: v.tier, prev: st.state,
			prev_snapshot: ag.policy.captureSnapshot(st),
		}
		if (direct) rec.requested = true
		if (!ag.control.send) {
			rec.status = 'test_mode'
			ag.journal.action(rec)
		} else if (v.tier === 'auto' || direct) {
			await this.execute(rec)
		} else {
			await this.askApproval(rec)
		}
		return { ok: true, status: rec.status, rec }
	}

	// used: 이번 판단에서 도구로 이미 쓴 행동 수(한도 per_cycle을 함께 쓴다)
	async applyActions(list, out, reasons = [], { used = 0 } = {}) {
		const a = this.agent.cfg.actions, results = []
		const byUser = reasons.some(r => r.type === 'user')
		for (const [i, x] of list.entries()) {
			const label = `${x.entity_id} ${x.action}`
			if (i + used >= a.per_cycle) { out.rejected.push({ action: label, error: `행동은 한 번에 ${a.per_cycle}개까지` }); continue }
			const r = await this.executeControlItem(x, { byUser })
			if (!r.ok) { out.rejected.push({ action: label, error: r.error }); continue }
			if (r.status === 'noop') { results.push(`noop: ${label} (이미 그 상태)`); continue }
			results.push(`${r.status}: ${label}`)
		}
		return results
	}

	async execute(rec, { undo = false, overrideService = null } = {}) {
		const ag = this.agent
		const domain = overrideService?.domain ?? rec.domain ?? rec.entity_id.split('.')[0]
		const service = overrideService?.service ?? rec.service ?? rec.action
		const data = overrideService?.data ?? rec.service_data ?? {}
		// 호출 전 상태를 잡아 둔다. 상태 변화 이벤트가 호출 응답보다 먼저 오면 호출 뒤에 잡은 값으로는 변화를 놓친다.
		const before = ag.states.get(rec.entity_id)
		try {
			await ag.ha.callService(domain, service, { ...(Object.keys(data).length ? { data } : {}), target: { entity_id: rec.entity_id } })
			rec.status = (await this.waitState(rec.entity_id, service, data, before)) ? 'done' : 'unverified'
			ag.bump(undo ? 'undos' : 'actions')
		} catch (e) { rec.status = 'error'; rec.error = e.message }
		rec.done_at = iso(ag.clock())
		ag.journal.action(rec)
		log(`행동 ${rec.status}: ${rec.name} ${service} — ${rec.reason}`)
		const shown = undo && rec.status === 'done' ? { ...rec, status: 'undone' } : rec
		const undoable = !undo && rec.status !== 'error' && Boolean(ag.policy.buildUndoCall(rec))
		await ag.notifier.send(actionResultPayload(shown, { undo: undoable })).catch(() => {})
		return rec
	}

	// 명령이 먹었는지 확인한다. before: 호출 전 상태.
	// script/scene은 켜짐 상태로 남지 않는다(스크립트는 금방 끝나고, scene의 상태는 마지막 실행 시각) → 실행 흔적이 바뀌었는지로 본다.
	async waitState(id, action, data = {}, before = this.agent.states.get(id)) {
		const ag = this.agent
		const until = Date.now() + ag.cfg.actions.verify_seconds * 1000
		const prevUpdated = before?.last_updated
		const domain = String(id).split('.')[0]
		const ran = domain === 'script' || domain === 'scene'
		for (;;) {
			const st = ag.states.get(id)
			if (ran) {
				if (st && (st.last_updated !== prevUpdated || st.state !== before?.state
					|| st.attributes?.last_triggered !== before?.attributes?.last_triggered)) return true
				if (Date.now() >= until) return false
			} else if (action === 'turn_on' || action === 'turn_off') {
				if (reached(action, st?.state)) return true
			} else if (action === 'select_option' && data.option != null) {
				if (st?.state === String(data.option)) return true
			} else if (action === 'set_value' && data.value != null) {
				if (Number(st?.state) === Number(data.value)) return true
			} else if (st?.last_updated && st.last_updated !== prevUpdated) {
				return true
			}
			if (Date.now() >= until) return !(action === 'turn_on' || action === 'turn_off')
			await new Promise(r => setTimeout(r, 250))
		}
	}

	async askApproval(rec) {
		const ag = this.agent
		const minutes = ag.cfg.actions.approval_minutes
		rec.expires = ag.clock() + minutes * MIN
		if (ag.todayCounters().alerts >= ag.cfg.limits.alerts_per_day) { rec.status = 'error'; rec.error = '오늘 알림 한도에 닿아 승인 요청을 못 보냄' }
		else {
			try {
				await ag.notifier.send(approvalPayload(rec, minutes))
				rec.status = 'pending'
				ag.pendingActs.push(rec)
				ag.bump('alerts')
			} catch (e) { rec.status = 'error'; rec.error = e.message }
		}
		ag.journal.action(rec)
		log(`행동 승인 요청 ${rec.status}: ${rec.name} ${rec.action} — ${rec.reason}`)
	}

	async onActionButton(kind, aid) {
		const ag = this.agent
		if (!ag.dry) ag.control = loadControl()
		if (ag.control.paused && (kind === 'DO' || kind === 'UNDO')) {
			log(`일시정지 중이라 행동 버튼(${kind})을 실행하지 않음:`, aid)
			return
		}
		if (ag.actingAids.has(aid)) return log('버튼: 이미 처리 중인 행동', aid)
		ag.actingAids.add(aid)
		try {
			const now = ag.clock()
			const rec = ag.journal.getAction(aid)
			if (!rec) return log('버튼: 행동 기록을 찾지 못함', aid)
			const close = async (status, extra = {}) => {
				const r = { ...rec, ...extra, status, decided_at: iso(now) }
				ag.journal.action(r)
				log(`행동 ${status}: ${rec.name} ${rec.action}`)
				await ag.notifier.send(actionResultPayload(r)).catch(() => {})
			}
			if (kind === 'UNDO') {
				if (!['done', 'unverified'].includes(rec.status) || rec.undo_of) return
				const undoCall = ag.policy.buildUndoCall(rec)
				if (!undoCall) return log('되돌리기: 지원하지 않는 반대 행동', `${rec.entity_id} ${rec.action}`)
				if (!ag.tiers.has(rec.entity_id)) return log('되돌리기: 허용 목록에서 빠진 엔티티', rec.entity_id)
				const res = await this.execute({
					aid: newId(), ts: iso(now), entity_id: rec.entity_id, name: rec.name,
					domain: undoCall.domain, service: undoCall.service, action: undoCall.service,
					...(Object.keys(undoCall.data ?? {}).length ? { service_data: undoCall.data } : {}),
					reason: `되돌리기: ${rec.reason}`.slice(0, 200), tier: rec.tier, undo_of: aid,
				}, { undo: true, overrideService: undoCall })
				if (res.status !== 'error') {
					const updated = { ...rec, status: 'undone', decided_at: iso(now) }
					ag.journal.action(updated)
				}
				return
			}
			if (rec.status !== 'pending' || !ag.pendingActs.some(p => p.aid === aid)) return
			ag.pendingActs = ag.pendingActs.filter(p => p.aid !== aid)
			if (kind === 'NO') return close('declined')
			if (now > rec.expires) return close('expired')
			if (typeof rec.entity_id === 'string' && rec.entity_id.startsWith('script.')) await ag.loadScriptFields?.([rec.entity_id])
			const v = ag.policy.evaluateControl(rec, {
				states: ag.states, quiet: false, usedToday: ag.todayCounters().actions,
				perDay: ag.cfg.actions.per_day, awayOverrideOn: false, requested: true,
				scriptFields: ag.meta.scriptFields,
			})
			if (!v.ok) return close('error', { error: v.error })
			if (v.noop) return close('done')
			await this.execute({ ...rec })
		} finally {
			ag.actingAids.delete(aid)
		}
	}

	async expireActions(now) {
		const ag = this.agent
		const old = ag.pendingActs.filter(p => now > p.expires)
		if (ag.dry || !old.length) return
		ag.pendingActs = ag.pendingActs.filter(p => !old.includes(p))
		for (const p of old) {
			const r = { ...p, status: 'expired', decided_at: iso(now) }
			ag.journal.action(r)
			log(`행동 승인 시간 지남: ${p.name} ${p.action}`)
			if (ag.ha.connected) await ag.notifier.send(actionResultPayload(r)).catch(() => {})
		}
	}
}
