// HA WebSocket + REST 연결: 상태 변화와 알림 버튼 이벤트를 받고, 정책 게이트를 통과한 읽기·알림·제어·관리 요청만 호출한다.
// 기기를 움직이는 서비스와 설정 수정은 checkMessage/checkRest에서 화이트리스트·PolicyEngine으로 검증한다.
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { log } from './util.mjs'

export const HEARTBEAT_EVENT = 'haagent_heartbeat'
const READ_TYPES = [
	'get_states', 'subscribe_events', 'ping', 'history/history_during_period',
	'config/area_registry/list', 'config/device_registry/list', 'config/entity_registry/list',
	'config/label_registry/list', 'config/floor_registry/list',
	'automation/config', 'script/config', 'scene/config',
	'repairs/list_issues', 'system_log/list', 'logbook/get_events', 'recorder/statistics_during_period',
	'trace/list', 'trace/get', 'config_entries/get', 'backup/info',
	'lovelace/dashboards/list', 'lovelace/config',
	'assist_pipeline/pipeline/list', 'conversation/agent/list',
]
const ALLOWED_TYPES = new Set([...READ_TYPES, 'call_service', 'fire_event'])
const READ_SERVICES = ['weather.get_forecasts', 'calendar.get_events']
// 행동으로 쓸 수 있는 기본 서비스. 도어락·경보·차고문 같은 도메인은 여기에 없다.
export const ACTION_SERVICES = {
	light: ['turn_on', 'turn_off'],
	switch: ['turn_on', 'turn_off'],
	fan: ['turn_on', 'turn_off', 'set_percentage', 'set_preset_mode'],
	humidifier: ['turn_on', 'turn_off', 'set_humidity', 'set_mode'],
	climate: ['turn_on', 'turn_off', 'set_temperature', 'set_hvac_mode'],
	cover: ['open_cover', 'close_cover', 'stop_cover', 'set_cover_position'],
	input_boolean: ['turn_on', 'turn_off'],
	media_player: ['turn_off', 'media_pause', 'media_play', 'media_stop', 'volume_set', 'volume_mute', 'select_source'],
	select: ['select_option'],
	input_select: ['select_option'],
	input_number: ['set_value'],
	number: ['set_value'],
	input_datetime: ['set_datetime'],
	scene: ['turn_on'],
	script: ['turn_on'],
	vacuum: ['start', 'pause', 'return_to_base'],
}
const LEGACY_ACTION_SERVICES = {
	light: ['turn_on', 'turn_off'],
	switch: ['turn_on', 'turn_off'],
	fan: ['turn_on', 'turn_off'],
	humidifier: ['turn_on', 'turn_off'],
	input_boolean: ['turn_on', 'turn_off'],
	media_player: ['turn_off'],
}

// 보내기 전 검사. 통과하지 못하면 이유를 돌려준다.
export function checkMessage(msg, { services, actionEntities = new Set(), policy = null }) {
	if (!ALLOWED_TYPES.has(msg.type)) return `허용되지 않은 명령: ${msg.type}`
	if (msg.type === 'fire_event' && msg.event_type !== HEARTBEAT_EVENT) return `허용되지 않은 이벤트: ${msg.event_type}`
	if (msg.type !== 'call_service') return null
	const key = `${msg.domain}.${msg.service}`
	if (services.has(key)) return null
	if (policy) return policy.checkHaServiceCall(msg)
	const t = msg.target ?? {}
	const id = t.entity_id
	const isAction = typeof id === 'string' && Object.keys(t).length === 1 && actionEntities.has(id)
		&& id.split('.')[0] === msg.domain && (LEGACY_ACTION_SERVICES[msg.domain] ?? []).includes(msg.service)
		&& !Object.keys(msg.service_data ?? {}).length
	return isAction ? null : `허용되지 않은 서비스: ${key}${id ? ` (${id})` : ''}`
}

