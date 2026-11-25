// Risk Tier 0~3 정책 엔진: 기기 제어 파라미터 검증, 안전 가드레일(Tier 3 차단, 재실 도우미, 조용한 시간), 스냅샷 기반 Undo, HA 관리 서비스 검사.
import { ACTION_SERVICES } from '../ha.mjs'
import { globs } from '../util.mjs'

const DEAD = new Set(['unavailable', 'unknown'])
export const TIER3_DOMAINS = new Set(['lock', 'alarm_control_panel', 'update'])
export const TIER3_SERVICES = new Set(['homeassistant.restart', 'homeassistant.stop', 'update.install'])
// 설정과 상관없이 늘 막는 바닥(어느 집에나 맞는 도메인 단위). 집마다 다른 기기(주방 하이라이트·세탁기 전원 등)는
// config.json의 policy.tier3_blocked에만 둔다. 이 목록은 그 위에 더해질 뿐 설정으로 뺄 수 없다.
export const DEFAULT_TIER3_PATTERNS = [
	'lock.*',
	'alarm_control_panel.*',
	'update.*',
]
export const ADMIN_SERVICES = new Set([
	'automation.turn_on', 'automation.turn_off', 'automation.toggle', 'automation.reload', 'automation.trigger',
	'script.reload', 'scene.reload',
	'homeassistant.reload_config_entry', 'homeassistant.check_config', 'homeassistant.list_orphaned_database_entities',
	'homeassistant.rename_entity', 'homeassistant.add_entity_to_area', 'homeassistant.add_label_to_entity',
	'homeassistant.disable_entity', 'homeassistant.enable_entity', 'homeassistant.hide_entity', 'homeassistant.unhide_entity',
	// 엔티티 레지스트리 정리(방·라벨·별칭·아이콘). 엔티티 하나만 바꾸고 기기를 움직이지 않는다.
	'homeassistant.remove_entity_from_area', 'homeassistant.remove_label_from_entity',
	'homeassistant.add_alias_to_entity', 'homeassistant.remove_alias_from_entity', 'homeassistant.set_entity_icon',
	'backup.create_automatic',
])
// HA 자동화·스크립트 설정 안에 들어갈 수 없는 동작 도메인. 승인 뒤 HA 안에서 돌기 때문에 WS 호출 검사(Tier 3)를 거치지 않는다.
export const CONFIG_BLOCKED_DOMAINS = new Set([...TIER3_DOMAINS, 'hassio', 'shell_command', 'python_script', 'pyscript'])
const AUTOMATION_ADMIN_SERVICES = new Set(['automation.turn_on', 'automation.turn_off', 'automation.toggle', 'automation.trigger'])
// entity_id가 아닌 대상(방·기기·층·라벨). 무엇이 포함될지 미리 알 수 없다.
export const NON_ENTITY_TARGET_KEYS = ['area_id', 'device_id', 'floor_id', 'label_id']
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/
const SCRIPT_ENTITY_SERVICES = new Set(['turn_on', 'turn_off', 'toggle', 'reload'])
// 기기를 움직이지 않는 서비스. entity_id는 기록·알림에 붙이는 표시일 뿐이다(예: logbook.log의 entity_id).
const NON_ACTING_DOMAINS = new Set(['logbook', 'notify', 'persistent_notification', 'system_log'])
const NON_ACTING_SERVICES = new Set(['homeassistant.update_entity'])
const hasTemplate = s => typeof s === 'string' && /\{\{|\{%/.test(s)

const isIntOrNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const isBool = v => typeof v === 'boolean'
const isStr = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 120
const VAR_NAME_RE = /^[a-z_][a-z0-9_]{0,40}$/
// script.turn_on의 variables: 이름이 단순하고 값이 원시값(참·거짓·수·짧은 글)인 10개 이하의 객체
const isScriptVars = v => v != null && typeof v === 'object' && !Array.isArray(v)
	&& Object.keys(v).length <= 10
	&& Object.entries(v).every(([k, x]) => VAR_NAME_RE.test(k)
		&& (x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length <= 200)))

// 스크립트가 받는 필드(HA script 설정의 fields). 기본값(default)이 없는 필드는 꼭 넘겨야 한다.
// 필드를 빼고 부르면 템플릿이 빈 값으로 돌아 반대로 동작할 수 있다(예: on이 없으면 switch.turn_off).
export function requiredScriptFields(info) {
	return Object.entries(info?.fields ?? {}).filter(([, f]) => f?.default === undefined).map(([k]) => k)
}
export function scriptFieldsText(info) {
	const fields = Object.entries(info?.fields ?? {})
	if (!fields.length) return ''
	return `variables: ${fields.map(([k, f]) => `${k}${f?.default === undefined ? '(필수)' : ''}${f?.description ? `=${String(f.description).slice(0, 40)}` : ''}`).join(', ')}`
}
// scriptFields: Map(entity_id → { fields }) — 스크립트 설정을 받아 둔 것. 없으면(받지 못함) 실행하지 않는다.
export function checkScriptVariables(id, vars = {}, scriptFields) {
	const info = scriptFields?.get?.(id)
	if (!info) return `${id}의 설정(fields)을 아직 받지 못해 실행하지 않는다`
	const declared = new Set(Object.keys(info.fields ?? {}))
	const given = Object.keys(vars ?? {})
	const unknown = given.filter(k => !declared.has(k))
	if (unknown.length) return `${id}에 없는 변수: ${unknown.join(', ')}`
	const missing = requiredScriptFields(info).filter(k => vars?.[k] === undefined || vars?.[k] === null)
	if (missing.length) return `${id}에는 variables.${missing.join(', variables.')} 값이 필요하다 (service_data_json 예: {"variables":{${missing.map(k => `"${k}":…`).join(',')}}})`
	return null
}

export const CONTROL_SPECS = {
	light: {
		turn_on: {
			brightness_pct: v => isIntOrNum(v, 1, 100),
			brightness: v => isIntOrNum(v, 1, 255),
			color_temp_kelvin: v => isIntOrNum(v, 2000, 6500),
			transition: v => isIntOrNum(v, 0, 60),
		},
		turn_off: { transition: v => isIntOrNum(v, 0, 60) },
	},
	switch: { turn_on: {}, turn_off: {} },
	fan: {
		turn_on: { percentage: v => isIntOrNum(v, 0, 100), preset_mode: isStr },
		turn_off: {},
		set_percentage: { percentage: v => isIntOrNum(v, 0, 100) },
		set_preset_mode: { preset_mode: isStr },
	},
	humidifier: {
		turn_on: {},
		turn_off: {},
		set_humidity: { humidity: v => isIntOrNum(v, 20, 80) },
		set_mode: { mode: isStr },
	},
	climate: {
		turn_on: {},
		turn_off: {},
		set_temperature: { temperature: v => isIntOrNum(v, 16, 30), hvac_mode: isStr },
		set_hvac_mode: { hvac_mode: isStr },
	},
	cover: {
		open_cover: {},
		close_cover: {},
		stop_cover: {},
		set_cover_position: { position: v => isIntOrNum(v, 0, 100) },
	},
	input_boolean: { turn_on: {}, turn_off: {} },
	media_player: {
		turn_off: {},
		media_pause: {},
		media_play: {},
		media_stop: {},
		volume_set: { volume_level: v => isIntOrNum(v, 0, 1) },
		volume_mute: { is_volume_muted: isBool },
		select_source: { source: isStr },
	},
	select: { select_option: { option: isStr } },
	input_select: { select_option: { option: isStr } },
	input_number: { set_value: { value: v => typeof v === 'number' && Number.isFinite(v) } },
	number: { set_value: { value: v => typeof v === 'number' && Number.isFinite(v) } },
	input_datetime: {
		set_datetime: {
			date: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
			time: v => typeof v === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(v),
			datetime: v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(v),
		},
	},
	scene: { turn_on: {} },
	script: { turn_on: { variables: isScriptVars } },
	vacuum: { start: {}, pause: {}, return_to_base: {} },
}

const REQUIRED_PARAMS = {
	'fan.set_percentage': ['percentage'],
	'fan.set_preset_mode': ['preset_mode'],
	'humidifier.set_humidity': ['humidity'],
	'humidifier.set_mode': ['mode'],
	'climate.set_temperature': ['temperature'],
	'climate.set_hvac_mode': ['hvac_mode'],
	'cover.set_cover_position': ['position'],
	'media_player.volume_set': ['volume_level'],
	'media_player.volume_mute': ['is_volume_muted'],
	'media_player.select_source': ['source'],
	'select.select_option': ['option'],
	'input_select.select_option': ['option'],
	'input_number.set_value': ['value'],
	'number.set_value': ['value'],
}

export function validateServiceData(domain, service, data = {}, st = null) {
	const spec = CONTROL_SPECS[domain]?.[service]
	if (!spec) return `${domain}에는 ${service}을 쓸 수 없다`
	if (data != null && (typeof data !== 'object' || Array.isArray(data))) return 'service_data는 객체여야 한다'
	const clean = {}
	for (const [k, v] of Object.entries(data ?? {})) {
		if (!Object.hasOwn(spec, k)) return `${domain}.${service}에서 허용하지 않는 파라미터: ${k}`
		if (!spec[k](v)) return `${domain}.${service}의 ${k} 값이 범위를 벗어남`
		clean[k] = v
	}
	for (const req of REQUIRED_PARAMS[`${domain}.${service}`] ?? []) {
		if (clean[req] === undefined) return `${domain}.${service}에는 ${req} 파라미터가 필요하다`
	}
	if (domain === 'input_datetime' && service === 'set_datetime' && !clean.date && !clean.time && !clean.datetime) {
		return 'input_datetime.set_datetime에는 date, time, datetime 중 하나가 필요하다'
	}
	if (st?.attributes) {
		const a = st.attributes
		if ((domain === 'select' || domain === 'input_select') && Array.isArray(a.options) && !a.options.includes(clean.option)) {
			return `${st.entity_id}에서 지원하지 않는 option: ${clean.option}`
		}
		if (domain === 'climate' && clean.hvac_mode && Array.isArray(a.hvac_modes) && !a.hvac_modes.includes(clean.hvac_mode)) {
			return `${st.entity_id}에서 지원하지 않는 hvac_mode: ${clean.hvac_mode}`
		}
		if (domain === 'media_player' && clean.source && Array.isArray(a.source_list) && !a.source_list.includes(clean.source)) {
			return `${st.entity_id}에서 지원하지 않는 source: ${clean.source}`
		}
		if ((domain === 'input_number' || domain === 'number') && clean.value != null) {
			if (typeof a.min === 'number' && clean.value < a.min) return `${st.entity_id} 최소값(${a.min}) 미만`
			if (typeof a.max === 'number' && clean.value > a.max) return `${st.entity_id} 최대값(${a.max}) 초과`
		}
	}
	return { ok: true, data: clean }
}

const OFF_LIKE = new Set(['turn_off', 'close_cover', 'media_pause', 'media_stop', 'return_to_base'])
const QUIET_SAFE_SERVICES = new Set(['turn_off', 'close_cover', 'media_pause', 'media_stop', 'return_to_base', 'volume_mute'])

export function isAlreadyReached(domain, service, data, st) {
	if (!st) return false
	if (Object.keys(data ?? {}).length > 0) return false
	if (service === 'turn_on') return domain !== 'scene' && domain !== 'script' && st.state === 'on'
	if (service === 'turn_off') return ['off', 'standby'].includes(st.state)
	return false
}

const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v))
const near = (a, b, tol) => Number.isFinite(num(a)) && Number.isFinite(num(b)) && Math.abs(num(a) - num(b)) <= tol
const clampTo = (v, lo, hi) => Math.min(Number.isFinite(hi) ? hi : v, Math.max(Number.isFinite(lo) ? lo : v, v))
// 팬 속도는 단계로 맞춰진다(예: 3단 팬은 33.3% 단위). 한 단계 안이면 요청이 먹은 것으로 본다.
const fanPctOk = (a, want) => (want === 0 ? null : near(a.percentage, want, Math.max(1, Number(a.percentage_step) || 1)))

