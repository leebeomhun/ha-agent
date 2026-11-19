// 설정: config.json은 고정 설정, state/control.json은 실행 중에 바꾸는 스위치(일시정지·알림 발송·판단 방식)
import { P, readJson, writeJson } from './util.mjs'

export const DEFAULTS = {
	ha_ws_url: 'ws://homeassistant/api/websocket',
	token_file: '~/.config/home-assistant/token',
	notify_targets: ['mobile_app_ibeomhun'],
	weather_entity: 'weather.jib',
	weather_fallback_entity: null,
	away_override_entity: null,
	active_hours: { start: 8, end: 24 },
	hourly_checkin: true,
	// 직전 정각 점검 뒤로 집 상태·날씨·일정이 그대로면 Codex를 부르지 않는다(첫 점검과 24시는 항상 실행).
	hourly_skip_unchanged: true,
	// 하루 돌아보기 시각(KST 0~23). 활동 시간 밖이어도 돈다. 그때의 요약은 조용한 시간이어도 나간다. null이면 끔.
	reflection_hour: 0,
	// 자주 바뀌지만 집 상태와는 상관없는 엔티티(별표 가능). 프롬프트에서는 횟수만 남기고, 정각 점검을 건너뛸지 따질 때 세지 않는다.
	noise_entities: [],
	// 새로 만들거나 고친 규칙을 지난 7일 기록에 돌려 보고 몇 번 발동했을지 AI에게 보여 준다.
	rule_backtest: true,
	// 알림에 [답장] 버튼을 붙여 휴대폰에서 말로 지시할 수 있게 한다.
	reply_button: true,
	// 주 루프가 이만큼 멈추면 프로세스를 끝낸다(systemd가 다시 띄움). 0이면 끔.
	watchdog_minutes: 5,
	limits: {
		brain_runs_per_day: 80,
		user_reserve_runs: 10, // 하루 한도에 닿은 뒤에도 사용자 말·수동 깨움에는 이만큼 더 답한다
		alerts_per_day: 25,
		summaries_per_day: 20,
		min_gap_minutes: 3,
		max_rules: 60,
		max_pending_wakes: 12,
		memory_chars: 6000,
		rule_batch_seconds: 60,
		mute_days: 7,
		max_attempts: 3, // 판단이 실패한 깨움을 다시 시도하는 횟수(규칙 발동·사용자 말). 그 밖은 2번.
		max_rounds: 3, // 한 번의 판단에서 추가 자료를 받아 다시 묻는 횟수 포함 최대 호출 수
		keep_runs: 100, // logs/runs/에 남길 판단 원문 개수
		keep_snapshots: 30, // state/history/에 남길 규칙·메모 이전 판 개수(종류별)
		keep_weekly: 26, // state/weekly/에 남길 주간 분석 보고서 개수
	},
	// 판단 방식: 'codex'(Codex CLI를 격리해 실행) 또는 'api'(OpenAI API 직접 호출). 실행 중에는 `cli.mjs brain`으로 바꾼다.
	brain: 'codex',
	codex: {
		bin: 'codex',
		model: 'gpt-6.1-sol',
		fallback_model: null, // 두 번 연속 실패하면 이 모델로 시도
		effort: 'low',
		effort_hourly: null, // 정각 점검만 따로 낮출 때(null이면 effort 사용)
		effort_deep: 'medium',
		timeout_seconds: 240,
		timeout_deep_seconds: 600,
		vendor_dir: null,
	},
	// API 방식 설정. 키는 key_file(파일 경로) → 환경 변수 key_env → 프로젝트 .env 순서로 찾는다.
	// model·effort·timeout 값이 null이면 위 codex 값을 그대로 쓴다.
	api: {
		base_url: 'https://api.openai.com/v1',
		key_env: 'OPENAI_API_KEY',
		key_file: null,
		model: null,
		fallback_model: null,
		effort: null,
		effort_hourly: null,
		effort_deep: null,
		timeout_seconds: null,
		timeout_deep_seconds: null,
		max_tool_calls: 30, // 한 번의 판단에서 파일 읽기 도구를 부를 수 있는 횟수
	},
	// 주간 분석: 정한 요일(일~토)·시각에 자동화 실행 기록과 기기 조작을 분석해 개선안 보고서를 state/weekly/에 남긴다.
	// publish: 보고서 전문을 HA 알림 목록(🔔, persistent_notification)에도 올려 휴대폰에서 읽을 수 있게 한다.
	weekly: { enabled: true, weekday: '일', hour: 21, timeout_seconds: 900, publish: true },
	// 고른 판단 방식이 after_failures번 연속 실패하면 다른 방식(codex↔api)으로 넘어가 hold_minutes 동안 그쪽에 묻는다.
	// 넘어갈 쪽을 쓸 수 있을 때만(Codex 실행 파일 또는 API 키) 동작한다.
	failover: { enabled: true, after_failures: 2, hold_minutes: 120 },
	// urgent 규칙이 발동한 뒤 상황이 그대로이고 사용자의 반응도 없으면 다시 알린다. oob_from번째부터는 비상 알림 길로도 보낸다.
	escalation: { enabled: true, remind_minutes: 15, max_reminders: 3, oob_from: 2 },
	// HA로 살아 있다는 신호(haagent_heartbeat 이벤트)를 보낸다. HA 쪽 자동화가 끊김을 알린다.
	// alert_minutes: HA 경고 자동화의 지연(ha/heartbeat-automation.yaml의 delay)과 맞춘다. 신호가 이보다 오래 끊겼다 돌아오면 그 경고를 '다시 연결됐어요'로 바꾼다.
	heartbeat: { enabled: true, interval_seconds: 60, alert_minutes: 10 },
	// HA를 거치지 않는 비상 알림 길. type: null(끔) | "ntfy" | "telegram" | "webhook"
	oob: { type: null, url: null, topic: null, token_file: null, chat_id: null, ha_down_minutes: 15 },
	// 기기 켜기/끄기. auto는 스스로 실행, confirm은 휴대폰에서 [실행]을 눌러야 실행. 적지 않은 엔티티는 움직이지 못한다.
	// on_request: 사용자가 답장·say로 직접 시킨 행동은 confirm 엔티티여도 승인을 다시 묻지 않고 바로 실행한다.
	actions: { enabled: false, auto: [], confirm: [], per_day: 20, per_cycle: 3, approval_minutes: 30, verify_seconds: 10, on_request: true },
}

