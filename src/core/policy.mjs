// Risk Tier 0~3 정책 엔진: 기기 제어 파라미터 검증, 안전 가드레일(Tier 3 차단, 재실 도우미, 조용한 시간), 스냅샷 기반 Undo, HA 관리 서비스 검사.
import { ACTION_SERVICES } from '../ha.mjs'
import { globs } from '../util.mjs'

const DEAD = new Set(['unavailable', 'unknown'])
export const TIER3_DOMAINS = new Set(['lock', 'alarm_control_panel', 'update'])
export const TIER3_SERVICES = new Set(['homeassistant.restart', 'homeassistant.stop', 'update.install'])
export const DEFAULT_TIER3_PATTERNS = [
	'lock.*',
	'alarm_control_panel.*',
	'update.*',
	'switch.jubang_jubang_hairaiteu*',
	'switch.geosil_geosil_seumateu_peulreogeu*',
	'switch.setagsil_setagsil_setaggi_power',
	'switch.setagsil_setagsil_geonjogi_power',
	'script.unknown',
	'input_boolean.kona_*',
	'select.*_jeongjeon_bosang_*',
	'select.hwajangsil_seuwici_*',
]
export const ADMIN_SERVICES = new Set([
	'automation.turn_on', 'automation.turn_off', 'automation.toggle', 'automation.reload', 'automation.trigger',
	'script.reload',
	'homeassistant.reload_config_entry', 'homeassistant.check_config', 'homeassistant.list_orphaned_database_entities',
	'homeassistant.rename_entity', 'homeassistant.add_entity_to_area', 'homeassistant.add_label_to_entity',
	'homeassistant.disable_entity', 'homeassistant.enable_entity', 'homeassistant.hide_entity', 'homeassistant.unhide_entity',
	'backup.create_automatic',
])

const isIntOrNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const isBool = v => typeof v === 'boolean'
const isStr = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 120

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
	script: { turn_on: {} },
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

const toIdList = v => (v == null ? [] : Array.isArray(v) ? v : [v])

export class PolicyEngine {
	constructor(cfg = {}) {
		this.cfg = cfg
		const a = cfg.actions ?? {}
		const p = cfg.policy ?? {}
		this.enabled = Boolean(a.enabled)
		this.adminEnabled = Boolean(p.admin_enabled)
		this.tier3Blocked = globs([...DEFAULT_TIER3_PATTERNS, ...(p.tier3_blocked ?? [])])
		this.awayOverrideExempt = new Set(p.away_override_exempt ?? ['light.hwanpunggi', 'switch.geosil_gonggiceongjeonggi_power'])

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

	evaluateControl(req, { states, quiet = false, usedToday = 0, perDay = 20, pending = [], awayOverrideOn = false, requested = false } = {}) {
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
		if (isAlreadyReached(domain, service, serviceData, st)) return { ok: true, noop: true }
		if (usedToday >= perDay) return { ok: false, error: `오늘 행동 한도(${perDay}회)에 닿았다` }
		if (pending.some(p => p.entity_id === id)) return { ok: false, error: '같은 엔티티의 승인 요청이 이미 기다리는 중' }
		if (awayOverrideOn && !requested && OFF_LIKE.has(service) && !this.awayOverrideExempt.has(id)) {
			return { ok: false, error: '가족·손님 재실 도우미가 켜져 있어 자율 소등을 차단했다' }
		}
		if (quiet && !requested && (tier === 'confirm' || !QUIET_SAFE_SERVICES.has(service))) {
			return { ok: false, error: '조용한 시간에는 스스로 끄는 것만 된다. 필요하면 아침으로 예약할 것' }
		}
		return { ok: true, tier, domain, service, service_data: serviceData }
	}

	checkHaServiceCall(msg) {
		const key = `${msg.domain}.${msg.service}`
		if (TIER3_SERVICES.has(key)) return `안전 정책(Tier 3)으로 차단된 서비스: ${key}`
		if (ADMIN_SERVICES.has(key)) {
			if (!this.adminEnabled) return `HA 관리 서비스 권한이 꺼져 있음: ${key}`
			const ids = [
				...toIdList(msg.target?.entity_id),
				...toIdList(msg.service_data?.entity_id),
				...toIdList(msg.service_data?.new_entity_id),
			]
			for (const id of ids) {
				if (typeof id !== 'string' || this.isTier3Blocked(id)) return `안전 정책(Tier 3)으로 차단된 대상: ${String(id)}`
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

		if (domain === 'light') {
			if (snap?.state === 'off' || action === 'turn_on') return { domain, service: 'turn_off', data: {} }
			if (snap?.state === 'on' || action === 'turn_off') {
				const data = {}
				if (typeof attrs.brightness === 'number') data.brightness = attrs.brightness
				if (typeof attrs.color_temp_kelvin === 'number') data.color_temp_kelvin = attrs.color_temp_kelvin
				return { domain, service: 'turn_on', data }
			}
		}
		if (domain === 'switch' || domain === 'input_boolean') {
			if (snap?.state === 'off' || action === 'turn_on') return { domain, service: 'turn_off', data: {} }
			if (snap?.state === 'on' || action === 'turn_off') return { domain, service: 'turn_on', data: {} }
		}
		if (domain === 'fan') {
			if (snap?.state === 'off') return { domain, service: 'turn_off', data: {} }
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
		}
	}
}