const CFG_PATH_RE = /^\/api\/config\/(?:automation|script|scene)\/config\/[^/?#]+$/
// REST API 호출 검사. 읽기/검증은 기본 허용, 설정 쓰기/삭제는 guard.allowConfigWrite가 참일 때만 통과한다.
export function checkRest(method, path, { allowConfigWrite = false } = {}) {
	const m = String(method || '').toUpperCase()
	const p = String(path || '')
	if (m === 'GET' && (p === '/api/config' || CFG_PATH_RE.test(p))) return null
	if (m === 'POST' && (p === '/api/template' || p === '/api/config/core/check_config')) return null
	if (allowConfigWrite && (m === 'POST' || m === 'DELETE') && CFG_PATH_RE.test(p)) return null
	return `허용되지 않은 REST 호출: ${m} ${p}`
}

export class HA extends EventEmitter {
	// services: 추가로 허용할 서비스(예: 주간 보고서를 올리는 persistent_notification.create)
	// openTimeoutMs: 접속부터 준비 완료(구독·상태 받기)까지 이 시간 안에 못 끝내면 끊고 다시 연결한다.
	constructor({ url, tokenFile, notifyTargets, actionEntities = [], services = [], policy = null, allowConfigWrite = false, openTimeoutMs = 60000 }) {
		super()
		this.url = url
		this.tokenFile = tokenFile
		this.openTimeoutMs = openTimeoutMs
		this.guard = {
			services: new Set([...READ_SERVICES, ...notifyTargets.map(t => `notify.${t}`), ...services]),
			actionEntities: new Set(actionEntities),
			policy,
			allowConfigWrite,
		}
		this.connected = false
		this.backoff = 5000
		this.ws = null
		this.stopped = false
		this.reconnect = null
	}

	start() { this.#open() }
	stop() {
		this.stopped = true
		clearInterval(this.pingTimer)
		clearTimeout(this.reconnect)
		clearTimeout(this.openTimer)
		try { this.ws?.close() } catch {}
	}

	httpBaseUrl() {
		return String(this.url)
			.replace(/^ws:\/\//, 'http://')
			.replace(/^wss:\/\//, 'https://')
			.replace(/\/api\/websocket\/?$/, '')
	}

	#readToken() {
		const token = readFileSync(this.tokenFile, 'utf8').trim()
		if (!token) throw new Error('토큰 파일이 비어 있음')
		return token
	}

	#open() {
		this.reconnect = null
		const ws = new WebSocket(this.url)
		this.ws = ws
		this.nextId = 1
		this.pending = new Map()
		this.subs = new Map()
		ws.onmessage = e => {
			if (this.ws !== ws) return
			try { this.#onMessage(JSON.parse(e.data)) } catch (err) { this.#lost(`메시지 파싱 실패: ${err.message}`) }
		}
		ws.onclose = () => { if (this.ws === ws) this.#lost('연결 끊김') }
		// Node 22의 WebSocket은 접속 자체가 실패하면(연결 거부·네트워크 순간 끊김·101이 아닌 응답) error만 보내고 close는 보내지 않는다.
		// 그래서 error도 끊김으로 다뤄야 다시 연결한다. 2026-11-14 23:00 Tailscale이 몇 초 끊긴 사이 재연결이 한 번 실패한 뒤 영영 멈췄다.
		ws.onerror = () => { if (this.ws === ws) this.#lost(ws.readyState === WebSocket.CONNECTING ? '연결 실패' : '연결 오류') }
		// 접속이 응답 없이 걸려 있는 경우(어떤 이벤트도 오지 않음)도 시간을 정해 끊는다.
		clearTimeout(this.openTimer)
		this.openTimer = setTimeout(() => { if (this.ws === ws && !this.connected) this.#lost('연결 시간 초과') }, this.openTimeoutMs)
	}

	#lost(why) {
		const was = this.connected
		this.connected = false
		clearInterval(this.pingTimer)
		clearTimeout(this.openTimer)
		const ws = this.ws
		this.ws = null
		try { ws?.close() } catch {}
		const pending = [...(this.pending?.values() ?? [])]
		this.pending?.clear()
		for (const p of pending) p.rej(new Error(why))
		if (was) this.emit('disconnected')
		// 끊기는 순간 대기 중이던 ping이 거절되면서 다시 불릴 수 있다. 재연결은 한 번만 건다.
		if (this.stopped || this.reconnect) return
		log(`HA ${why}, ${Math.round(this.backoff / 1000)}초 뒤 다시 연결`)
		this.reconnect = setTimeout(() => this.#open(), this.backoff)
		this.backoff = Math.min(this.backoff * 2, 60000)
	}

	#onMessage(m) {
		if (m.type === 'auth_required') {
			try {
				this.ws.send(JSON.stringify({ type: 'auth', access_token: this.#readToken() }))
			} catch (err) {
				log('HA 인증 준비 실패:', err.message)
				this.#lost(`인증 준비 실패: ${err.message}`)
			}
		} else if (m.type === 'auth_ok') {
			this.#ready().catch(e => this.#lost(`초기화 실패: ${e.message}`))
		} else if (m.type === 'auth_invalid') {
			log('HA 인증 실패: 토큰 파일을 확인하세요')
			this.#lost('인증 실패')
		} else if (m.type === 'event') {
			const name = this.subs.get(m.id)
			if (name) this.emit(name, m.event.data, m.event)
		} else if (this.pending.has(m.id)) {
			const p = this.pending.get(m.id)
			this.pending.delete(m.id)
			if (m.type === 'pong' || m.success) p.res(m.result)
			else p.rej(new Error(m.error?.message ?? JSON.stringify(m.error)))
		}
	}

	async #ready() {
		await this.#subscribe('state_changed', 'state')
		await this.#subscribe('mobile_app_notification_action', 'action')
		const states = await this.call({ type: 'get_states' })
		clearTimeout(this.openTimer)
		this.connected = true
		this.backoff = 5000
		this.pingTimer = setInterval(() => {
			this.call({ type: 'ping' }, 10000).catch(() => { if (this.connected) this.#lost('응답 없음') })
		}, 30000)
		this.emit('ready', states)
	}

	#subscribe(event_type, name) {
		this.subs.set(this.nextId, name)
		return this.call({ type: 'subscribe_events', event_type })
	}

	call(msg, timeoutMs = 30000) {
		const bad = checkMessage(msg, this.guard)
		if (bad) return Promise.reject(new Error(bad))
		const ws = this.ws
		if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('HA 연결 없음'))
		const id = this.nextId++
		const pending = this.pending
		return new Promise((res, rej) => {
			const t = setTimeout(() => { pending.delete(id); rej(new Error(`시간 초과: ${msg.type}`)) }, timeoutMs)
			pending.set(id, { res: v => { clearTimeout(t); res(v) }, rej: e => { clearTimeout(t); rej(e) } })
			try {
				ws.send(JSON.stringify({ id, ...msg }))
			} catch (e) {
				clearTimeout(t)
				pending.delete(id)
				rej(e)
			}
		})
	}

	callService(domain, service, { data = {}, target, response = false } = {}) {
		return this.call({
			type: 'call_service', domain, service, service_data: data,
			...(target ? { target } : {}),
			...(response ? { return_response: true } : {}),
		})
	}

	async rest(method, path, body = null, { timeoutMs = 15000, fetchFn = fetch } = {}) {
		const bad = checkRest(method, path, this.guard)
		if (bad) throw new Error(bad)
		const token = this.#readToken()
		const url = `${this.httpBaseUrl()}${path}`
		const res = await fetchFn(url, {
			method: method.toUpperCase(),
			headers: { authorization: `Bearer ${token}`, ...(body != null ? { 'content-type': 'application/json' } : {}) },
			...(body != null ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(timeoutMs),
		})
		const text = await res.text()
		if (!res.ok) throw new Error(`HA REST ${res.status}: ${text.slice(0, 200)}`)
		try { return JSON.parse(text) } catch { return text }
	}

	// HA 쪽 자동화가 이 신호가 끊기는지 지켜본다(ha/heartbeat-automation.yaml).
	heartbeat(data) { return this.call({ type: 'fire_event', event_type: HEARTBEAT_EVENT, event_data: data }, 10000) }

	#period(hours) {
		const end = new Date()
		return { start_time: new Date(end.getTime() - hours * 3600000).toISOString(), end_time: end.toISOString() }
	}

	history(entityIds, hours) {
		return this.call({
			type: 'history/history_during_period', ...this.#period(hours),
			entity_ids: entityIds, minimal_response: true, no_attributes: true, significant_changes_only: false,
		}, 60000)
	}

	// 장기 통계(평균·최소·최대). 7일까지는 시간 단위, 그보다 길면 하루 단위.
	statistics(entityIds, hours) {
		return this.call({
			type: 'recorder/statistics_during_period', ...this.#period(hours),
			statistic_ids: entityIds, period: hours <= 168 ? 'hour' : 'day', types: ['mean', 'min', 'max', 'state'],
		}, 60000)
	}

	// 무엇이(자동화·사람) 바꿨는지까지 나오는 활동 기록
	logbook(entityIds, hours) {
		return this.call({ type: 'logbook/get_events', ...this.#period(hours), entity_ids: entityIds }, 60000)
	}

	traces(domain = 'automation', itemId = null) {
		return this.call({ type: 'trace/list', domain, ...(itemId ? { item_id: itemId } : {}) }, 30000)
	}

	traceDetail(domain, itemId, runId) {
		return this.call({ type: 'trace/get', domain, item_id: itemId, run_id: runId }, 30000)
	}

	configEntries() {
		return this.call({ type: 'config_entries/get' }, 30000)
	}

	backupInfo() {
		return this.call({ type: 'backup/info' }, 30000)
	}

	checkConfig() {
		return this.rest('POST', '/api/config/core/check_config')
	}

	renderTemplate(template) {
		return this.rest('POST', '/api/template', { template })
	}

	getConfigRest(domain, id) {
		return this.rest('GET', `/api/config/${encodeURIComponent(domain)}/config/${encodeURIComponent(id)}`)
	}

	saveConfigRest(domain, id, config) {
		return this.rest('POST', `/api/config/${encodeURIComponent(domain)}/config/${encodeURIComponent(id)}`, config)
	}

	deleteConfigRest(domain, id) {
		return this.rest('DELETE', `/api/config/${encodeURIComponent(domain)}/config/${encodeURIComponent(id)}`)
	}
}