const NESTED = ['active_hours', 'limits', 'codex', 'api', 'weekly', 'failover', 'escalation', 'heartbeat', 'oob', 'actions']

export function mergeConfig(c = {}) {
	const out = { ...DEFAULTS, ...c }
	for (const k of NESTED) out[k] = { ...DEFAULTS[k], ...c[k] }
	// 요일은 '일'~'토'로 맞춘다. 숫자(0=일)와 '일요일'도 받는다. 알 수 없는 값이면 기본 요일.
	const wd = out.weekly.weekday, days = '일월화수목금토'
	out.weekly.weekday = Number.isInteger(wd) && days[wd] ? days[wd] : typeof wd === 'string' && wd && days.includes(wd[0]) ? wd[0] : DEFAULTS.weekly.weekday
	return out
}
export const loadConfig = () => mergeConfig(readJson(P.config, {}))

export function validateConfig(cfg) {
	const errors = [], warnings = []
	const ah = cfg?.active_hours ?? {}
	if (!Number.isInteger(ah.start) || !Number.isInteger(ah.end) || ah.start < 0 || ah.end > 24 || ah.start >= ah.end) {
		errors.push(`active_hours 범위 오류 (${ah.start}~${ah.end}, 0 <= start < end <= 24 정수 필요)`)
	}
	const rh = cfg?.reflection_hour
	if (rh != null && (!Number.isInteger(rh) || rh < 0 || rh > 23)) errors.push(`reflection_hour 오류 (${rh}, null 또는 0~23 정수 필요)`)
	if (!['codex', 'api'].includes(cfg?.brain)) errors.push(`brain 설정 오류 (${cfg?.brain}, codex 또는 api만 가능)`)
	if (!Array.isArray(cfg?.notify_targets) || !cfg.notify_targets.some(t => typeof t === 'string' && t.trim())) {
		errors.push('notify_targets가 비어 있음')
	}
	const posKeys = ['brain_runs_per_day', 'alerts_per_day', 'summaries_per_day', 'min_gap_minutes', 'max_rules', 'max_pending_wakes', 'memory_chars', 'rule_batch_seconds', 'mute_days', 'max_attempts', 'max_rounds', 'keep_runs', 'keep_snapshots', 'keep_weekly']
	for (const k of posKeys) {
		const v = cfg?.limits?.[k]
		if (!Number.isFinite(v) || v <= 0) errors.push(`limits.${k}는 0보다 큰 수여야 함 (${v})`)
	}
	if (!Number.isFinite(cfg?.limits?.user_reserve_runs) || cfg.limits.user_reserve_runs < 0) {
		errors.push(`limits.user_reserve_runs는 0 이상이어야 함 (${cfg?.limits?.user_reserve_runs})`)
	}
	const o = cfg?.oob ?? {}
	if (o.type) {
		if (o.type === 'ntfy') {
			if (!o.topic) errors.push('oob.type이 ntfy인데 oob.topic이 비어 있음')
		} else if (o.type === 'telegram') {
			if (!o.token_file || !o.chat_id) errors.push('oob.type이 telegram인데 oob.token_file 또는 oob.chat_id가 비어 있음')
		} else if (o.type === 'webhook') {
			if (!o.url) errors.push('oob.type이 webhook인데 oob.url이 비어 있음')
		} else {
			errors.push(`알 수 없는 oob.type: ${o.type}`)
		}
	}
	if ((cfg?.api?.effort == null && cfg?.codex?.effort === 'max')
		|| (cfg?.api?.effort_deep == null && cfg?.codex?.effort_deep === 'max')
		|| (cfg?.api?.effort_hourly == null && cfg?.api?.effort == null && cfg?.codex?.effort_hourly === 'max')) {
		warnings.push('api.effort/effort_deep이 비어 있어 codex의 "max"를 상속합니다 (API 비용 증가·호환성 주의)')
	}
	return { errors, warnings }
}

export const loadControl = () => ({ paused: false, send: false, ...readJson(P.control, {}) })
export const saveControl = c => writeJson(P.control, c)
