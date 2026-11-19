// 행동(기기 켜기/끄기) 검사. AI가 낸 행동은 여기서 걸러진 뒤에만 실행되거나 승인 요청으로 나간다.
// 허용 엔티티는 사용자가 config.json의 actions.auto / actions.confirm에 직접 적은 것뿐이다.
import { ACTION_SERVICES } from './ha.mjs'

const DEAD = new Set(['unavailable', 'unknown'])
export const opposite = a => (a === 'turn_on' ? 'turn_off' : 'turn_on')
export const reached = (action, state) => (action === 'turn_on' ? state === 'on' : ['off', 'standby'].includes(state))

// 설정에서 엔티티별 등급을 만든다. 양쪽에 다 적혀 있으면 더 조심스러운 confirm이 이긴다.
export function actionTiers(cfg) {
	const a = cfg.actions ?? {}
	if (!a.enabled) return new Map()
	const ok = id => typeof id === 'string' && ACTION_SERVICES[id.split('.')[0]]
	return new Map([...(a.auto ?? []).filter(ok).map(id => [id, 'auto']), ...(a.confirm ?? []).filter(ok).map(id => [id, 'confirm'])])
}

// 돌려주는 값: { ok: false, error } | { ok: true, noop: true } | { ok: true, tier }
export function checkAction(a, { tiers, states, quiet, usedToday, perDay, pending = [] }) {
	if (!tiers.size) return { ok: false, error: '행동 권한이 꺼져 있다(알림만 가능)' }
	const tier = tiers.get(a.entity_id)
	if (!tier) return { ok: false, error: '허용 목록에 없는 엔티티' }
	const domain = a.entity_id.split('.')[0]
	if (!(ACTION_SERVICES[domain] ?? []).includes(a.action)) return { ok: false, error: `${domain}에는 ${a.action}을 쓸 수 없다` }
	const st = states.get(a.entity_id)
	if (!st) return { ok: false, error: '없는 엔티티' }
	if (DEAD.has(st.state)) return { ok: false, error: `엔티티가 ${st.state} 상태라 움직일 수 없다` }
	if (reached(a.action, st.state)) return { ok: true, noop: true }
	if (usedToday >= perDay) return { ok: false, error: `오늘 행동 한도(${perDay}회)에 닿았다` }
	if (pending.some(p => p.entity_id === a.entity_id)) return { ok: false, error: '같은 엔티티의 승인 요청이 이미 기다리는 중' }
	// 밤에는 끄는 것만 스스로 한다. 켜는 것과 승인 요청(알림)은 아침으로 미룬다.
	if (quiet && (tier === 'confirm' || a.action === 'turn_on')) return { ok: false, error: '조용한 시간에는 스스로 끄는 것만 된다. 필요하면 아침으로 예약할 것' }
	return { ok: true, tier }
}
