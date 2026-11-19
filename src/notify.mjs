// 휴대폰 알림 모양. 안드로이드는 채널로 소리를 나누고(채널 중요도는 처음 생길 때만 적용), iOS는 interruption-level을 본다.
// 기존 HA 자동화의 '집 확인'/'집 안내' 채널과 겹치지 않게 '집 비서' 채널을 따로 쓴다.
const ICON = 'mdi:robot-happy-outline'
export const CHANNELS = {
	urgent: { channel: '집 비서 긴급', importance: 'high', priority: 'high', ttl: 0, push: { 'interruption-level': 'time-sensitive' } },
	normal: { channel: '집 비서', importance: 'default', push: { 'interruption-level': 'active' } },
	quiet: { channel: '집 비서 요약', importance: 'low', push: { 'interruption-level': 'passive' } },
}
// 버튼 action 이름은 기존 자동화(HOME_*, LATE_* 등)와 겹치지 않게 HAAGENT_ 로 시작한다.
// UP·MUTE는 알림 피드백, LESS는 정각 요약의 [줄여 줘], DO·NO는 행동 승인, UNDO는 행동 되돌리기.
export const ACTION_RE = /^HAAGENT_(UP|MUTE|LESS|DO|NO|UNDO)_([a-z0-9]+)$/
// 안드로이드 앱의 답장 입력 버튼은 action 이름이 반드시 REPLY여야 한다. 우리 알림인지는 tag로 가린다.
export const REPLY_ACTION = 'REPLY'
export const TAG_PREFIX = 'haagent-'

// 안드로이드 앱은 message가 이 문구들과 같으면 알림을 띄우지 않고 기기 명령으로 처리한다.
const RESERVED_RE = /^(command_\w+|clear_notification|remove_channel|request_location_update|tts)$/i
export const isReservedMessage = m => RESERVED_RE.test(String(m ?? '').trim())

export function tagFor(n, nid) {
	if (n.kind === 'hourly_summary') return `${TAG_PREFIX}summary`
	return `${TAG_PREFIX}${n.related_rule_ids?.[0] ?? nid}`
}

const replyButton = { action: REPLY_ACTION, title: '답장', behavior: 'textInput' }

export function buildPayload(n, nid, { reply = true } = {}) {
	const feedback = n.kind === 'alert' || n.kind === 'info'
	// 정각 요약에는 [줄여 줘]만 단다. 알림 대부분이 요약이라, 이 버튼이 없으면 돌아보기가 요약이 과한지 알 길이 없다.
	const actions = [
		...(feedback ? [{ action: `HAAGENT_UP_${nid}`, title: '도움됐어요' }, { action: `HAAGENT_MUTE_${nid}`, title: '이건 그만' }] : []),
		...(n.kind === 'hourly_summary' ? [{ action: `HAAGENT_LESS_${nid}`, title: '줄여 줘' }] : []),
		...(reply ? [replyButton] : []),
	]
	return {
		title: n.title,
		message: n.message,
		data: {
			tag: tagFor(n, nid),
			group: 'ha-agent',
			notification_icon: ICON,
			...CHANNELS[n.level],
			...(actions.length ? { actions, action_data: { nid } } : {}),
		},
	}
}

