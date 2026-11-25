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
	// 브리핑 시각 목록(예: [7, 18]). null이면 기존 hourly_checkin 동작을 유지한다.
	briefing_hours: null,
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
		backtest_max_fires: 25, // 사전 백테스트 7일 발동 한도(초과 시 규칙 적용 보류)
		proposal_self_repair: true, // HA 관리 제안 사전 검증 실패 시 1회 자가 수정 라운드 허용
	},
	// 계층형 메모리 및 대화 직후 비동기 기억 추출·임베딩 설정
	memory: {
		post_turn_extract: true,
		post_turn_llm: true,
		embedding_model: 'local', // 'local' 또는 Gemini 임베딩 모델명(권장: 'gemini-embedding-2')
		embedding_dims: 768,
		semantic_threshold: 0.66,
	},
	// 자가학습·실험 원장 설정
	learning: {
		enabled: true,
		experiment_eval_days: 7,
		auto_consolidate_on_reflection: true,
		// 하루 한 번 자가개선 작업(실험 후속 조치·빠른 경로 회귀 평가·기기 건강·루틴 자동화 제안)을 도는 시각(KST, 0~23)
		daily_hour: 19,
		// 루틴 자동화 제안 기준(src/engine/automation-suggest.mjs의 SUGGEST_DEFAULTS를 덮어씀)
		suggest: {},
	},
	// 기기 건강 점검 기준: 응답 없음 시간, 배터리 %, Zigbee LQI·Wi-Fi RSSI 하한
	health: { unavailable_hours: 6, battery_pct: 20, lqi_min: 40, rssi_min: -85 },
	// 판단 방식: 'codex'(Codex CLI를 격리해 실행) 또는 'api'(OpenAI API 직접 호출). 실행 중에는 `cli.mjs brain`으로 바꾼다.
	brain: 'codex',
	codex: {
		bin: 'codex',
		model: 'gpt-6.1-sol',
		fallback_model: null, // 두 번 연속 실패하면 이 모델로 시도
		effort: 'low',
		effort_hourly: null, // 정각 점검만 따로 낮출 때(null이면 effort 사용)
		effort_deep: 'medium',
		effort_weekly: null, // 주간 분석만 따로 둘 때(null이면 effort_deep 사용)
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
		effort_weekly: null,
		timeout_seconds: null,
		timeout_deep_seconds: null,
		max_tool_calls: 30, // 한 번의 판단에서 파일 읽기 도구를 부를 수 있는 횟수
	},
	// Google Antigravity CLI 설정 (agy --output-format json --disable-slash-commands --sandbox)
	agy: {
		bin: 'agy',
		model: 'gemini-4-hydrogen-medium',
		fallback_model: null,
		effort: 'medium',
		effort_hourly: 'low',
		effort_deep: 'high',
		effort_weekly: null,
		timeout_seconds: 240,
		timeout_deep_seconds: 600,
	},
	// Google Gemini API 직접 호출 설정
	gemini: {
		base_url: 'https://generativelanguage.googleapis.com/v1beta',
		key_env: 'GEMINI_API_KEY',
		key_file: null,
		model: null, // null이면 llm.gemini.model('gemini-4-hydrogen') 사용
		fallback_model: null,
		effort: null, // null이면 agy 값 상속
		effort_hourly: null,
		effort_deep: null,
		effort_weekly: null,
		timeout_seconds: null,
		timeout_deep_seconds: null,
		max_tool_calls: 30,
	},
	// 다중 LLM 프로바이더 및 작업 유형별 라우팅 설정
	llm: {
		routes: {},
		anthropic: { base_url: 'https://api.anthropic.com/v1', key_env: 'ANTHROPIC_API_KEY', key_file: null, model: 'claude-sonnet-4-5', timeout_seconds: 120 },
		gemini: { base_url: 'https://generativelanguage.googleapis.com/v1beta', key_env: 'GEMINI_API_KEY', key_file: null, model: 'gemini-4-hydrogen', timeout_seconds: 120 },
		ollama: { base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:14b', timeout_seconds: 120 },
	},
	// 주간 분석: 정한 요일(일~토)·시각에 자동화 실행 기록과 기기 조작을 분석해 개선안 보고서를 state/weekly/에 남긴다.
	// publish: 보고서 전문을 HA 알림 목록(🔔, persistent_notification)에도 올려 휴대폰에서 읽을 수 있게 한다.
	weekly: { enabled: true, weekday: '일', hour: 21, timeout_seconds: 900, publish: true },
	// 고른 판단 방식이 after_failures번 연속 실패하면 짝 방식(codex↔api, agy↔gemini)으로 넘어가 hold_minutes 동안 그쪽에 묻는다.
	// 넘어갈 쪽을 쓸 수 있을 때만 동작한다. target을 직접 정하면 그 방식으로 넘어간다.
	failover: { enabled: true, after_failures: 2, hold_minutes: 120, target: null },
	// urgent 규칙이 발동한 뒤 상황이 그대로이고 사용자의 반응도 없으면 다시 알린다. oob_from번째부터는 비상 알림 길로도 보낸다.
	escalation: { enabled: true, remind_minutes: 15, max_reminders: 3, oob_from: 2 },
	// HA로 살아 있다는 신호(haagent_heartbeat 이벤트)를 보낸다. HA 쪽 자동화가 끊김을 알린다.
	// alert_minutes: HA 경고 자동화의 지연(ha/heartbeat-automation.yaml의 delay)과 맞춘다. 신호가 이보다 오래 끊겼다 돌아오면 그 경고를 '다시 연결됐어요'로 바꾼다.
	heartbeat: { enabled: true, interval_seconds: 60, alert_minutes: 10 },
	// HA를 거치지 않는 비상 알림 길. type: null(끔) | "kakao" | "slack" | "ntfy" | "telegram" | "webhook"
	oob: {
		type: null, url: null, topic: null, token_file: null, chat_id: null, channel_id: null,
		env_file: null, token_env: 'SLACK_BOT_TOKEN', channel_env: 'SLACK_CHANNEL_ID',
		refresh_token_env: 'KAKAO_REFRESH_TOKEN', client_id_env: 'KAKAO_REST_API_KEY', client_secret_env: 'KAKAO_CLIENT_SECRET',
		mode: 'friend', recipient_name: null, recipient_uuid: null, fallback_memo: true,
		fallback: null, ha_down_minutes: 15,
	},
	// 기기 켜기/끄기. auto는 스스로 실행, confirm은 휴대폰에서 [실행]을 눌러야 실행. 적지 않은 엔티티는 움직이지 못한다.
	// on_request: 사용자가 답장·say로 직접 시킨 행동은 confirm 엔티티여도 승인을 다시 묻지 않고 바로 실행한다.
	actions: { enabled: false, auto: [], confirm: [], per_day: 20, per_cycle: 3, approval_minutes: 30, verify_seconds: 10, on_request: true },
	// Risk Tier 0~3 정책 엔진 및 HA DevOps 관리 권한
	policy: {
		tier1_auto: [],
		tier2_confirm: [],
		tier3_blocked: [],
		admin_enabled: false,
		proposal_expire_hours: 24,
		away_override_exempt: ['light.hwanpunggi', 'switch.geosil_gonggiceongjeonggi_power'],
		// 스크립트별로 허용하는 최종 기기·동작. 예: { "script.ha_turn_off_and_check": { "entities": ["switch.a", "light.b"], "services": ["homeassistant.turn_off"] } }
		// 움직일 기기가 실행할 때 정해지는 스크립트(템플릿 대상·다른 자동화 호출)는 여기 적지 않으면 Tier 1이어도·직접 요청이어도 승인을 거친다.
		script_targets: {},
	},
	// HA Assist 주력 대화 서버 및 Tailscale 관리 콘솔
	assist: {
		enabled: false,
		host: '0.0.0.0',
		port: 8787,
		allowed_networks: null,
		token_file: '~/.config/ha-agent/assist-token',
		timeout_seconds: 90,
		model: null,
		effort: null,
		// 한 번의 요청에서 움직일 수 있는 기기 수. null이면 actions.per_cycle(정기 판단과 같은 한도)
		max_actions_per_turn: null,
		voice: {
			provider: 'gemini',
			stt_model: 'gemini-3.5-transcribe',
			stt_fallback_model: 'gemini-3.5-flash-lite',
			// transcribe 모델 전사 방식: verbatim(말한 그대로, 기본) | smart(추임새·말 고침 정리)
			stt_mode: 'verbatim',
			// 빈 결과가 난 오디오를 state/stt-failures/에 남길 개수 (0이면 끔)
			stt_debug_keep: 20,
			tts_model: 'gemini-3.8-flash-lite-tts',
			tts_voice: 'Kore',
			tts_language: 'ko-KR',
			tts_cache_max: 32,
			stt_timeout_seconds: 25,
			tts_timeout_seconds: 30,
			stt_hints: [],
			// HA STT 컴포넌트의 말 끝 감지(ha/custom_components/ha_agent_assist/endpoint.py). 여기 값이 5분 안에 HA로 전달된다.
			// 그 밖의 세부 값(start_margin_db, bg_margin_db, near_field_db, end_drop_db, preroll_ms 등)도 같은 이름으로 넣을 수 있다.
			endpoint: { enabled: true, silence_ms: 700, max_seconds: 10, no_speech_seconds: 6 },
		},
	},
}