// 요청한 값이 지금 상태에 반영됐는가. true: 확인됨, false: 아직 아님, null: 이 서비스는 상태로 확인할 방법이 없음.
// 켜기만 보고 성공으로 치지 않는다: 이미 켜진 조명의 밝기를 바꾸면 밝기까지, 선택값·숫자값은 그 값까지 맞아야 한다.
export function controlReached(domain, service, data = {}, st) {
	if (!st || DEAD.has(st.state)) return false
	const a = st.attributes ?? {}, s = st.state, d = data ?? {}
	if (domain === 'script' || domain === 'scene') return null
	switch (`${domain}.${service}`) {
		case 'climate.turn_on': return s !== 'off'
		case 'climate.turn_off': return s === 'off'
		case 'climate.set_hvac_mode': return s === String(d.hvac_mode)
		case 'climate.set_temperature': return near(a.temperature, d.temperature, 0.25) && (d.hvac_mode == null || s === String(d.hvac_mode))
		case 'fan.set_percentage': return d.percentage === 0 ? s === 'off' : s === 'on' && fanPctOk(a, d.percentage) === true
		case 'fan.set_preset_mode': return a.preset_mode === d.preset_mode
		case 'humidifier.set_humidity': return near(a.humidity, d.humidity, 1)
		case 'humidifier.set_mode': return a.mode === d.mode
		case 'cover.open_cover': return s === 'open' || s === 'opening'
		case 'cover.close_cover': return s === 'closed' || s === 'closing'
		case 'cover.set_cover_position': return near(a.current_position, d.position, 2) || s === 'opening' || s === 'closing'
		case 'cover.stop_cover': return null
		case 'media_player.media_play': return s === 'playing'
		case 'media_player.media_pause': return s === 'paused'
		case 'media_player.media_stop': return !['playing', 'paused', 'buffering'].includes(s)
		case 'media_player.volume_set': return near(a.volume_level, d.volume_level, 0.02)
		case 'media_player.volume_mute': return a.is_volume_muted === d.is_volume_muted
		case 'media_player.select_source': return a.source === d.source
		case 'select.select_option':
		case 'input_select.select_option': return s === String(d.option)
		case 'number.set_value':
		case 'input_number.set_value': return near(s, d.value, Math.max(1e-6, (Number(a.step) || 0) / 2))
		case 'input_datetime.set_datetime': {
			const t = v => (/^\d{2}:\d{2}$/.test(v) ? `${v}:00` : v)
			if (d.datetime) return s === t(String(d.datetime).replace('T', ' '))
			return (!d.date || s.startsWith(d.date)) && (!d.time || s.endsWith(t(d.time)))
		}
		case 'vacuum.start': return s === 'cleaning'
		case 'vacuum.pause': return s === 'paused'
		case 'vacuum.return_to_base': return s === 'returning' || s === 'docked'
	}
	if (service === 'turn_off') return ['off', 'standby'].includes(s)
	if (service !== 'turn_on') return null
	if (s !== 'on') return false
	if (domain === 'light') {
		// 켜져 있어도 밝기·색온도를 요청했으면 그 값까지 맞아야 한다. 값을 보고하지 않는 조명이면 확인하지 못한 것으로 둔다.
		if (d.brightness != null && !near(a.brightness, d.brightness, 3)) return false
		if (d.brightness_pct != null && !near(a.brightness, Math.round(d.brightness_pct * 255 / 100), 3)) return false
		if (d.color_temp_kelvin != null) {
			const want = clampTo(d.color_temp_kelvin, num(a.min_color_temp_kelvin), num(a.max_color_temp_kelvin))
			if (!near(a.color_temp_kelvin, want, Math.max(50, want * 0.02))) return false
		}
	}
	if (domain === 'fan') {
		if (d.percentage != null && d.percentage > 0 && fanPctOk(a, d.percentage) !== true) return false
		if (d.preset_mode != null && a.preset_mode !== d.preset_mode) return false
	}
	return true
}

