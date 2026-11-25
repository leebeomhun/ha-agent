// 기기 건강 점검: 오래 응답 없는 기기, 배터리 부족, 약한 무선 신호, 방(영역)이 지정되지 않은 제어 기기.
// HA 상태만 보고 판단하는 결정론적 점검이라 매일 돌려도 비용이 없다. 새로 생긴 문제만 알림으로 보낸다.

const HEALTH_DOMAINS = new Set(['light', 'switch', 'sensor', 'binary_sensor', 'climate', 'fan', 'cover', 'media_player', 'lock', 'vacuum', 'humidifier', 'select', 'number', 'button', 'device_tracker'])
const CONTROL_DOMAINS = new Set(['light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'lock', 'vacuum', 'humidifier'])
const HOUR = 3600000

export const DEFAULT_HEALTH = { unavailable_hours: 6, battery_pct: 20, lqi_min: 40, rssi_min: -85 }

const nameOf = s => s?.attributes?.friendly_name ?? s?.entity_id

export function scanDeviceHealth({ states, meta = {}, now = Date.now(), isNoise = () => false, cfg = {} } = {}) {
	const h = { ...DEFAULT_HEALTH, ...(cfg.health ?? {}) }
	const unavailable = [], low_battery = [], weak_signal = [], no_area = []
	for (const s of states?.values?.() ?? []) {
		const id = s.entity_id
		const domain = id.split('.')[0]
		if (!HEALTH_DOMAINS.has(domain) || isNoise(id)) continue
		const a = s.attributes ?? {}
		if (s.state === 'unavailable') {
			const since = Date.parse(s.last_changed)
			const hours = Number.isFinite(since) ? (now - since) / HOUR : null
			if (hours != null && hours >= h.unavailable_hours) unavailable.push({ entity_id: id, name: nameOf(s), hours: Math.round(hours), area: meta.areaOf?.get?.(id) ?? null })
			continue
		}
		const num = Number(s.state)
		if (a.device_class === 'battery') {
			if (domain === 'sensor' && Number.isFinite(num) && num <= h.battery_pct) low_battery.push({ entity_id: id, name: nameOf(s), level: num })
			else if (domain === 'binary_sensor' && s.state === 'on') low_battery.push({ entity_id: id, name: nameOf(s), level: 'low' })
			continue
		}
		if (domain === 'sensor' && Number.isFinite(num)) {
			if (/(^|_)lqi($|_)/.test(id.split('.')[1]) && num < h.lqi_min) weak_signal.push({ entity_id: id, name: nameOf(s), value: num, kind: 'LQI' })
			else if ((a.device_class === 'signal_strength' || /(^|_)rssi($|_)/.test(id.split('.')[1])) && a.unit_of_measurement === 'dBm' && num < h.rssi_min) {
				weak_signal.push({ entity_id: id, name: nameOf(s), value: num, kind: 'RSSI' })
			}
		}
		if (CONTROL_DOMAINS.has(domain) && meta.areaOf && !meta.areaOf.has(id) && !meta.catOf?.has?.(id)) no_area.push({ entity_id: id, name: nameOf(s) })
	}
	unavailable.sort((x, y) => y.hours - x.hours)
	low_battery.sort((x, y) => (Number(x.level) || 0) - (Number(y.level) || 0))
	return { unavailable, low_battery, weak_signal, no_area, thresholds: h }
}

// 알림할 문제의 키(영역 미지정은 정리 제안 대상일 뿐 알림하지 않는다)
export function healthIssueKeys(report) {
	return [
		...report.unavailable.map(x => `unavailable:${x.entity_id}`),
		...report.low_battery.map(x => `battery:${x.entity_id}`),
		...report.weak_signal.map(x => `signal:${x.entity_id}`),
	]
}

// 지난번에 본 문제(seen) 말고 새로 생긴 것만 알림 문구로
export function newHealthIssues(report, seen = []) {
	const old = new Set(seen)
	const lines = []
	for (const x of report.unavailable) if (!old.has(`unavailable:${x.entity_id}`)) lines.push(`응답 없음 ${x.hours}시간째: ${x.name}${x.area ? ` (${x.area})` : ''}`)
	for (const x of report.low_battery) if (!old.has(`battery:${x.entity_id}`)) lines.push(`배터리 부족${x.level === 'low' ? '' : ` ${x.level}%`}: ${x.name}`)
	for (const x of report.weak_signal) if (!old.has(`signal:${x.entity_id}`)) lines.push(`신호 약함(${x.kind} ${x.value}): ${x.name}`)
	return lines
}
