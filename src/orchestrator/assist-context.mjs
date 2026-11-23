// Assist 대화용 프롬프트 조립·기기 목록·로컬 빠른 경로(LLM 없이 켜기/끄기)·모델 단계 선택
// 프롬프트는 캐시가 잘 맞도록 "고정 부분(시스템 지시)"과 "매번 바뀌는 부분(마지막 사용자 메시지 앞)"으로 나눈다.
import { ACTION_SERVICES } from '../ha.mjs'
import { scriptFieldsText } from '../core/policy.mjs'
import { fmt, kst } from '../util.mjs'

const DEAD = new Set(['unavailable', 'unknown'])
// 빠른 경로에 넣지 않는 도메인: 스크립트·씬은 "켜기"가 상태가 아니라 실행이고, 스크립트는 받는 값(fields)이 있을 수 있다.
const NO_FAST_DOMAINS = new Set(['script', 'scene'])
// 켜기/끄기 빠른 경로를 쓸 수 있는 도메인 (ACTION_SERVICES에 turn_on/turn_off가 둘 다 있는 것)
const ON_OFF_DOMAINS = new Set(Object.entries(ACTION_SERVICES)
	.filter(([, s]) => s.includes('turn_on') && s.includes('turn_off'))
	.map(([d]) => d))
const DEFAULT_SENSOR_CLASSES = ['temperature', 'humidity', 'pm25', 'pm10', 'carbon_dioxide', 'power']
const BLOCKED_DOMAINS = new Set(['lock', 'alarm_control_panel', 'cover', 'switch', 'light', 'script', 'input_boolean', 'fan', 'climate', 'media_player'])
export const DEFAULT_DEEP_KEYWORDS = [
	'자동화', '스크립트', '트레이스', '추적', '왜', '원인', '분석', '진단', '점검', '감사',
	'만들어', '생성', '수정', '삭제', '백업', '통합', '로그', '이력', '어제', '그저께', '지난',
	'통계', '패턴', '제안', '승인', '거절', '롤백', '규칙', '기억해', '잊어',
	'몇 번', '언제', // 기록을 세거나 찾는 질문은 작은 모델의 답이 흔들려서 deep으로
]