const NESTED = ['active_hours', 'limits', 'memory', 'learning', 'codex', 'api', 'agy', 'gemini', 'llm', 'weekly', 'failover', 'escalation', 'heartbeat', 'oob', 'actions', 'policy', 'assist']
const BRAIN_ALIAS = { openai: 'api', antigravity: 'agy', 'gemini-api': 'gemini' }
const dropNull = obj => Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined && v !== null))

export function mergeConfig(c = {}) {
	const out = { ...DEFAULTS, ...c }
	if (typeof out.brain === 'string' && BRAIN_ALIAS[out.brain]) out.brain = BRAIN_ALIAS[out.brain]
	for (const k of NESTED) out[k] = { ...DEFAULTS[k], ...c[k] }
	out.assist.voice = { ...DEFAULTS.assist.voice, ...(c.assist?.voice ?? {}) }
	out.assist.voice.endpoint = { ...DEFAULTS.assist.voice.endpoint, ...(c.assist?.voice?.endpoint ?? {}) }
	if (c.llm) {
		out.llm.routes = { ...DEFAULTS.llm.routes, ...c.llm.routes }
		for (const p of ['anthropic', 'gemini', 'ollama']) out.llm[p] = { ...DEFAULTS.llm[p], ...c.llm[p] }
	}
	const gExplicit = { ...dropNull(c.llm?.gemini), ...dropNull(c.gemini) }
	out.gemini = { ...DEFAULTS.gemini, ...gExplicit }
	out.llm.gemini = { ...DEFAULTS.llm.gemini, ...gExplicit }
	if (out.oob.fallback && typeof out.oob.fallback === 'object') {
		out.oob.fallback = { ...out.oob.fallback }
	}
	// 요일은 '일'~'토'로 맞춘다. 숫자(0=일)와 '일요일'도 받는다. 알 수 없는 값이면 기본 요일.
	const wd = out.weekly.weekday, days = '일월화수목금토'
	out.weekly.weekday = Number.isInteger(wd) && days[wd] ? days[wd] : typeof wd === 'string' && wd && days.includes(wd[0]) ? wd[0] : DEFAULTS.weekly.weekday
	return out
}
export const loadConfig = () => mergeConfig(readJson(P.config, {}))

