// 숫자 센서 베이스라인 학습 및 이상 패턴 감지 엔진
import { DAY, kst } from '../util.mjs'

const MIN_SAMPLE_INTERVAL_MS = 5 * 60000
const ANOMALY_PERSIST_MS = 15 * 60000
const ANOMALY_COOLDOWN_MS = 6 * 3600000
const SKIP_ENTITY_RE = /^(sensor\..*_(uptime|timestamp|last_|memory_free|swap_free|time)|sensor\.date|sensor\.time)|_(daily|monthly|month|today|yesterday|this_month|last_month|projected)(_|$)|_(today_s|this_month_s)_consumption/
const SKIP_DEVICE_CLASSES = new Set(['timestamp', 'date', 'enum', 'energy', 'monetary', 'gas', 'water', 'duration'])
const SKIP_STATE_CLASSES = new Set(['total', 'total_increasing'])
const SKIP_UNITS = new Set(['kWh', 'Wh', 'MWh', '원', 'KRW', 'USD'])
const TRACK_DOMAINS = new Set(['sensor'])
const MIN_STD_FLOOR = { '%': 5, '°C': 1.5, 'V': 4, 'W': 40, 'kW': 0.3, 'dBm': 8 }

export class AnomalyEngine {
	constructor({ store = null, isNoise = () => false } = {}) {
		this.store = store
		this.isNoise = isNoise
		this.lastSampleAt = new Map()
		this.pendingSince = new Map()
		this.lastAlertAt = new Map()
		this.baselineCache = null
	}

	isTrackable(entityId, st = null) {
		const dom = String(entityId ?? '').split('.')[0]
		if (!TRACK_DOMAINS.has(dom) || this.isNoise(entityId) || SKIP_ENTITY_RE.test(entityId)) return false
		const a = st?.attributes
		if (a) {
			if (SKIP_DEVICE_CLASSES.has(a.device_class)) return false
			if (SKIP_STATE_CLASSES.has(a.state_class)) return false
			if (SKIP_UNITS.has(a.unit_of_measurement)) return false
		}
		return true
	}

	#ensureCache() {
		if (this.baselineCache) return this.baselineCache
		const map = new Map()
		if (typeof this.store?.listBaselines === 'function') {
			for (const b of this.store.listBaselines()) {
				map.set(`${b.entity_id}|${b.weekday_type}|${b.hour}`, b)
			}
		}
		this.baselineCache = map
		return map
	}

	onNumericState(entityId, st, now = Date.now()) {
		if (!this.store || !st) return false
		if (!this.isTrackable(entityId, st)) return false
		const val = Number(st.state)
		if (!Number.isFinite(val)) return false
		const prev = this.lastSampleAt.get(entityId) ?? 0
		if (now - prev < MIN_SAMPLE_INTERVAL_MS) return false
		this.lastSampleAt.set(entityId, now)
		this.store.recordSensorSample(entityId, val, now)
		return true
	}

	recomputeBaselines(now = Date.now(), states = null) {
		if (!this.store) return 0
		const since = now - 14 * DAY
		const rows = this.store.getRecentSensorSamples(since)
		const buckets = new Map()
		for (const r of rows) {
			const st = states?.get?.(r.entity_id) ?? null
			if (!this.isTrackable(r.entity_id, st)) continue
			const k = kst(new Date(r.ts))
			const wtype = (k.wd === '토' || k.wd === '일') ? 'weekend' : 'weekday'
			const key = `${r.entity_id}|${wtype}|${k.h}`
			let b = buckets.get(key)
			if (!b) { b = { entity_id: r.entity_id, weekday_type: wtype, hour: k.h, vals: [] }; buckets.set(key, b) }
			b.vals.push(r.value)
		}
		const nextRows = []
		const nextCache = new Map()
		for (const b of buckets.values()) {
			if (b.vals.length < 3) continue
			const n = b.vals.length
			const avg = b.vals.reduce((s, v) => s + v, 0) / n
			const variance = b.vals.reduce((s, v) => s + (v - avg) ** 2, 0) / n
			const stddev = Math.sqrt(variance)
			const row = {
				entity_id: b.entity_id,
				weekday_type: b.weekday_type,
				hour: b.hour,
				avg: Math.round(avg * 100) / 100,
				stddev: Math.round(stddev * 100) / 100,
				min_val: Math.min(...b.vals),
				max_val: Math.max(...b.vals),
				sample_count: n,
				updated_at: now,
			}
			nextRows.push(row)
			nextCache.set(`${row.entity_id}|${row.weekday_type}|${row.hour}`, row)
		}
		if (typeof this.store.replaceBaselines === 'function') {
			this.store.replaceBaselines(nextRows)
		} else {
			for (const row of nextRows) this.store.upsertBaseline(row)
		}
		this.baselineCache = nextCache
		this.store.pruneSensorSamples(now - 30 * DAY)
		return nextRows.length
	}

	checkAnomalies(states, now = Date.now()) {
		if (!this.store || !states) return []
		const k = kst(new Date(now))
		const wtype = (k.wd === '토' || k.wd === '일') ? 'weekend' : 'weekday'
		const cache = this.#ensureCache()
		const hits = []
		for (const [id, st] of states) {
			if (!this.isTrackable(id, st)) continue
			const v = Number(st.state)
			if (!Number.isFinite(v)) { this.pendingSince.delete(id); continue }
			const base = cache.get(`${id}|${wtype}|${k.h}`) ?? null
			if (!base || base.sample_count < 6) continue
			const unit = st.attributes?.unit_of_measurement ?? ''
			const floor = MIN_STD_FLOOR[unit] ?? Math.max(Math.abs(base.avg) * 0.1, 1)
			const effStd = Math.max(base.stddev, floor)
			const diff = Math.abs(v - base.avg)
			const z = diff / effStd
			if (z > 3.5 && diff > floor) {
				const since = this.pendingSince.get(id) ?? now
				if (!this.pendingSince.has(id)) this.pendingSince.set(id, now)
				const lastAlert = this.lastAlertAt.get(id) ?? 0
				if (now - since >= ANOMALY_PERSIST_MS && now - lastAlert >= ANOMALY_COOLDOWN_MS) {
					this.lastAlertAt.set(id, now)
					hits.push({
						type: 'anomaly',
						entity_id: id,
						name: st.attributes?.friendly_name ?? id,
						value: v,
						avg: base.avg,
						z: Math.round(z * 10) / 10,
						at: now,
					})
				}
			} else {
				this.pendingSince.delete(id)
			}
		}
		return hits
	}
}