// 공백·문장부호를 없애고 소문자로: "주방 불 켜 줘." → "주방불켜줘"
export const squash = s => String(s ?? '').toLowerCase().replace(/[\s·.,!?~'"“”‘’()[\]{}:;\-_/]+/g, '')

// 받침 유무에 따라 조사 선택. 한글이 아니면 받침 없는 쪽(를/는)을 쓴다.
export function josa(word, withBatchim, without) {
	const ch = String(word ?? '').trim().slice(-1)
	const code = ch.charCodeAt(0)
	if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? withBatchim : without
	return without
}

const valueText = st => {
	if (!st) return '없음'
	const unit = st.attributes?.unit_of_measurement
	return unit ? `${st.state}${unit}` : st.state
}

function serviceText(id, st, scriptFields = null) {
	const domain = id.split('.')[0]
	const a = st?.attributes ?? {}
	const services = ACTION_SERVICES[domain] ?? []
	if (domain === 'script') {
		const info = scriptFields?.get?.(id)
		const fields = info ? scriptFieldsText(info) : ''
		return info ? `turn_on${fields ? `(${fields})` : ''}` : 'turn_on(설정을 아직 받지 못해 실행 불가)'
	}
	if ((domain === 'select' || domain === 'input_select') && Array.isArray(a.options)) {
		return `select_option(${a.options.slice(0, 12).join('/')})`
	}
	if (domain === 'input_number' || domain === 'number') {
		const range = [a.min, a.max].every(v => typeof v === 'number') ? `${a.min}~${a.max}` : ''
		return `set_value(${[range, a.step != null ? `step ${a.step}` : '', a.unit_of_measurement ?? ''].filter(Boolean).join(', ')})`
	}
	if (domain === 'media_player' && Array.isArray(a.source_list) && a.source_list.length) {
		return `${services.join(', ')} | 입력: ${a.source_list.slice(0, 10).join('/')}`
	}
	return services.join(', ')
}

/**
 * 제어 가능 기기·주요 센서·차단 기기 목록을 만든다.
 * staticText: 이름·방·권한·가능 동작·별칭 (자주 안 바뀜 → 시스템 지시에 넣어 캐시)
 * dynamicText: 현재 상태·센서 값 (매번 바뀜 → 마지막 사용자 메시지 앞에 넣음)
 * index: 빠른 경로용 이름 → 엔티티 매핑 (중복 이름은 모호하므로 뺀다)
 * labels: entity_id → 음성 응답에 쓸 이름 (별칭이 있으면 첫 별칭)
 */
export function buildDirectory({ policy, states, areaOf = null, catOf = null, aliases = {}, isNoise = () => false, sensorClasses = DEFAULT_SENSOR_CLASSES, maxSensors = 20, maxBlocked = 20, scriptFields = null }) {
	const areaFor = id => areaOf?.get?.(id) ?? null
	const tiers = policy.tiersMap()
	const devices = [], stateParts = []
	const names = new Map(), labels = new Map()
	const addName = (name, entry) => {
		const key = squash(name)
		if (key.length < 2) return
		const prev = names.get(key)
		if (prev && prev.entity_id !== entry.entity_id) names.set(key, null)
		else if (prev !== null) names.set(key, entry)
	}

	for (const [id, tier] of [...tiers].sort((a, b) => a[0].localeCompare(b[0]))) {
		const st = states.get(id)
		if (!st) continue
		const name = st.attributes?.friendly_name ?? id
		const area = areaFor(id)
		const al = (Array.isArray(aliases?.[id]) ? aliases[id] : []).map(s => String(s).trim()).filter(Boolean)
		labels.set(id, al[0] ?? name)
		const tierText = tier === 'auto' ? '자율' : '승인(직접 요청하면 즉시 실행)'
		devices.push(`- ${id} | ${name} | ${area ?? '-'} | ${tierText} | ${serviceText(id, st, scriptFields)}${al.length ? ` | 별칭: ${al.join(', ')}` : ''}`)
		stateParts.push(`${id}=${valueText(st)}`)
		const domain = id.split('.')[0]
		const onOffSvcs = (ACTION_SERVICES[domain] ?? []).filter(s => s === 'turn_on' || s === 'turn_off')
		if (!NO_FAST_DOMAINS.has(domain) && (ON_OFF_DOMAINS.has(domain) || onOffSvcs.length)) {
			const entry = { entity_id: id, label: al[0] ?? name, services: new Set(onOffSvcs) }
			for (const n of [...al, name]) addName(n, entry)
		}
	}

	const wanted = new Set(sensorClasses)
	const sortedStates = [...states].sort((a, b) => a[0].localeCompare(b[0]))
	const sensors = [], sensorParts = []
	for (const [id, st] of sortedStates) {
		if (sensors.length >= maxSensors) break
		if (!id.startsWith('sensor.') || isNoise(id) || !wanted.has(st.attributes?.device_class)) continue
		const area = areaFor(id)
		if (!area) continue // 방이 없는 센서(바깥 날씨 등)는 빼서 목록을 짧게 유지
		sensors.push(`- ${id} | ${st.attributes?.friendly_name ?? id} | ${area}`)
		sensorParts.push(`${id}=${DEAD.has(st.state) ? st.state : valueText(st)}`)
	}

	const blocked = []
	for (const [id, st] of sortedStates) {
		if (blocked.length >= maxBlocked) break
		const domain = id.split('.')[0]
		if (!BLOCKED_DOMAINS.has(domain) || !policy.isTier3Blocked(id) || catOf?.get?.(id)) continue
		blocked.push(st.attributes?.friendly_name ?? id)
	}
	const blockedUnique = [...new Set(blocked)].sort((a, b) => a.localeCompare(b))

	const staticText = [
		'기기 목록 (id | 이름 | 방 | 권한 | 가능한 동작 | 별칭):',
		...(devices.length ? devices : ['- 없음 (기기 제어 권한 꺼짐)']),
		sensors.length ? '주요 실내 센서 (id | 이름 | 방):' : '',
		...sensors,
		blockedUnique.length ? `안전 정책으로 차단된 기기 (요청받으면 도구 없이 바로 이유를 말하고 거절): ${blockedUnique.join(', ')}` : '',
	].filter(Boolean).join('\n')

	const dynamicText = [
		stateParts.length ? `기기 상태: ${stateParts.join(', ')}` : '',
		sensorParts.length ? `센서 값: ${sensorParts.join(', ')}` : '',
	].filter(Boolean).join('\n')

	const index = new Map([...names].filter(([, v]) => v))
	return { staticText, dynamicText, index, labels }
}

// 시스템 지시(고정 부분). 시각·상태처럼 매번 바뀌는 값은 넣지 않는다.
export function buildAssistInstructions({ policyDesc, directoryText = '', profile = '', memory = '', earlyFinish = true }) {
	return [
		'너는 이 집의 Home Assistant 개인 자율형 비서다. 사용자는 HA Assist(음성 또는 채팅)로 대화하고 있다.',
		`권한 요약: Tier1(자율) ${policyDesc.tier1_auto.length}개, Tier2(승인/직접요청) ${policyDesc.tier2_confirm.length}개 | HA관리=${policyDesc.admin_enabled ? '켜짐' : '꺼짐'}`,
		directoryText,
		profile ? `집 프로필:\n${profile}` : '',
		memory ? `기억:\n${memory}` : '',
		'규칙:',
		'- 마지막 사용자 메시지 앞의 [현재 상황]에 시각·기기 상태·센서 값이 있다. 기기 목록과 [현재 상황]으로 답할 수 있으면 조회 도구를 쓰지 말고 바로 답하거나 제어한다.',
		'- 목록에 없는 엔티티, 상세 속성, 상태 기록·로그북·통계, 자동화·트레이스·통합·백업이 필요할 때만 조회 도구를 쓴다. 추측하지 않는다.',
		'- 기기 목록에는 제어 가능한 기기와 일부 센서만 있다. 가전(세탁기·건조기 등)의 운전 상태·남은 시간처럼 목록에 없는 것을 물으면 ha_search_entities로 먼저 찾아보고, 찾아보지 않은 채 "연결돼 있지 않다/알 수 없다"고 답하지 않는다.',
		'- 도구 결과의 시각은 모두 KST로 바꿔 두었고 괄호 안에 지금 기준 몇 분 전/뒤인지 적혀 있다. 그 값으로 지났는지·남았는지를 판단한다. "남은 시간" 센서 값은 끝나는 시각이다.',
		'- 사용자가 기기 제어를 직접 지시했으면 상태를 다시 조회하지 말고 곧바로 ha_control_device를 requested=true로 호출한다. 방 이름·별칭으로 기기 목록에서 대상을 고른다.',
		'- "~끄는 게 어때?"처럼 의향을 묻는 질문에는 바로 제어하지 말고 먼저 확인한다. 명확한 실행 지시일 때만 ha_control_device를 호출한다.',
		'- 기기를 켜고 끄거나 바꾸는 일은 반드시 ha_control_device 호출로만 일어난다. 이번 차례에 호출해서 성공하지 않았으면 절대 "켰어요/껐어요/바꿨어요"처럼 말하지 않는다.',
		earlyFinish
			? '- ha_control_device의 speech_if_success에는 제어가 성공하면 사용자에게 그대로 들려줄 짧은 한 문장을 넣는다(예: "주방 불을 켰어요."). 여러 기기를 한 번에 제어하면 모든 호출에 같은 전체 요약 문장을 넣는다.'
			: '',
		'- 날씨 예보는 ha_get_weather, 일정은 ha_get_calendar, 최근 보낸 알림 문의는 ha_get_recent_notifications로 조회한다.',
		'- 사용자가 일정·부재·선호·영구 지시를 말하면 memory_upsert로 저장하고, 과거 선호·지시 확인은 memory_search, 취소·삭제 요청은 memory_delete를 쓴다.',
		'- 안전 정책으로 차단된 기기나 목록에 없는 기기의 제어 요청은 도구 없이 이유를 짧게 설명하고 거절한다.',
		'- 자동화/스크립트 생성·수정·삭제·통합 리로드·백업·규칙 승격은 ha_propose_admin으로 검증 후 Tier 2 승인 제안을 만든다.',
		'- 사용자가 기존 제안의 승인/거절/롤백을 직접 지시했으면 ha_proposal_action을 호출한다.',
		'- speech는 마크다운 기호(*, #, `, 불릿), 이모지, 영문 entity_id 없이 TTS로 바로 읽기 자연스럽고 간결한 한국어 존댓말(1~3문장, 단위 포함)로 답한다.',
	].filter(Boolean).join('\n')
}

// 매번 바뀌는 상황 정보. 마지막 사용자 메시지 앞에 붙인다(대화 기록에는 원문만 남긴다).
export function buildDynamicContext({ now, language = 'ko', aoId = null, aoState = null, pendingProps = [], directoryDynamic = '' }) {
	const k = kst(new Date(now))
	return [
		'[현재 상황]',
		`시각(KST): ${fmt(now)} (${k.wd}), 언어: ${language}, 재실 도우미(${aoId ?? '없음'}): ${aoState ?? '없음'}`,
		pendingProps.length ? `승인 대기 중인 제안: ${pendingProps.map(p => `${p.pid}(${p.title})`).join(', ')}` : '승인 대기 중인 제안 없음',
		directoryDynamic,
	].filter(Boolean).join('\n')
}

export function withDynamicContext(history, dynamicText) {
	const msgs = history.map(m => ({ role: m.role, content: m.text ?? m.content }))
	const lastUser = msgs.findLastIndex(m => m.role === 'user')
	if (lastUser >= 0 && dynamicText) {
		msgs[lastUser] = { ...msgs[lastUser], content: `${dynamicText}\n\n[사용자 말]\n${msgs[lastUser].content}` }
	}
	return msgs
}

const VERB_RE = /^(.+?)(?:을|를|은|는|도)?(?:좀|지금|바로)?(?:다시)?(켜(?:줘요?|주세요|줄래요?|주라|라|요|봐|자)?|꺼(?:줘요?|주세요|줄래요?|주라|라|요|봐)?|끄(?:자|죠))$/

/**
 * "주방 불 켜줘" 같은 단순 켜기/끄기 명령이면 대상과 동작을 돌려준다. 확실하지 않으면 null (→ LLM).
 * STT가 같은 말을 두 번 붙인 경우("주방 불 켜. 주방 불 켜.")도 하나로 본다.
 */
export function matchFastCommand(text, index) {
	if (!index?.size) return null
	const parts = [...new Set(String(text ?? '').split(/[.!?。\n]+/).map(squash).filter(Boolean))]
	if (parts.length !== 1) return null
	const m = VERB_RE.exec(parts[0])
	if (!m) return null
	const target = index.get(m[1])
	if (!target) return null
	const service = m[2].startsWith('켜') ? 'turn_on' : 'turn_off'
	if (target.services && !target.services.has(service)) return null
	return { entity_id: target.entity_id, label: target.label, service }
}

// 제어 결과를 음성으로 읽을 한 문장으로 바꾼다(빠른 경로·noop 응답용).
export function controlSpeech(label, service, res) {
	const on = service === 'turn_on'
	const obj = `${label}${josa(label, '을', '를')}`
	const status = res?.status
	if (status === 'done') return `${obj} ${on ? '켰어요' : '껐어요'}.`
	if (status === 'noop') return `${label}${josa(label, '은', '는')} 이미 ${on ? '켜져' : '꺼져'} 있어요.`
	if (status === 'pending') return `${label} ${on ? '켜기' : '끄기'} 승인 요청을 보냈어요. 알림에서 승인해 주세요.`
	if (status === 'test_mode') return `지금은 시험 모드라 실제로 ${obj} ${on ? '켜지' : '끄지'}는 않았어요.`
	if (status === 'unverified') return `${label}에 ${on ? '켜기' : '끄기'} 명령을 보냈는데, 상태 변화는 아직 확인되지 않았어요.`
	const why = String(res?.error ?? '').replace(/\([^)]*\.[^)]*\)/g, '').replace(/[a-z_]+\.[a-z0-9_]+/gi, '').trim()
	return `${obj} ${on ? '켜지' : '끄지'} 못했어요.${why ? ` ${why.slice(0, 80)}` : ''}`
}

