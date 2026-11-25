// 상태 변화를 "누가" 일으켰는지 가린다: 사람(앱·UI), 기기 자체(벽 스위치·리모컨 등 물리 조작), HA 자동화, 집 비서(에이전트).
// HA 상태의 context(id·parent_id·user_id)와 automation_triggered 이벤트, 집 비서가 부른 서비스 호출의 context를 맞춰 본다.
//
// - 집 비서: 집 비서가 부른 서비스 호출의 context.id와 같다(또는 그 직후 같은 기기가 같은 값으로 바뀜).
// - 자동화: automation_triggered로 알려진 실행 context이거나, parent_id가 있다(다른 일이 이어서 일으킨 변화).
// - 사람: user_id가 있다(앱·대시보드·음성 등 로그인한 사용자가 직접 부른 서비스).
// - 기기: 위 어느 것도 아니다(벽 스위치·리모컨·HomeKit 등 기기 쪽에서 바뀜). 켜고 끄는 기기라면 사람이 손으로 한 것으로 본다.

export const HUMAN_ORIGINS = new Set(['user', 'device'])
// 사람이 켜고 끄는 기기(센서 값 변화는 사람 조작이 아니다)
export const CONTROLLABLE_DOMAINS = new Set(['light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'input_boolean', 'humidifier', 'lock', 'vacuum', 'select', 'input_select', 'number', 'input_number'])

export class OriginTracker {
	constructor({ ttlMs = 30 * 60000, agentMatchMs = 15000, max = 500 } = {}) {
		this.ttlMs = ttlMs
		this.agentMatchMs = agentMatchMs
		this.max = max
		this.automationCtx = new Map() // context id → { automation, ts }
		this.agentCtx = new Map() // context id → { entity_id, ts }
		this.agentRecent = new Map() // entity_id → { to, ts } (응답의 context를 못 받았을 때 대비)
	}

	#trim(map, now) {
		if (map.size <= this.max) return
		for (const [k, v] of map) {
			if (now - v.ts > this.ttlMs || map.size > this.max) map.delete(k)
			else break
		}
	}

	// HA automation_triggered 이벤트(event.data.entity_id, event.context.id)
	noteAutomationTriggered(event, now = Date.now()) {
		const ctxId = event?.context?.id
		const automation = event?.data?.entity_id
		if (!ctxId || !automation) return
		this.automationCtx.set(ctxId, { automation, ts: now })
		this.#trim(this.automationCtx, now)
	}

	// 집 비서가 서비스를 부른 직후. result는 HA call_service 응답({ context: {...} }).
	noteAgentCall(entityId, toState, result, now = Date.now()) {
		const ctxId = result?.context?.id
		if (ctxId) {
			this.agentCtx.set(ctxId, { entity_id: entityId, ts: now })
			this.#trim(this.agentCtx, now)
		}
		if (entityId) this.agentRecent.set(entityId, { to: toState ?? null, ts: now })
	}

	// HA 상태 객체(new_state)를 받아 { origin, actor }를 돌려준다. actor: 자동화 entity_id 또는 사용자 id.
	classify(newState, now = Date.now()) {
		const ctx = newState?.context ?? {}
		const id = newState?.entity_id
		if (ctx.id && this.agentCtx.has(ctx.id)) return { origin: 'agent', actor: null }
		const auto = (ctx.id && this.automationCtx.get(ctx.id)) || (ctx.parent_id && this.automationCtx.get(ctx.parent_id))
		if (auto) return { origin: 'automation', actor: auto.automation }
		const recent = id ? this.agentRecent.get(id) : null
		if (recent && now - recent.ts <= this.agentMatchMs && (recent.to == null || String(recent.to) === String(newState?.state))) {
			this.agentRecent.delete(id)
			return { origin: 'agent', actor: null }
		}
		if (ctx.parent_id) return { origin: 'automation', actor: null }
		if (ctx.user_id) return { origin: 'user', actor: ctx.user_id }
		return { origin: 'device', actor: null }
	}
}

// 사람이 한 조작인가. origin이 없는 예전 기록은 판단할 수 없으니 null.
export function isHumanChange(change) {
	if (!change?.origin) return null
	return HUMAN_ORIGINS.has(change.origin) && CONTROLLABLE_DOMAINS.has(String(change.id ?? '').split('.')[0])
}

// HA logbook 항목의 조작 주체(과거 기록의 주체를 되짚을 때. 녹화 보관 기간 안에서만 있다)
export function logbookOrigin(row) {
	if (!row) return 'unknown'
	if (row.context_event_type === 'automation_triggered' || ['automation', 'script'].includes(row.context_domain) && row.context_event_type !== 'call_service') return 'automation'
	if (row.context_event_type === 'call_service') return row.context_user_id ? 'user' : 'automation'
	if (row.context_user_id) return 'user'
	return 'device'
}