function validateOobEntry(o, prefix, errors) {
	if (!o?.type) return
	if (o.type === 'ntfy') {
		if (!o.topic) errors.push(`${prefix}.type이 ntfy인데 ${prefix}.topic이 비어 있음`)
	} else if (o.type === 'telegram') {
		if (!o.token_file || !o.chat_id) errors.push(`${prefix}.type이 telegram인데 ${prefix}.token_file 또는 ${prefix}.chat_id가 비어 있음`)
	} else if (o.type === 'slack') {
		if (!o.env_file && (!o.token_file || !o.channel_id)) errors.push(`${prefix}.type이 slack인데 ${prefix}.env_file 또는 token_file+channel_id가 비어 있음`)
	} else if (o.type === 'kakao') {
		if (!o.env_file && !o.token_file) errors.push(`${prefix}.type이 kakao인데 ${prefix}.env_file 또는 token_file이 비어 있음`)
		if ((o.mode ?? 'friend') === 'friend' && !o.recipient_name && !o.recipient_uuid) {
			errors.push(`${prefix}.type이 kakao(friend)인데 recipient_name 또는 recipient_uuid가 비어 있음`)
		}
	} else if (o.type === 'webhook') {
		if (!o.url) errors.push(`${prefix}.type이 webhook인데 ${prefix}.url이 비어 있음`)
	} else {
		errors.push(`알 수 없는 ${prefix}.type: ${o.type}`)
	}
}

