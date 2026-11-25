// 자기 성능 지표(스코어카드): "지난주보다 나아졌나"를 숫자로 본다. 주 단위로 나눠 최근 주와 그 전 주를 비교한다.
// 모든 값은 SQLite 기록에서 다시 계산한다(따로 저장하지 않음). 표본이 없으면 null(판단 보류)로 둔다.
import { DAY } from '../util.mjs'

const WEEK = 7 * DAY
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)

// 지표 정의: key, 이름, 좋아지는 방향(up: 클수록 좋음, down: 작을수록 좋음)
export const SCORE_METRICS = [
	['alert_useful_pct', '알림 뒤 조치 비율(%)', 'up'],
	['proposal_accept_pct', '제안 수락률(%)', 'up'],
	['assist_success_pct', 'Assist 성공률(%)', 'up'],
	['noop_pct', '빈 판단 비율(%)', 'down'],
	['avg_tokens', '판단당 토큰', 'down'],
	['errors', '판단 오류', 'down'],
	['automation_overrides', '자동화를 사람이 뒤집은 횟수', 'down'],
	['agent_reverts', '집 비서 제어를 사람이 되돌린 횟수', 'down'],
]

function weekStats(store, start, end) {
	const decs = store.decisionsInRange(start, end)
	const cycles = decs.filter(d => !d.skipped && !d.deferred && !(d.reasons ?? []).includes('assist'))
	const okCycles = cycles.filter(d => !d.error)
	const noop = okCycles.filter(d => !(d.applied?.notifications?.length || d.applied?.actions?.length || d.applied?.added?.length || d.applied?.changed?.length || d.applied?.deleted?.length || d.applied?.proposals?.length || d.applied?.report)).length
	const tokenRuns = cycles.filter(d => Number.isFinite(d.tokens))
	const assistTurns = decs.filter(d => (d.reasons ?? []).includes('assist')).length

	const impl = store.recentImplicitFeedback({ sinceMs: start, limit: 5000 }).filter(i => i.ts < end)
	const count = kind => impl.filter(i => i.kind === kind).length
	const assistNeg = impl.filter(i => String(i.kind).startsWith('assist_') && i.score < 0).length

	const notes = store.notificationsInRange(start, end)
	const alerts = notes.filter(n => n.kind === 'alert' && ['sent', 'queued'].includes(n.status)).length
	const fb = store.feedbackInRange(start, end)

	const props = store.listProposals({ limit: 1000 }).filter(p => p.ts >= start && p.ts < end)
	const accepted = props.filter(p => ['applied', 'rolled_back', 'rollback_failed', 'interrupted', 'applying'].includes(p.status)).length
	const rejected = props.filter(p => p.status === 'rejected').length
	const ignored = props.filter(p => p.status === 'expired').length
	const decided = accepted + rejected + ignored

	return {
		from: new Date(start).toISOString().slice(0, 10),
		to: new Date(end - 1).toISOString().slice(0, 10),
		cycles: cycles.length,
		errors: cycles.filter(d => d.error).length,
		noop_pct: pct(noop, okCycles.length),
		avg_tokens: tokenRuns.length ? Math.round(tokenRuns.reduce((a, d) => a + d.tokens, 0) / tokenRuns.length) : null,
		assist_turns: assistTurns,
		assist_negative: assistNeg,
		assist_success_pct: assistTurns ? Math.max(0, pct(assistTurns - assistNeg, assistTurns)) : null,
		alerts,
		alerts_acted: count('notification_acted'),
		alert_feedback_negative: fb.filter(f => f.kind === 'mute' || f.kind === 'less').length,
		alert_useful_pct: alerts ? pct(Math.min(count('notification_acted'), alerts), alerts) : null,
		proposals_created: props.length,
		proposals_accepted: accepted,
		proposals_rejected: rejected,
		proposals_ignored: ignored,
		proposal_accept_pct: decided ? pct(accepted, decided) : null,
		automation_overrides: count('automation_overridden'),
		agent_reverts: count('action_reverted') + count('action_undone'),
		user_automation_edits: count('automation_user_edited'),
	}
}

export function buildScorecard({ store, now = Date.now(), weeks = 4, regression = null } = {}) {
	if (!store) return null
	const list = []
	for (let w = 0; w < weeks; w++) list.push(weekStats(store, now - (w + 1) * WEEK, now - w * WEEK))
	const [latest, previous] = list
	const trends = SCORE_METRICS.map(([key, label, dir]) => {
		const a = latest?.[key], b = previous?.[key]
		let better = null
		if (a != null && b != null && a !== b) better = dir === 'up' ? a > b : a < b
		return { key, label, latest: a ?? null, previous: b ?? null, better }
	})
	return {
		at: new Date(now).toISOString(),
		weeks: list,
		trends,
		improved: trends.filter(t => t.better === true).map(t => t.key),
		worsened: trends.filter(t => t.better === false).map(t => t.key),
		regression,
	}
}

// 주간 보고서·CLI용 마크다운 표
export function renderScorecard(sc) {
	if (!sc) return ''
	const fmt = v => (v == null ? '–' : String(v))
	const arrow = t => (t.better === true ? '▲ 좋아짐' : t.better === false ? '▼ 나빠짐' : '–')
	const lines = [
		`| 지표 | 최근 7일 | 그 전 7일 | 변화 |`,
		`|---|---|---|---|`,
		...sc.trends.map(t => `| ${t.label} | ${fmt(t.latest)} | ${fmt(t.previous)} | ${arrow(t)} |`),
	]
	const w = sc.weeks[0] ?? {}
	lines.push('', `최근 7일: 판단 ${w.cycles ?? 0}회, Assist ${w.assist_turns ?? 0}턴, 알림 ${w.alerts ?? 0}건(뒤이은 조치 ${w.alerts_acted ?? 0}건, 🔕/🔽 ${w.alert_feedback_negative ?? 0}건), 제안 ${w.proposals_created ?? 0}건(수락 ${w.proposals_accepted ?? 0}·거절 ${w.proposals_rejected ?? 0}·무시 ${w.proposals_ignored ?? 0}), 사용자의 자동화 직접 수정 ${w.user_automation_edits ?? 0}건.`)
	if (sc.regression) lines.push(`Assist 빠른 경로 회귀 평가: ${sc.regression.passed}/${sc.regression.total} 통과${sc.regression.failed?.length ? ` (실패: ${sc.regression.failed.slice(0, 3).map(f => `"${f.text}"`).join(', ')})` : ''}.`)
	return lines.join('\n')
}