// 서비스 이름이 허용 목록(정확한 이름 또는 'switch.turn_*' 같은 끝 별표)에 드는가.
// 이름이 템플릿이면 고정된 앞부분이 별표 범위에 통째로 들어갈 때만 true. true: 허용, false: 허용 밖, null: 대조할 수 없음
export function serviceAllowed(svc, allowed) {
	const pats = [...allowed]
	const tpl = hasTemplate(svc)
	const head = tpl ? String(svc).split(/\{\{|\{%/)[0] : String(svc)
	for (const pat of pats) {
		if (pat.endsWith('*')) { if (head.startsWith(pat.slice(0, -1))) return true }
		else if (!tpl && pat === head) return true
	}
	if (!tpl) return false
	// 템플릿: 고정된 앞부분이 어떤 허용 항목과도 맞을 수 없으면 허용 밖, 맞을 수도 있으면 대조 불가
	return pats.some(pat => pat.startsWith(head) || head.startsWith(pat.replace(/\*$/, ''))) ? null : false
}

// 스크립트가 HA 안에서 움직이는 기기와 그 범위 검사.
// scope: src/core/script-scope.mjs의 analyzeScriptScope 결과({ devices, dynamic, candidates }).
// declared: config.json policy.script_targets[스크립트] = { entities: [...], services: [...] } (사용자가 허용한 최종 기기·동작)
const ENTITY_TOKEN_RE = /\b([a-z_]+)\.([a-z0-9_]+)\b/g
const DEVICE_DOMAINS = new Set(['light', 'switch', 'fan', 'cover', 'climate', 'humidifier', 'media_player', 'input_boolean', 'lock', 'alarm_control_panel', 'vacuum', 'scene', 'script', 'automation', 'select', 'input_select', 'number', 'input_number', 'siren', 'valve', 'water_heater', 'button', 'input_button', 'remote', 'camera', 'update', 'lawn_mower'])
export function entityTokens(value, out = new Set()) {
	if (typeof value === 'string') {
		for (const m of value.matchAll(ENTITY_TOKEN_RE)) if (DEVICE_DOMAINS.has(m[1])) out.add(`${m[1]}.${m[2]}`)
	} else if (Array.isArray(value)) for (const v of value) entityTokens(v, out)
	else if (value && typeof value === 'object') for (const v of Object.values(value)) entityTokens(v, out)
	return out
}

const toIdList = v => (v == null ? [] : Array.isArray(v) ? v : [v])

export class PolicyEngine {
	constructor(cfg = {}) {
		this.cfg = cfg
		const a = cfg.actions ?? {}
		const p = cfg.policy ?? {}
		this.enabled = Boolean(a.enabled)
		this.adminEnabled = Boolean(p.admin_enabled)
		this.tier3Blocked = globs([...DEFAULT_TIER3_PATTERNS, ...(p.tier3_blocked ?? [])])
		// Tier 3 엔티티가 있을 수 있는 도메인. 이 도메인의 서비스는 방·기기 단위나 템플릿 대상으로 부를 수 없다.
		this.tier3Domains = new Set(['homeassistant', ...TIER3_DOMAINS])
		for (const pat of [...DEFAULT_TIER3_PATTERNS, ...(p.tier3_blocked ?? [])]) {
			const dom = String(pat).split('.')[0]
			if (dom && !dom.includes('*')) this.tier3Domains.add(dom)
		}
		this.awayOverrideExempt = new Set(p.away_override_exempt ?? ['light.hwanpunggi', 'switch.geosil_gonggiceongjeonggi_power'])
		// 스크립트별로 사용자가 허용한 최종 기기·동작. Tier 3 기기는 적어 두어도 허용하지 않는다.
		this.scriptTargets = new Map()
		for (const [id, t] of Object.entries(p.script_targets ?? {})) {
			if (!id.startsWith('script.') || !t || typeof t !== 'object') continue
			this.scriptTargets.set(id, {
				entities: new Set((t.entities ?? []).filter(e => typeof e === 'string' && !this.isTier3Blocked(e))),
				services: Array.isArray(t.services) && t.services.length ? new Set(t.services.map(String)) : null,
			})
		}

		this.tiers = new Map()
		this.blockedInConfig = new Set()
		if (this.enabled) {
			const rawIds = [...(a.auto ?? []), ...(p.tier1_auto ?? []), ...(a.confirm ?? []), ...(p.tier2_confirm ?? [])]
			for (const id of rawIds) if (typeof id === 'string' && this.isTier3Blocked(id)) this.blockedInConfig.add(id)
			const okId = id => typeof id === 'string' && ACTION_SERVICES[id.split('.')[0]] && !this.isTier3Blocked(id)
			for (const id of [...(a.auto ?? []), ...(p.tier1_auto ?? [])].filter(okId)) this.tiers.set(id, 'auto')
			// 양쪽에 다 있으면 더 조심스러운 confirm(Tier 2)이 이긴다.
			for (const id of [...(a.confirm ?? []), ...(p.tier2_confirm ?? [])].filter(okId)) this.tiers.set(id, 'confirm')
		}
	}

	isTier3Blocked(entityId) {
		if (typeof entityId !== 'string') return true
		const dom = entityId.split('.')[0]
		if (TIER3_DOMAINS.has(dom)) return true
		return this.tier3Blocked(entityId)
	}

	tiersMap() { return new Map(this.tiers) }

	evaluateControl(req, { states, quiet = false, usedToday = 0, perDay = 20, pending = [], awayOverrideOn = false, requested = false, scriptFields = null } = {}) {
		const id = req?.entity_id
		const service = req?.service ?? req?.action
		if (!this.tiers.size) return { ok: false, error: '행동 권한이 꺼져 있다(알림만 가능)' }
		if (this.isTier3Blocked(id)) {
			return {
				ok: false,
				error: this.blockedInConfig.has(id)
					? `안전 정책(Tier 3)으로 차단된 엔티티: ${id}`
					: `허용 목록에 없는 엔티티 (안전 정책 Tier 3 차단: ${id})`,
			}
		}
		const tier = this.tiers.get(id)
		if (!tier) return { ok: false, error: '허용 목록에 없는 엔티티' }
		const domain = id.split('.')[0]
		if (!(ACTION_SERVICES[domain] ?? []).includes(service)) return { ok: false, error: `${domain}에는 ${service}을 쓸 수 없다` }
		const st = states?.get?.(id)
		if (!st) return { ok: false, error: '없는 엔티티' }
		if (DEAD.has(st.state)) return { ok: false, error: `엔티티가 ${st.state} 상태라 움직일 수 없다` }
		const dataCheck = validateServiceData(domain, service, req.service_data ?? {}, st)
		if (typeof dataCheck === 'string') return { ok: false, error: dataCheck }
		const serviceData = dataCheck.data
		let approvalReason = null
		if (domain === 'script') {
			const bad = checkScriptVariables(id, serviceData.variables ?? {}, scriptFields)
			if (bad) return { ok: false, error: bad }
			const sc = this.checkScriptScope(id, serviceData.variables ?? {}, scriptFields?.get?.(id))
			if (sc.error) return { ok: false, error: sc.error }
			approvalReason = sc.approval ?? null
		}
		if (isAlreadyReached(domain, service, serviceData, st)) return { ok: true, noop: true }
		if (usedToday >= perDay) return { ok: false, error: `오늘 행동 한도(${perDay}회)에 닿았다` }
		if (pending.some(p => p.entity_id === id)) return { ok: false, error: '같은 엔티티의 승인 요청이 이미 기다리는 중' }
		if (awayOverrideOn && !requested && OFF_LIKE.has(service) && !this.awayOverrideExempt.has(id)) {
			return { ok: false, error: '가족·손님 재실 도우미가 켜져 있어 자율 소등을 차단했다' }
		}
		// 움직일 기기를 미리 알 수 없는 스크립트는 Tier 1이어도, 직접 요청이어도 승인을 거친다.
		const effTier = approvalReason ? 'confirm' : tier
		if (quiet && !requested && (effTier === 'confirm' || !QUIET_SAFE_SERVICES.has(service))) {
			return { ok: false, error: '조용한 시간에는 스스로 끄는 것만 된다. 필요하면 아침으로 예약할 것' }
		}
		return { ok: true, tier: effTier, domain, service, service_data: serviceData, ...(approvalReason ? { needs_approval: true, approval_reason: approvalReason } : {}) }
	}

	// 스크립트가 HA 안에서 실제로 움직이는 기기가 허용 범위 안인지 본다.
	// 돌려주는 값: { error } (실행 안 함) | { approval } (승인을 받아야 함) | {} (그대로 실행)
	checkScriptScope(id, vars = {}, info = null) {
		const scope = info?.scope
		const declared = this.scriptTargets.get(id) ?? null
		if (!scope) return { approval: `${id}가 움직이는 기기를 아직 확인하지 못했어요` }
		const staleApproval = info.stale ? `${id} 설정을 다시 읽지 못해(${info.stale_error ?? '오류'}) 지금 움직이는 기기를 확인할 수 없어요` : null
		const outside = [], unverifiable = []
		for (const d of scope.devices ?? []) {
			if (this.isTier3Blocked(d.entity_id)) return { error: `${id}가 안전 정책(Tier 3) 기기를 움직여 실행하지 않는다: ${d.entity_id}` }
			const inRange = declared ? declared.entities.has(d.entity_id) : this.tiers.has(d.entity_id)
			if (!inRange) outside.push(d.entity_id)
			if (declared?.services) {
				const m = serviceAllowed(d.service, declared.services)
				if (m === false) return { error: `${id}가 허용하지 않은 동작(${d.service})을 해서 실행하지 않는다. 스크립트가 바뀌었으면 policy.script_targets를 고칠 것` }
				if (m === null) unverifiable.push(d.service)
			}
		}
		for (const e of scope.candidates ?? []) {
			if (this.isTier3Blocked(e)) return { error: `${id}가 안전 정책(Tier 3) 기기를 움직일 수 있어 실행하지 않는다: ${e}` }
		}
		const passed = [...entityTokens(vars)]
		const t3 = passed.find(e => this.isTier3Blocked(e))
		if (t3) return { error: `${id}에 안전 정책(Tier 3) 기기를 넘길 수 없다: ${t3}` }
		if (declared) {
			if (outside.length) return { error: `${id}가 허용 범위 밖 기기를 움직여 실행하지 않는다: ${outside.join(', ')} (스크립트가 바뀌었으면 policy.script_targets를 고칠 것)` }
			const badCand = (scope.candidates ?? []).filter(e => !declared.entities.has(e))
			if (badCand.length) return { error: `${id}가 허용 범위 밖 기기를 움직일 수 있어 실행하지 않는다: ${badCand.join(', ')}` }
			const badVar = passed.filter(e => !declared.entities.has(e))
			if (badVar.length) return { error: `${id}에 허용 범위 밖 기기를 넘길 수 없다: ${badVar.join(', ')}` }
			if (declared.services) {
				const dyn = (scope.dynamic ?? []).map(x => x.service).filter(Boolean)
				const badSvc = dyn.filter(s => serviceAllowed(s, declared.services) === false)
				if (badSvc.length) return { error: `${id}가 허용하지 않은 동작(${[...new Set(badSvc)].join(', ')})을 해서 실행하지 않는다` }
				unverifiable.push(...dyn.filter(s => serviceAllowed(s, declared.services) === null))
			}
			if (staleApproval) return { approval: staleApproval }
			// 동작 이름이 템플릿이면 허용 동작과 끝까지 대조할 수 없다. 'switch.turn_*'처럼 적어 두면 그 범위 안으로 본다.
			if (unverifiable.length) return { approval: `${id}의 동작 이름이 실행 때 정해져(${[...new Set(unverifiable)].join(', ').slice(0, 80)}) 허용 동작과 대조할 수 없어요. policy.script_targets.services에 'switch.turn_*'처럼 범위로 적으면 바로 실행할 수 있어요` }
			return {}
		}
		if (staleApproval) return { approval: staleApproval }
		if (outside.length) return { approval: `${id}가 허용 목록 밖 기기(${outside.slice(0, 4).join(', ')})를 움직여요` }
		if ((scope.dynamic ?? []).length) return { approval: `${id}는 움직일 기기가 실행할 때 정해져요(템플릿·다른 자동화 호출). policy.script_targets에 허용 기기를 적으면 바로 실행할 수 있어요` }
		return {}
	}

	checkHaServiceCall(msg) {
		const key = `${msg.domain}.${msg.service}`
		if (TIER3_SERVICES.has(key)) return `안전 정책(Tier 3)으로 차단된 서비스: ${key}`
		if (ADMIN_SERVICES.has(key)) {
			if (!this.adminEnabled) return `HA 관리 서비스 권한이 꺼져 있음: ${key}`
			// 방·기기·층·라벨 대상이나 'all'은 무엇이 포함될지 알 수 없어 막는다.
			const nonEntity = NON_ENTITY_TARGET_KEYS.filter(k => msg.target?.[k] != null)
			if (nonEntity.length) return `관리 서비스는 entity_id 대상만 허용: ${key} (${nonEntity.join(', ')})`
			const ids = [
				...toIdList(msg.target?.entity_id),
				...toIdList(msg.service_data?.entity_id),
				...toIdList(msg.service_data?.new_entity_id),
			]
			for (const id of ids) {
				if (typeof id !== 'string' || !ENTITY_ID_RE.test(id)) return `관리 서비스 대상이 올바른 entity_id가 아님: ${String(id)}`
				if (this.isTier3Blocked(id)) return `안전 정책(Tier 3)으로 차단된 대상: ${id}`
			}
			if (AUTOMATION_ADMIN_SERVICES.has(key)) {
				if (!ids.length) return `${key}에는 automation 엔티티 대상이 필요하다`
				const bad = ids.find(id => !id.startsWith('automation.'))
				if (bad) return `${key}의 대상은 automation 엔티티만 된다: ${bad}`
				if (NON_ENTITY_TARGET_KEYS.some(k => msg.service_data?.[k] != null)) return `${key}는 entity_id 대상만 허용`
			}
			return null
		}
		const t = msg.target ?? {}
		const id = t.entity_id
		if (typeof id !== 'string' || Object.keys(t).length !== 1) return `단일 entity_id 대상만 허용: ${key}`
		if (this.isTier3Blocked(id) || !this.tiers.has(id)) return `허용되지 않은 서비스: ${key} (${id})`
		if (id.split('.')[0] !== msg.domain) return `도메인 불일치: ${key} (${id})`
		const chk = validateServiceData(msg.domain, msg.service, msg.service_data ?? {})
		return typeof chk === 'string' ? chk : null
	}

	// 자동화·스크립트 설정의 동작(서비스 호출·기기 동작) 목록을 검사한다. calls는 ha-admin의 collectConfigCalls 결과.
	// 트리거·조건에서 Tier 3 엔티티의 상태를 읽는 것은 괜찮고, 그것을 움직이는 동작만 막는다. 오류 문장 목록을 돌려준다.
	checkConfigCalls(calls = []) {
		const errors = []
		const add = e => { if (!errors.includes(e)) errors.push(e) }
		for (const c of calls) {
			if (c.kind === 'device') {
				if (CONFIG_BLOCKED_DOMAINS.has(c.domain) || this.tier3Domains.has(c.domain)) {
					add(`기기 동작(${c.domain}.${c.type})은 대상을 확인할 수 없어 허용하지 않음. 서비스 호출과 entity_id로 적을 것`)
				}
				continue
			}
			const svc = String(c.service ?? '')
			const m = /^([a-z_]+)\.(.+)$/.exec(svc)
			if (!m) { add(`서비스 이름을 확인할 수 없음(템플릿 등): ${svc.slice(0, 60)}`); continue }
			const [, domain, name] = m
			if (CONFIG_BLOCKED_DOMAINS.has(domain)) { add(`안전 정책(Tier 3)으로 자동화·스크립트에 넣을 수 없는 동작: ${svc}`); continue }
			if (TIER3_SERVICES.has(svc)) { add(`안전 정책(Tier 3)으로 차단된 서비스: ${svc}`); continue }
			if (NON_ACTING_DOMAINS.has(domain) || NON_ACTING_SERVICES.has(svc)) continue
			// script.<이름>을 서비스처럼 부르는 것은 그 스크립트를 실행하는 것
			if (domain === 'script' && !hasTemplate(name) && !SCRIPT_ENTITY_SERVICES.has(name) && this.isTier3Blocked(`script.${name}`)) {
				add(`안전 정책(Tier 3)으로 차단된 대상: script.${name}`)
			}
			const risky = this.tier3Domains.has(domain)
			if (risky && c.non_entity_targets?.length) add(`${svc}을 방·기기 단위(${c.non_entity_targets.join(', ')})로 부르면 Tier 3 기기가 섞일 수 있어 허용하지 않음. entity_id로 적을 것`)
			for (const id of c.entity_ids ?? []) {
				if (typeof id !== 'string') continue
				if (hasTemplate(id) || id === 'all') {
					if (risky) add(`${svc}의 대상(${id.slice(0, 40)})을 미리 확인할 수 없어 허용하지 않음`)
					continue
				}
				if (ENTITY_ID_RE.test(id) && this.isTier3Blocked(id)) add(`안전 정책(Tier 3)으로 차단된 대상: ${id} (${svc})`)
			}
		}
		return errors
	}

	captureSnapshot(st) {
		if (!st) return null
		const a = st.attributes ?? {}
		const keep = {}
		for (const k of ['brightness', 'color_temp_kelvin', 'percentage', 'preset_mode', 'temperature', 'hvac_mode', 'current_position', 'volume_level', 'is_volume_muted', 'source', 'option', 'humidity', 'mode']) {
			if (a[k] != null) keep[k] = a[k]
		}
		return { state: st.state, attrs: keep }
	}

	buildUndoCall(rec) {
		const id = rec?.entity_id
		if (!id || this.isTier3Blocked(id) || !this.tiers.has(id)) return null
		const domain = id.split('.')[0]
		const snap = rec.prev_snapshot ?? (rec.prev != null ? { state: rec.prev, attrs: {} } : null)
		const action = rec.service ?? rec.action
		const attrs = snap?.attrs ?? {}

		// 이전 상태(스냅샷)를 먼저 본다. 이미 켜진 조명의 밝기만 바꿨으면 끄는 게 아니라 이전 밝기로 켠다.
		const prevOn = snap?.state === 'on' ? true : snap?.state === 'off' ? false : null
		if (domain === 'light') {
			const wasOn = prevOn ?? (action === 'turn_off' ? true : action === 'turn_on' ? false : null)
			if (wasOn === false) return { domain, service: 'turn_off', data: {} }
			if (wasOn === true) {
				const data = {}
				if (typeof attrs.brightness === 'number' && attrs.brightness >= 1) data.brightness = attrs.brightness
				if (typeof attrs.color_temp_kelvin === 'number' && attrs.color_temp_kelvin >= 2000 && attrs.color_temp_kelvin <= 6500) data.color_temp_kelvin = attrs.color_temp_kelvin
				return { domain, service: 'turn_on', data }
			}
		}
		if (domain === 'switch' || domain === 'input_boolean') {
			const wasOn = prevOn ?? (action === 'turn_off' ? true : action === 'turn_on' ? false : null)
			if (wasOn === false) return { domain, service: 'turn_off', data: {} }
			if (wasOn === true) return { domain, service: 'turn_on', data: {} }
		}
		if (domain === 'fan') {
			if (snap?.state === 'off' || (!snap && action === 'turn_on')) return { domain, service: 'turn_off', data: {} }
			const data = {}
			if (typeof attrs.percentage === 'number') data.percentage = attrs.percentage
			if (typeof attrs.preset_mode === 'string') data.preset_mode = attrs.preset_mode
			return { domain, service: 'turn_on', data }
		}
		if (domain === 'humidifier') {
			if (snap?.state === 'off') return { domain, service: 'turn_off', data: {} }
			if (typeof attrs.humidity === 'number' && action === 'set_humidity') return { domain, service: 'set_humidity', data: { humidity: attrs.humidity } }
			return { domain, service: 'turn_on', data: {} }
		}
		if (domain === 'climate') {
			if (snap?.state === 'off') return { domain, service: 'turn_off', data: {} }
			if (action === 'set_temperature' && typeof attrs.temperature === 'number') return { domain, service: 'set_temperature', data: { temperature: attrs.temperature } }
			if (snap?.state && !DEAD.has(snap.state)) return { domain, service: 'set_hvac_mode', data: { hvac_mode: snap.state } }
		}
		if (domain === 'cover') {
			if (typeof attrs.current_position === 'number') return { domain, service: 'set_cover_position', data: { position: attrs.current_position } }
			if (snap?.state === 'open') return { domain, service: 'open_cover', data: {} }
			if (snap?.state === 'closed') return { domain, service: 'close_cover', data: {} }
		}
		if (domain === 'select' || domain === 'input_select') {
			if (snap?.state && !DEAD.has(snap.state)) return { domain, service: 'select_option', data: { option: snap.state } }
		}
		if (domain === 'input_number' || domain === 'number') {
			if (snap?.state != null && Number.isFinite(Number(snap.state))) return { domain, service: 'set_value', data: { value: Number(snap.state) } }
		}
		if (domain === 'media_player') {
			if (action === 'turn_off') return null
			if (action === 'volume_set' && typeof attrs.volume_level === 'number') return { domain, service: 'volume_set', data: { volume_level: attrs.volume_level } }
			if (action === 'volume_mute' && typeof attrs.is_volume_muted === 'boolean') return { domain, service: 'volume_mute', data: { is_volume_muted: attrs.is_volume_muted } }
			if (action === 'select_source' && typeof attrs.source === 'string') return { domain, service: 'select_source', data: { source: attrs.source } }
			if (action === 'media_pause') return { domain, service: 'media_play', data: {} }
			if (action === 'media_play') return { domain, service: 'media_pause', data: {} }
		}
		return null
	}

	describe() {
		const tier1 = [], tier2 = []
		for (const [id, tier] of this.tiers) (tier === 'auto' ? tier1 : tier2).push(id)
		return {
			enabled: this.enabled,
			admin_enabled: this.adminEnabled,
			tier0_read: '전체 상태·기록·트레이스·통합·백업·템플릿·check_config',
			tier1_auto: tier1,
			tier2_confirm: tier2,
			tier3_blocked: [...DEFAULT_TIER3_PATTERNS, ...(this.cfg.policy?.tier3_blocked ?? [])],
			away_override_exempt: [...this.awayOverrideExempt],
			script_targets: Object.fromEntries([...this.scriptTargets].map(([id, t]) => [id, { entities: [...t.entities], services: t.services ? [...t.services] : null }])),
		}
	}
}