export function validateConfig(cfg) {
	const errors = [], warnings = []
	const ah = cfg?.active_hours ?? {}
	if (!Number.isInteger(ah.start) || !Number.isInteger(ah.end) || ah.start < 0 || ah.end > 24 || ah.start >= ah.end) {
		errors.push(`active_hours 범위 오류 (${ah.start}~${ah.end}, 0 <= start < end <= 24 정수 필요)`)
	}
	const dh = cfg?.learning?.daily_hour
	if (dh != null && (!Number.isInteger(dh) || dh < 0 || dh > 23)) errors.push(`learning.daily_hour 오류 (${dh}, 0~23 정수 필요)`)
	const rh = cfg?.reflection_hour
	if (rh != null && (!Number.isInteger(rh) || rh < 0 || rh > 23)) errors.push(`reflection_hour 오류 (${rh}, null 또는 0~23 정수 필요)`)
	if (cfg?.briefing_hours != null) {
		if (!Array.isArray(cfg.briefing_hours) || cfg.briefing_hours.some(h => !Number.isInteger(h) || h < 0 || h > 23)) {
			errors.push(`briefing_hours 오류 (null 또는 0~23 정수 배열 필요)`)
		}
	}
	if (!['codex', 'api', 'agy', 'gemini'].includes(cfg?.brain)) errors.push(`brain 설정 오류 (${cfg?.brain}, codex/api/agy/gemini만 가능)`)
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
	if (cfg?.actions?.enabled && !(Array.isArray(cfg?.policy?.tier3_blocked) && cfg.policy.tier3_blocked.length)) {
		warnings.push('policy.tier3_blocked가 비어 있음: 기본으로는 lock.*·alarm_control_panel.*·update.*만 막는다. 집에서 절대 자동 제어하면 안 되는 기기(가열·세탁기 전원 등)를 넣을 것')
	}
	const o = cfg?.oob ?? {}
	validateOobEntry(o, 'oob', errors)
	if (o.fallback?.type) validateOobEntry(o.fallback, 'oob.fallback', errors)
	if (cfg?.assist?.enabled) {
		const port = cfg.assist.port
		if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`assist.port 범위 오류 (${port})`)
	}
	if ((cfg?.api?.effort == null && cfg?.codex?.effort === 'max')
		|| (cfg?.api?.effort_deep == null && cfg?.codex?.effort_deep === 'max')
		|| (cfg?.api?.effort_hourly == null && cfg?.api?.effort == null && cfg?.codex?.effort_hourly === 'max')
		|| (cfg?.api?.effort_weekly == null && cfg?.api?.effort_deep == null && cfg?.codex?.effort_weekly === 'max')) {
		warnings.push('api.effort/effort_deep이 비어 있어 codex의 "max"를 상속합니다 (API 비용 증가·호환성 주의)')
	}
	const st = cfg?.policy?.script_targets
	if (st != null) {
		if (typeof st !== 'object' || Array.isArray(st)) errors.push('policy.script_targets는 { "script.x": { entities: [...], services: [...] } } 객체여야 함')
		else {
			for (const [id, t] of Object.entries(st)) {
				if (!/^script\.[a-z0-9_]+$/.test(id)) errors.push(`policy.script_targets의 키는 script 엔티티여야 함: ${id}`)
				else if (!t || typeof t !== 'object' || !Array.isArray(t.entities) || !t.entities.every(e => typeof e === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(e))) errors.push(`policy.script_targets.${id}.entities는 entity_id 목록이어야 함`)
				else if (t.services != null && !(Array.isArray(t.services) && t.services.every(x => typeof x === 'string' && /^[a-z_]+\.([a-z0-9_]+|[a-z0-9_]*\*)$/.test(x)))) errors.push(`policy.script_targets.${id}.services는 서비스 이름 목록이어야 함(끝에 *로 범위 가능: switch.turn_*)`)
			}
		}
	}
	const pp = cfg?.learning?.suggest?.physical_platforms
	if (pp != null && !(Array.isArray(pp) && pp.every(x => typeof x === 'string' && /^[a-z0-9_]+$/.test(x)))) errors.push('learning.suggest.physical_platforms는 통합 이름 목록이어야 함(예: ["zha", "matter"])')
	const mt = cfg?.assist?.max_actions_per_turn
	if (mt != null && !(Number.isInteger(mt) && mt >= 1 && mt <= 10)) errors.push(`assist.max_actions_per_turn은 null 또는 1~10 정수 (${mt})`)
	const hasActionsList = Boolean((cfg?.actions?.auto?.length ?? 0) || (cfg?.actions?.confirm?.length ?? 0))
	const hasPolicyList = Boolean((cfg?.policy?.tier1_auto?.length ?? 0) || (cfg?.policy?.tier2_confirm?.length ?? 0))
	if (hasActionsList && hasPolicyList) {
		warnings.push('actions.auto/confirm과 policy.tier1_auto/tier2_confirm이 중복 설정됨 — policy로 단일화 권장')
	}
	return { errors, warnings }
}

export const loadControl = () => ({ paused: false, send: false, ...readJson(P.control, {}) })
export const saveControl = c => writeJson(P.control, c)