const COMMAND_RE = /(켜|꺼|끄|바꿔|변경|틀어|열어|닫아|설정|맞춰|올려|내려|줄여|높여|낮춰|실행|멈춰|정지|돌려)/
const CLAIM_RE = /(켰|껐|켜 ?드렸|꺼 ?드렸|바꿨|바꾸었|변경했|틀었|열었|닫았|설정했|맞췄|올렸|내렸|줄였|높였|낮췄|실행했|멈췄|정지했|돌렸)(어요|습니다|어|다|네요)/
const HISTORY_Q_RE = /(누가|언제|왜|몇\s*번|어제|그저께|아까|지난|이력|기록|로그|켜져|꺼져|켰는지|껐는지|켰어|껐어|켜졌|꺼졌|바뀌었|돌았어)/
// 제어 요청에 도구 호출 없이 "켰어요"라고 답한 경우(모델이 실행한 척한 것)를 잡는다. 과거 이력 질문은 제외한다.
export function claimsUnexecutedControl(text, speech, actionCount) {
	const t = String(text ?? '')
	if (actionCount > 0 || HISTORY_Q_RE.test(t)) return false
	return COMMAND_RE.test(t) && CLAIM_RE.test(String(speech ?? ''))
}

// 복잡한 요청(자동화·기록 분석 등)이면 deep 단계 모델을 쓴다.
export function wantsDeep(text, keywords = DEFAULT_DEEP_KEYWORDS) {
	const t = String(text ?? '')
	return keywords.some(k => k && t.includes(k))
}

const FAMILY = {
	gemini: /^(gemini|gemma)/i,
	agy: /^(gemini|gemma)/i,
	api: /^(gpt|o\d|chatgpt|codex|ft:)/i,
	codex: /^(gpt|o\d|codex)/i,
	anthropic: /^claude/i,
}
// 모델 이름이 그 프로바이더 것인지(예: api 라우트에 gemini 모델이 들어가는 실수 방지). 모르는 프로바이더는 통과.
export function modelFitsProvider(model, provider) {
	if (!model) return false
	const re = FAMILY[provider]
	return re ? re.test(String(model)) : true
}
