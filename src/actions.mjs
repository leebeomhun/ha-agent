// 행동(기기 제어) 호환 계층: PolicyEngine을 감싸 기존 checkAction·actionTiers·opposite·reached 계약을 유지한다.
import { PolicyEngine } from './core/policy.mjs'

export const opposite = a => (a === 'turn_on' ? 'turn_off' : 'turn_on')
export const reached = (action, state) => (action === 'turn_on' ? state === 'on' : action === 'turn_off' ? ['off', 'standby'].includes(state) : false)

export function actionTiers(cfg) {
	return new PolicyEngine(cfg).tiersMap()
}

// 돌려주는 값: { ok: false, error } | { ok: true, noop: true } | { ok: true, tier }
export function checkAction(a, { tiers, states, quiet, usedToday, perDay, pending = [], awayOverrideOn = false, requested = false, policy = null }) {
	const engine = policy ?? new PolicyEngine({ actions: { enabled: tiers.size > 0, auto: [...tiers].filter(([, t]) => t === 'auto').map(([id]) => id), confirm: [...tiers].filter(([, t]) => t === 'confirm').map(([id]) => id) } })
	const r = engine.evaluateControl(a, { states, quiet, usedToday, perDay, pending, awayOverrideOn, requested })
	if (!r.ok) return { ok: false, error: r.error }
	if (r.noop) return { ok: true, noop: true }
	return { ok: true, tier: r.tier }
}