// 버튼을 누르면 같은 tag로 다시 보내 결과 문구로 바꾼다(삼성 휴대폰은 눌러도 알림이 남기 때문).
export function feedbackPayload(rec, kind, mutedDescriptions = [], muteDays = 7) {
	const mark = { UP: '👍', MUTE: '🔕', LESS: '🔽', REPLY: '💬', PAUSED: '⏸️' }[kind] ?? '🤖'
	const message = kind === 'UP' ? '고마워요. 이런 알림은 계속 보낼게요.'
		: kind === 'REPLY' ? '답장을 받았어요. 확인하고 다시 알려 드릴게요.'
		: kind === 'PAUSED' ? '지금은 집 비서가 일시정지 중이라 답장을 처리하지 않았어요. 재개한 뒤 다시 말씀해 주세요.'
		: kind === 'LESS' ? '알겠어요. 이런 요약은 줄일게요.'
			: mutedDescriptions.length
				? `알겠어요. "${mutedDescriptions.join('", "')}" 알림은 ${muteDays}일 동안 쉬고, 밤에 규칙을 다시 손볼게요.`
				: '알겠어요. 이런 알림은 줄이도록 밤에 규칙을 다시 손볼게요.'
	return {
		title: `${mark} ${rec.title}`.slice(0, 70),
		message,
		data: { tag: rec.tag, group: 'ha-agent', notification_icon: ICON, ...CHANNELS[rec.level] ?? CHANNELS.normal, alert_once: true },
	}
}

// HA의 '집 비서 - 응답 없음 경고'(ha/heartbeat-automation.yaml)와 같은 tag. 신호가 돌아오면 그 경고를 이 문구로 바꾼다.
export const HEARTBEAT_TAG = 'haagent-heartbeat'
export function recoveredPayload(from, to, fmt) {
	const minutes = Math.round((to - from) / 60000)
	return {
		title: '✅ 집 비서가 다시 연결됐어요',
		message: `${fmt(from)}부터 ${minutes}분 동안 신호가 끊겼다가 ${fmt(to)}에 돌아왔어요. 지금은 정상이에요.`,
		data: { tag: HEARTBEAT_TAG, group: 'ha-agent', notification_icon: ICON, ...CHANNELS.quiet, alert_once: true },
	}
}

// ── 행동(기기 켜기/끄기) 알림 ──
export const actionTag = aid => `${TAG_PREFIX}act-${aid}`
const VERB = { turn_on: ['켤까요', '켰어요', '켜기'], turn_off: ['끌까요', '껐어요', '끄기'] }

// 승인이 필요한 행동: [실행] [아니요]
export function approvalPayload(a, minutes) {
	return {
		title: `🤖 ${a.name} ${VERB[a.action][0]}?`.slice(0, 60),
		message: `${a.reason} (${minutes}분 안에 눌러 주세요)`,
		data: {
			tag: actionTag(a.aid), group: 'ha-agent', notification_icon: ICON, ...CHANNELS.normal,
			actions: [{ action: `HAAGENT_DO_${a.aid}`, title: '실행' }, { action: `HAAGENT_NO_${a.aid}`, title: '아니요' }],
		},
	}
}

// 행동 결과. 스스로 한 행동에는 [되돌리기]가 붙고, 승인 알림은 같은 tag라 결과 문구로 바뀐다.
export function actionResultPayload(a, { undo = false } = {}) {
	const text = {
		done: [`🤖 ${a.name} ${VERB[a.action][1]}`, a.reason],
		unverified: [`🤖 ${a.name} ${VERB[a.action][2]} 확인 안 됨`, `${a.reason} 명령은 보냈지만 상태가 바뀐 것을 확인하지 못했어요.`],
		error: [`🤖 ${a.name} ${VERB[a.action][2]} 실패`, `${a.reason} (오류: ${a.error ?? '알 수 없음'})`],
		declined: [`🤖 ${a.name}: 하지 않을게요`, '알겠어요. 이런 제안은 줄일게요.'],
		expired: [`🤖 ${a.name}: 시간이 지나 취소했어요`, a.reason],
		undone: [`🤖 ${a.name}: 되돌렸어요`, '알겠어요. 이런 행동은 줄일게요.'],
	}[a.status] ?? [`🤖 ${a.name}`, a.reason]
	return {
		title: text[0].slice(0, 60),
		message: text[1],
		data: {
			tag: actionTag(a.undo_of ?? a.aid), group: 'ha-agent', notification_icon: ICON, ...CHANNELS.quiet, alert_once: true,
			...(undo ? { actions: [{ action: `HAAGENT_UNDO_${a.aid}`, title: '되돌리기' }] } : {}),
		},
	}
}
