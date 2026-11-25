// 코드 분석 보완 회귀 테스트 (2026-11-23): 스크립트 필드·Tier 3 설정 검사·HA 이벤트 예외 격리·SQLite 단일 원본·
// 판단 중 도구 제어 한도·승인 제안 스냅샷 재확인·시간 기준 센서 표본
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'haagent-improve-'))
process.env.HAAGENT_DATA_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

const { mergeConfig, saveControl } = await import('../src/config.mjs')
const { P, ROOT, writeJson } = await import('../src/util.mjs')
const { PolicyEngine } = await import('../src/core/policy.mjs')
const { Store } = await import('../src/core/store.mjs')
const { AnomalyEngine } = await import('../src/engine/anomaly.mjs')
const { HaAdmin, collectConfigCalls } = await import('../src/admin/ha-admin.mjs')
const { matchFastCommand } = await import('../src/orchestrator/assist-context.mjs')
const { proposalApprovalPayload } = await import('../src/notify.mjs')
const { HA } = await import('../src/ha.mjs')
const { Agent } = await import('../src/agent.mjs')

const T0 = Date.parse('2026-11-20T12:00:00+09:00')
const MIN = 60000
const st = (entity_id, state, attrs = {}, at = T0) => ({
	entity_id, state,
	attributes: { friendly_name: entity_id, ...attrs },
	last_changed: new Date(at).toISOString(), last_updated: new Date(at).toISOString(),
})
const answer = (x = {}) => ({ summary: 'ok', notifications: [], rule_changes: { upsert: [], delete: [] }, next_wakes: [], memory: { mode: 'keep', text: '' }, memory_ops: [], info_requests: [], actions: [], proposals: [], report: '', ...x })
const flush = () => new Promise(r => setTimeout(r, 20))

function cleanState() {
	rmSync(TMP, { recursive: true, force: true })
	mkdirSync(P.state, { recursive: true })
	saveControl({ paused: false, send: true })
	writeJson(P.rules, { updated: new Date(T0).toISOString(), rules: [] })
}

// 상태를 들고 있다가 서비스 호출에 맞춰 바꾸는 가짜 HA. 상태 변화 이벤트는 호출 응답보다 먼저 보낸다(실제 HA에서 일어나는 순서).
class MockHA extends EventEmitter {
	constructor(states = []) {
		super()
		this.connected = true
		this.map = new Map(states.map(s => [s.entity_id, s]))
		this.calls = []
		this.sent = []
		this.scriptCfg = {}
		this.clock = T0
	}
	start() {}
	stop() {}
	async heartbeat() {}
	async call(m) {
		if (m.type === 'get_states') return [...this.map.values()]
		if (m.type === 'repairs/list_issues') return { issues: [] }
		if (m.type === 'script/config') {
			const c = this.scriptCfg[m.entity_id]
			if (!c) throw new Error('not found')
			return { config: c }
		}
		return []
	}
	set(id, state, attrs = null) {
		const old = this.map.get(id)
		const at = (this.clock += 1000)
		const n = { ...st(id, state, { ...(old?.attributes ?? {}), ...(attrs ?? {}) }, at) }
		this.map.set(id, n)
		this.emit('state', { entity_id: id, old_state: old, new_state: n })
	}
	async callService(domain, service, { data = {}, target } = {}) {
		if (domain === 'notify') { this.sent.push(data); return }
		if (domain === 'weather' || domain === 'calendar') return { response: {} }
		const id = target?.entity_id
		this.calls.push([domain, service, id, data])
		if (domain === 'script') this.set(id, 'off', { last_triggered: new Date(this.clock + 1000).toISOString() })
		else if (service === 'turn_on' || service === 'turn_off') this.set(id, service === 'turn_on' ? 'on' : 'off')
	}
}

function makeAgent({ states, cfg = {}, brain, scriptCfg = {} } = {}) {
	const ha = new MockHA(states)
	ha.scriptCfg = scriptCfg
	const full = mergeConfig({ heartbeat: { enabled: false }, ...cfg, actions: { enabled: true, verify_seconds: 1, ...cfg.actions } })
	const agent = new Agent({ cfg: full, ha, clock: () => T0, canUse: () => false, ...(brain ? { brain } : {}) })
	agent.attach()
	ha.emit('ready', [...ha.map.values()])
	return { agent, ha }
}

test('1. 스크립트: 빠른 경로에서 빠지고, 필수 필드 없이는 실행하지 않으며, variables로 부르면 실행 흔적으로 확인한다', async () => {
	cleanState()
	const { agent, ha } = makeAgent({
		states: [st('script.gonggi_power', 'off', { friendly_name: '공기청정기 전원', last_triggered: '2026-11-19T00:00:00+00:00' }), st('switch.purifier', 'off', { friendly_name: '공기청정기 파워' })],
		cfg: { policy: { tier1_auto: ['script.gonggi_power', 'switch.purifier'] } },
		scriptCfg: { 'script.gonggi_power': { alias: '공기청정기 전원', fields: { on: { description: '켜기(true) 또는 끄기(false)' }, why: { description: '이유' } }, sequence: [] } },
	})
	try {
		// 빠른 경로: "공기청정기 전원 켜줘"가 LLM 없이 script.turn_on으로 가지 않는다(필드 없이 불리면 반대로 꺼진다)
		await agent.loadScriptFields(['script.gonggi_power'])
		const dir = agent.assistDirectory()
		assert.equal(matchFastCommand('공기청정기 전원 켜줘', dir.index), null)
		assert.match(dir.staticText, /script\.gonggi_power .*variables: on\(필수\)=켜기\(true\) 또는 끄기\(false\), why\(필수\)=이유/)

		// 필드 없이 부르면 거절, HA로 아무것도 보내지 않음
		const r1 = await agent.actionExecutor.executeControlItem({ entity_id: 'script.gonggi_power', action: 'turn_on', service_data: {}, reason: '시험', requested: true }, { byUser: true })
		assert.equal(r1.ok, false)
		assert.match(r1.error, /variables\.on, variables\.why/)
		// 선언되지 않은 변수도 거절
		const r2 = await agent.actionExecutor.executeControlItem({ entity_id: 'script.gonggi_power', action: 'turn_on', service_data: { variables: { on: true, why: 'x', extra: 1 } }, reason: '시험', requested: true }, { byUser: true })
		assert.match(r2.error, /없는 변수: extra/)
		assert.equal(ha.calls.length, 0)

		// variables를 다 주면 실행. 스크립트는 금방 off로 돌아가도 last_triggered가 바뀌었으므로 done(10초 기다린 뒤 '확인 안 됨'이 아님)
		const started = Date.now()
		const r3 = await agent.actionExecutor.executeControlItem({ entity_id: 'script.gonggi_power', action: 'turn_on', service_data: { variables: { on: true, why: '습도' } }, reason: '시험', requested: true }, { byUser: true })
		assert.equal(r3.status, 'done')
		assert.ok(Date.now() - started < 900, '확인 시간 상한까지 기다리지 않음')
		assert.deepEqual(ha.calls.at(-1), ['script', 'turn_on', 'script.gonggi_power', { variables: { on: true, why: '습도' } }])
		// 실제 WS 게이트(checkHaServiceCall)도 variables를 받아 준다
		assert.equal(agent.policy.checkHaServiceCall({ type: 'call_service', domain: 'script', service: 'turn_on', target: { entity_id: 'script.gonggi_power' }, service_data: { variables: { on: true, why: 'x' } } }), null)

		// 설정을 받지 못한 스크립트는 실행하지 않는다
		const p = new PolicyEngine(mergeConfig({ actions: { enabled: true }, policy: { tier1_auto: ['script.other'] } }))
		const v = p.evaluateControl({ entity_id: 'script.other', action: 'turn_on' }, { states: new Map([['script.other', st('script.other', 'off')]]), scriptFields: new Map() })
		assert.match(v.error, /설정\(fields\)을 아직 받지 못해/)
		// 필드 없는 스크립트는 variables 없이 그대로 실행된다
		const v2 = p.evaluateControl({ entity_id: 'script.other', action: 'turn_on' }, { states: new Map([['script.other', st('script.other', 'off')]]), scriptFields: new Map([['script.other', { fields: {} }]]) })
		assert.equal(v2.ok, true)
		// 기본값이 있는 필드는 빠져도 된다
		const v3 = p.evaluateControl({ entity_id: 'script.other', action: 'turn_on' }, { states: new Map([['script.other', st('script.other', 'off')]]), scriptFields: new Map([['script.other', { fields: { speed: { default: 'low' } } }]]) })
		assert.equal(v3.ok, true)
	} finally { agent.stop() }
})

test('2. 관리 제안: 자동화·스크립트 동작에 Tier 3가 들어가면 거절하고, 승인 알림에는 트리거·동작 요약을 보여 준다', async () => {
	const states = new Map(['lock.front', 'light.a', 'binary_sensor.door', 'switch.setagsil_setagsil_setaggi_power', 'script.unknown', 'automation.morning']
		.map(id => [id, st(id, 'off')]))
	// 집 특화 Tier 3 기기는 코드 기본값이 아니라 설정(policy.tier3_blocked)에서 온다
	const adm = new HaAdmin({ cfg: mergeConfig({ policy: { admin_enabled: true, tier3_blocked: ['switch.setagsil_setagsil_setaggi_power', 'script.unknown'] } }), ha: { connected: false }, states, meta: {} })
	const propose = (actions, triggers = [{ trigger: 'state', entity_id: 'binary_sensor.door', to: 'on' }], kind = 'automation_upsert') => adm.createProposal({
		kind, target_id: '', title: '시험', summary: '시험',
		payload: { config: kind === 'script_upsert' ? { alias: 's', sequence: actions } : { alias: 'a', triggers, actions } },
	}, T0)

	const cases = [
		[[{ action: 'lock.unlock', target: { entity_id: 'lock.front' } }], /lock\.unlock/],
		[[{ choose: [{ conditions: [], sequence: [{ action: 'homeassistant.restart' }] }] }], /homeassistant\.restart/],
		[[{ action: 'switch.turn_off', target: { area_id: 'laundry' } }], /방·기기 단위\(area_id\)/],
		[[{ action: 'homeassistant.turn_off', target: { entity_id: ['light.a', 'switch.setagsil_setagsil_setaggi_power'] } }], /switch\.setagsil_setagsil_setaggi_power/],
		[[{ action: 'script.unknown' }], /script\.unknown/],
		[[{ action: 'switch.turn_off', target: { entity_id: '{{ target }}' } }], /미리 확인할 수 없어/],
		[[{ device_id: 'abc', domain: 'lock', type: 'unlock' }], /기기 동작\(lock\.unlock\)/],
		[[{ action: 'shell_command.wipe' }], /shell_command\.wipe/],
	]
	for (const [actions, re] of cases) {
		const r = await propose(actions)
		assert.equal(r.ok, false, JSON.stringify(actions))
		assert.match(r.error, re)
	}
	const rs = await propose([{ action: 'lock.lock', target: { entity_id: 'lock.front' } }], undefined, 'script_upsert')
	assert.match(rs.error, /lock\.lock/)

	// 트리거·조건에서 Tier 3 상태를 읽는 것, light를 방 단위로 끄는 것, 알림 버튼 data.actions는 괜찮다
	const ok = await propose(
		[
			{ if: [{ condition: 'state', entity_id: 'lock.front', state: 'unlocked' }], then: [{ action: 'light.turn_off', target: { area_id: 'living' } }] },
			{ action: 'notify.mobile_app_x', data: { message: '문', data: { actions: [{ action: 'URI', title: '열기' }] } } },
			{ action: 'logbook.log', data: { name: '문', message: '열림', entity_id: 'lock.front' } },
		],
		[{ trigger: 'state', entity_id: 'lock.front', to: 'unlocked' }],
	)
	assert.equal(ok.ok, true, ok.error)
	const pay = proposalApprovalPayload(ok.proposal)
	assert.match(pay.message, /트리거: state lock\.front/)
	assert.match(pay.message, /동작: light\.turn_off → area_id \/ notify\.mobile_app_x/)
	assert.deepEqual(collectConfigCalls('automation_upsert', ok.proposal.payload.config).map(c => c.service), ['light.turn_off', 'notify.mobile_app_x', 'logbook.log'])

	// 검사 전에 만들어져 DB에 남은 제안도 승인할 때 다시 막는다
	const dir = mkdtempSync(join(TMP, 'old-prop-'))
	const store = new Store(join(dir, 'p.db'))
	try {
		const adm2 = new HaAdmin({ cfg: mergeConfig({ policy: { admin_enabled: true } }), ha: { connected: false, async callService() { throw new Error('호출되면 안 됨') } }, store, states, meta: {} })
		store.upsertProposal({ pid: 'pold', ts: T0, kind: 'automation_upsert', title: '옛 제안', summary: 's', target_id: '', payload: { config_id: 'x', config: { alias: 'x', triggers: [], actions: [{ action: 'lock.unlock', target: { entity_id: 'lock.front' } }] } }, validation: { valid: true, errors: [] }, status: 'pending', expires: T0 + 3600000 })
		const r = await adm2.approveProposal('pold', T0)
		assert.equal(r.ok, false)
		assert.equal(r.proposal.status, 'error')
		assert.match(r.error, /lock\.unlock/)
	} finally { store.close() }

	// automation_toggle·entity_admin 대상 검사
	assert.match((await adm.createProposal({ kind: 'automation_toggle', target_id: 'all', title: 't', summary: 's' }, T0)).error, /automation 엔티티/)
	assert.equal((await adm.createProposal({ kind: 'automation_toggle', target_id: 'automation.morning', title: 't', summary: 's', payload: { state: 'off' } }, T0)).ok, true)
	assert.match((await adm.createProposal({ kind: 'entity_admin', target_id: 'lock.front', title: 't', summary: 's', payload: { service: 'hide_entity' } }, T0)).error, /Tier 3/)

	// WS 게이트: 관리 서비스는 'all'·방 대상·automation이 아닌 대상을 막는다
	const p = new PolicyEngine(mergeConfig({ policy: { admin_enabled: true } }))
	const svc = (service, target, service_data = {}) => p.checkHaServiceCall({ type: 'call_service', domain: service.split('.')[0], service: service.split('.')[1], target, service_data })
	assert.match(svc('automation.turn_off', { entity_id: 'all' }), /올바른 entity_id가 아님/)
	assert.match(svc('automation.turn_off', { area_id: 'living' }), /entity_id 대상만/)
	assert.match(svc('automation.trigger', { entity_id: 'light.a' }), /automation 엔티티만/)
	assert.match(svc('automation.turn_off', undefined), /automation 엔티티 대상이 필요/)
	assert.equal(svc('automation.turn_off', { entity_id: 'automation.morning' }), null)
	assert.equal(svc('homeassistant.add_entity_to_area', undefined, { entity_id: 'light.a', area_id: 'living' }), null, 'Spook 관리 서비스의 area_id 인자는 그대로 허용')
})

test('3. HA 연결: 이벤트를 처리하는 쪽의 오류로는 연결을 끊지 않고, 깨진 메시지에만 끊는다', async () => {
	const realWS = globalThis.WebSocket
	class FakeWS {
		static CONNECTING = 0
		static OPEN = 1
		constructor() { this.readyState = 1; this.sent = []; FakeWS.last = this }
		send(m) { this.sent.push(JSON.parse(m)) }
		close() { this.closed = true }
	}
	globalThis.WebSocket = FakeWS
	const tokenFile = join(TMP, 'ha-token')
	writeFileSync(tokenFile, 'tok\n')
	const ha = new HA({ url: 'ws://x/api/websocket', tokenFile, notifyTargets: [] })
	try {
		ha.start()
		const ws = FakeWS.last
		const feed = m => ws.onmessage({ data: typeof m === 'string' ? m : JSON.stringify(m) })
		const answerNext = async result => {
			for (let i = 0; i < 50 && !ws.sent.some(s => s.id && !s.answered); i++) await new Promise(r => setImmediate(r))
			const req = ws.sent.find(s => s.id && !s.answered)
			req.answered = true
			feed({ id: req.id, type: 'result', success: true, result })
		}
		feed({ type: 'auth_required' })
		assert.equal(ws.sent[0].type, 'auth')
		let ready = false
		ha.on('ready', () => { ready = true; throw new Error('ready 처리 오류') })
		feed({ type: 'auth_ok' })
		await answerNext(null) // state_changed 구독
		await answerNext(null) // 버튼 이벤트 구독
		await answerNext(null) // 자동화 실행(automation_triggered) 구독
		await answerNext([]) // get_states
		await flush()
		assert.equal(ready, true)
		assert.equal(ha.connected, true, 'ready 처리 오류로 끊지 않음')

		ha.on('state', () => { throw new Error('디스크 가득') })
		const stateSubId = ws.sent.find(s => s.type === 'subscribe_events' && s.event_type === 'state_changed').id
		for (let i = 0; i < 3; i++) feed({ id: stateSubId, type: 'event', event: { data: { entity_id: 'light.a' } } })
		assert.equal(ha.connected, true, '이벤트 처리 오류로 끊지 않음')
		assert.equal(ws.closed, undefined)

		feed('{깨진 JSON')
		assert.equal(ha.connected, false, '파싱 실패는 연결 문제로 보고 다시 연결')
	} finally {
		ha.stop()
		globalThis.WebSocket = realWS
	}
})

test('6. 운영 기록: 버튼·답장·대기 승인은 SQLite를 원본으로 읽고, JSONL 내보내기가 실패해도 동작한다', async () => {
	cleanState()
	const { agent, ha } = makeAgent({ states: [st('light.a', 'off')] })
	try {
		agent.journal.notification({ nid: 'n9', ts: new Date(T0).toISOString(), kind: 'info', level: 'normal', title: '세탁 끝', message: 'm', related_rule_ids: [], tag: 'haagent-n9', status: 'sent' })
		assert.ok(existsSync(P.notifications), 'JSONL로도 내보냄')
		rmSync(P.notifications) // 내보내기 파일이 사라져도(회전·삭제) 원본으로 찾는다
		ha.emit('action', { action: 'REPLY', reply_text: '고마워', tag: 'haagent-n9' })
		await flush()
		assert.deepEqual(agent.queue.map(r => [r.type, r.about]), [['user', '세탁 끝']])
		assert.equal(agent.journal.feedbackRows().at(-1).kind, 'reply')

		// JSONL 쓰기가 실패해도(경로가 폴더) 던지지 않고 SQLite에는 남는다
		mkdirSync(P.notifications, { recursive: true })
		assert.doesNotThrow(() => agent.journal.notification({ nid: 'n10', ts: new Date(T0).toISOString(), kind: 'info', level: 'normal', title: 't', message: 'm', related_rule_ids: [], tag: 'haagent-n10', status: 'sent' }))
		assert.equal(agent.store.getNotification('n10').title, 't')

		// 대기 중인 승인은 다시 시작할 때 SQLite에서 읽는다(이름 포함)
		agent.journal.action({ aid: 'a1', ts: new Date(T0).toISOString(), entity_id: 'light.a', name: '거실 등', action: 'turn_on', domain: 'light', service: 'turn_on', reason: 'r', tier: 'confirm', prev: 'off', status: 'pending', expires: T0 + 30 * MIN })
		rmSync(P.actions, { force: true })
		agent.stop()
		const again = new Agent({ cfg: agent.cfg, ha: new MockHA([st('light.a', 'off')]), clock: () => T0, canUse: () => false })
		try {
			assert.deepEqual(again.pendingActs.map(a => [a.aid, a.name, a.prev, a.status]), [['a1', '거실 등', 'off', 'pending']])
		} finally { again.stop() }
	} finally { agent.stop() }
})

test('7. 판단 중 도구로 하는 제어도 per_cycle 한도를 함께 쓰고 판단 기록에 남는다', async () => {
	cleanState()
	const lights = ['light.a', 'light.b', 'light.c', 'light.d']
	const { agent, ha } = makeAgent({
		states: lights.map(id => st(id, 'off')),
		cfg: { brain: 'api', actions: { per_cycle: 3 }, policy: { tier1_auto: lights } },
	})
	try {
		agent.llmRouter.run = async args => {
			assert.ok(args.toolBroker && args.toolContext, 'api 판단에는 도구가 열려 있다')
			for (const id of lights) {
				await args.toolBroker.run('ha_control_device', JSON.stringify({ entity_id: id, service: 'turn_on', service_data_json: null, reason: '시험', requested: false, speech_if_success: null }), args.toolContext)
			}
			return { result: answer({ actions: [{ entity_id: 'light.d', action: 'turn_on', reason: 'JSON으로 한 번 더', requested: false }] }), ms: 1, tokens: 1 }
		}
		const entry = await agent.cycle([{ type: 'manual', reason: '시험' }])
		assert.equal(entry.error, undefined)
		assert.deepEqual(ha.calls.map(c => c[2]), ['light.a', 'light.b', 'light.c'], '네 번째 도구 호출과 JSON 행동은 한도로 막힘')
		assert.deepEqual(entry.applied.actions, ['done: light.a turn_on (도구)', 'done: light.b turn_on (도구)', 'done: light.c turn_on (도구)'])
		assert.ok(entry.applied.rejected.some(r => r.via === 'tool' && /3개까지/.test(r.error)))
		assert.ok(entry.applied.rejected.some(r => r.action === 'light.d turn_on' && !r.via && /3개까지/.test(r.error)))
	} finally { agent.stop() }
})

test('8. 승인 제안: 이전 설정은 HA에서 새로 읽고, 승인 전에 HA에서 바뀌었으면 덮어쓰지 않는다', async () => {
	const dir = mkdtempSync(join(TMP, 'stale-'))
	const store = new Store(join(dir, 's.db'))
	try {
		const saved = new Map([['automation:a1', { id: 'a1', alias: '실제', triggers: [{ trigger: 'state', entity_id: 'light.a' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] }]])
		let writes = 0
		const ha = {
			connected: false,
			guard: { allowConfigWrite: false },
			async getConfigRest(dom, id) { const v = saved.get(`${dom}:${id}`); if (!v) throw new Error('HA REST 404: Resource not found'); return structuredClone(v) },
			async saveConfigRest(dom, id, cfg) { writes++; saved.set(`${dom}:${id}`, cfg) },
			async deleteConfigRest(dom, id) { writes++; saved.delete(`${dom}:${id}`) },
			async callService() {},
			async checkConfig() { return { result: 'valid' } },
		}
		const states = new Map([['light.a', st('light.a', 'on')], ['automation.a1', st('automation.a1', 'on', { id: 'a1' })]])
		// 캐시(meta.autoCfg)는 6시간 묵은 옛 값
		const meta = { autoCfg: { 'automation.a1': { id: 'a1', alias: '캐시의 옛 값', triggers: [], actions: [] } } }
		const adm = new HaAdmin({ cfg: mergeConfig({ policy: { admin_enabled: true } }), ha, store, states, meta })
		const make = alias => adm.createProposal({
			kind: 'automation_upsert', target_id: 'automation.a1', title: alias, summary: 's',
			payload: { config: { alias, triggers: [{ trigger: 'state', entity_id: 'light.a' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.a' } }] } },
		}, T0)

		const p1 = await make('제안 1')
		assert.equal(p1.proposal.pre_snapshot.alias, '실제', '캐시가 아니라 HA의 지금 값')
		assert.match(p1.proposal.diff_text, /- {3}"alias": "실제"/)

		// 제안 뒤 사용자가 UI에서 같은 자동화를 고침 → 승인해도 덮어쓰지 않음
		saved.get('automation:a1').alias = 'UI에서 고침'
		const r1 = await adm.approveProposal(p1.proposal.pid, T0 + MIN)
		assert.equal(r1.ok, false)
		assert.equal(r1.proposal.status, 'error')
		assert.match(r1.error, /HA에서 이 설정이 바뀌어/)
		assert.equal(saved.get('automation:a1').alias, 'UI에서 고침')
		assert.equal(writes, 0)

		// 바뀐 것이 없으면 그대로 적용
		const p2 = await make('제안 2')
		const r2 = await adm.approveProposal(p2.proposal.pid, T0 + 2 * MIN)
		assert.equal(r2.ok, true, r2.error)
		assert.equal(saved.get('automation:a1').alias, '제안 2')

		// 새 자동화(아직 없음): 그사이 같은 id가 생겼으면 막음
		const p3 = await adm.createProposal({ kind: 'automation_upsert', target_id: '', title: '새것', summary: 's', payload: { config_id: 'new_1', config: { alias: '새것', triggers: [{ trigger: 'state', entity_id: 'light.a' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.a' } }] } } }, T0)
		assert.equal(p3.proposal.pre_snapshot, null)
		saved.set('automation:new_1', { id: 'new_1', alias: '누가 먼저 만듦' })
		assert.equal((await adm.approveProposal(p3.proposal.pid, T0 + 3 * MIN)).ok, false)
	} finally { store.close() }
})

test('9. 이상탐지: 5분마다 지금 값을 표본으로 쌓고, 지난 기록에서 본 범위 안의 값은 이상으로 보지 않는다', () => {
	const dir = mkdtempSync(join(TMP, 'samp-'))
	const store = new Store(join(dir, 'a.db'))
	try {
		const ae = new AnomalyEngine({ store })
		const states = new Map([
			['sensor.living_temp', st('sensor.living_temp', '21.5', { unit_of_measurement: '°C', state_class: 'measurement' })],
			['sensor.energy_total', st('sensor.energy_total', '100', { unit_of_measurement: 'kWh', state_class: 'total_increasing' })],
			['sensor.text', st('sensor.text', 'abc')],
		])
		// 값이 그대로여도 5분마다 남는다(바뀔 때만 남기면 오래 그대로인 구간이 빠진다)
		assert.equal(ae.sampleAll(states, T0), 1)
		assert.equal(ae.sampleAll(states, T0 + MIN), 0)
		assert.equal(ae.sampleAll(states, T0 + 5 * MIN), 1)
		assert.deepEqual(store.getRecentSensorSamples(0).map(r => [r.entity_id, r.value]), [['sensor.living_temp', 21.5], ['sensor.living_temp', 21.5]])

		// 평소 100W, 드물게 1000W까지 쓴 적이 있는 센서: 1000W는 평소 범위, 1500W는 이상
		const base = Date.parse('2026-11-13T10:00:00+09:00')
		for (let i = 0; i < 95; i++) store.recordSensorSample('sensor.plug_power', 100, base + i * 30000)
		store.recordSensorSample('sensor.plug_power', 1000, base + 96 * 30000)
		ae.recomputeBaselines(base + 2 * 3600000)
		const at = Date.parse('2026-11-20T10:10:00+09:00')
		const check = v => {
			const s = new Map([['sensor.plug_power', st('sensor.plug_power', String(v), { unit_of_measurement: 'W' })]])
			ae.pendingSince.clear(); ae.lastAlertAt.clear()
			ae.checkAnomalies(s, at)
			return ae.checkAnomalies(s, at + 16 * MIN).length
		}
		assert.equal(check(1000), 0, '본 적 있는 값')
		assert.equal(check(1500), 1, '본 적 없는 값')
	} finally { store.close() }
})

test('10. 마지막 판단(lastRun): SQLite 단일 원본, Assist·skipped·deferred 분리 및 즉시 heartbeat 반영', async () => {
	cleanState()
	// 1) Store.latestDecision 필터 및 정렬(ts DESC, id DESC)
	const dir = mkdtempSync(join(TMP, 'dec-'))
	const store = new Store(join(dir, 'd.db'))
	try {
		store.recordDecision({ ts: new Date(T0).toISOString(), reasons: ['hourly'], brain: 'codex', total_ms: 1000, summary: '정각 1' })
		store.recordDecision({ ts: new Date(T0).toISOString(), reasons: ['manual'], brain: 'codex', total_ms: 1200, summary: '동시각 나중 ID' })
		store.recordDecision({ ts: new Date(T0 + 1000).toISOString(), reasons: ['hourly'], brain: 'codex', total_ms: 50, summary: '건너뜀', skipped: true })
		store.recordDecision({ ts: new Date(T0 + 2000).toISOString(), reasons: ['rule:door'], brain: 'codex', total_ms: 50, summary: '미룸', deferred: true })
		store.recordDecision({ ts: new Date(T0 + 3000).toISOString(), reasons: ['assist'], brain: 'api', total_ms: 300, summary: '어시스트 1' })

		assert.equal(store.latestDecision().summary, '어시스트 1')
		assert.equal(store.latestDecision({ onlyAssist: true }).summary, '어시스트 1')
		assert.equal(store.latestDecision({ excludeAssist: true }).summary, '미룸')
		assert.equal(store.latestDecision({ excludeAssist: true, excludeDeferred: true }).summary, '건너뜀')
		assert.equal(store.latestDecision({ excludeAssist: true, excludeSkipped: true, excludeDeferred: true }).summary, '동시각 나중 ID')
		assert.equal(store.latestDecision({ excludeAssist: true, onlyAssist: true }), null)
	} finally { store.close() }

	// 2~7) Agent cycle, skipped/deferred, Assist fast/llm, 재시작 복구, cli status, 실패 cycle
	cleanState()
	let now = T0
	let failBrain = false
	const ha = new MockHA([st('light.a', 'off', { friendly_name: '거실 불' }, T0 - 60 * MIN)])
	ha.beats = []
	ha.heartbeat = async d => { ha.beats.push(d) }
	const origCallSvc = ha.callService.bind(ha)
	let failWeather = false
	ha.callService = async (domain, service, opts) => {
		if (domain === 'weather' && failWeather) { ha.connected = false; throw new Error('응답 없음') }
		return origCallSvc(domain, service, opts)
	}
	const cfg = mergeConfig({
		heartbeat: { enabled: true, interval_seconds: 60 },
		hourly_skip_unchanged: true,
		active_hours: { start: 7, end: 23 },
		llm: { routes: { assist: 'api' } },
		assist: { fast_path: true, model: 'gpt-6-luna', effort: 'low' },
		actions: { enabled: true, verify_seconds: 1 },
		policy: { tier1_auto: ['light.a'] },
	})
	const brain = async a => {
		if (a.customSchema) return { result: { speech: 'LLM 어시스트 응답이에요.', continue_conversation: false }, ms: 5, tokens: 12 }
		if (failBrain) throw new Error('모델 응답 오류')
		return { result: answer({ summary: '정각 점검 정상 요약' }), ms: 5, tokens: 10 }
	}
	let agent = new Agent({ cfg, ha, clock: () => now, canUse: () => true, brain })
	agent.attach()
	ha.emit('ready', [...ha.map.values()])
	try {
		// 2) 실제 cycle() -> lastRun 갱신 및 즉시 heartbeat 전송
		const e1 = await agent.cycle([{ type: 'hourly', hour: 12 }])
		await flush()
		assert.equal(e1.summary, '정각 점검 정상 요약')
		assert.equal(agent.lastRun.summary, '정각 점검 정상 요약')
		assert.equal(ha.beats.length, 1)
		assert.equal(ha.beats[0].last_summary, '정각 점검 정상 요약')
		assert.equal(ha.beats[0].last_run, '2026-11-20 12:00')
		assert.equal(ha.beats[0].last_ok, true)

		// 3) skipped 및 deferred cycle -> 기록은 되지만 lastRun/heartbeat 덮어쓰지 않음
		now += 60 * MIN
		const eSkip = await agent.cycle([{ type: 'hourly', hour: 13 }])
		await flush()
		assert.equal(eSkip.skipped, true)
		assert.equal(agent.lastRun.summary, '정각 점검 정상 요약')
		assert.equal(ha.beats.length, 1)

		now += 2 * MIN
		failWeather = true
		const eDef = await agent.cycle([{ type: 'manual', reason: '연결 끊김 시험' }])
		await flush()
		failWeather = false
		ha.connected = true
		assert.equal(eDef.deferred, true)
		assert.equal(agent.lastRun.summary, '정각 점검 정상 요약')
		assert.equal(ha.beats.length, 1)
		const stored = agent.store.decisionsInRange(0)
		assert.ok(stored.some(d => d.skipped), 'skipped도 DB에는 기록됨')
		assert.ok(stored.some(d => d.deferred), 'deferred도 DB에는 기록됨')

		// 4) Assist 빠른 경로·LLM 경로 -> lastAssist만 갱신, lastRun/heartbeat last_summary 유지
		now += 2 * MIN
		const fastRes = await agent.handleAssist({ text: '거실 불 켜줘', conversationId: 'c1' })
		assert.equal(fastRes.meta.path, 'fast')
		assert.equal(agent.lastAssist.summary, '거실 불을 켰어요.')
		assert.equal(agent.lastRun.summary, '정각 점검 정상 요약')

		now += 2 * MIN
		const llmRes = await agent.handleAssist({ text: '지금 집 상태 알려줘', conversationId: 'c1' })
		assert.equal(llmRes.meta.path, 'llm')
		assert.equal(agent.lastAssist.summary, 'LLM 어시스트 응답이에요.')
		assert.equal(agent.lastRun.summary, '정각 점검 정상 요약')

		agent.notifier.heartbeat(now, { force: true })
		await flush()
		assert.equal(ha.beats.at(-1).last_summary, '정각 점검 정상 요약')
		assert.equal(ha.beats.at(-1).last_run, '2026-11-20 12:00')
		assert.equal(ha.beats.at(-1).last_assist_summary, 'LLM 어시스트 응답이에요.')
		assert.equal(ha.beats.at(-1).last_assist_run, '2026-11-20 13:06')

		// 5) JSONL 삭제 후 재시작해도 SQLite에서 lastRun과 lastAssist 복원
		agent.stop()
		rmSync(P.decisions, { force: true })
		agent = new Agent({ cfg, ha: new MockHA([st('light.a', 'on', { friendly_name: '거실 불' })]), clock: () => now, canUse: () => true })
		assert.equal(agent.lastRun.summary, '정각 점검 정상 요약')
		assert.equal(agent.lastAssist.summary, 'LLM 어시스트 응답이에요.')
		assert.equal(agent.statusSummary().last_run.summary, '정각 점검 정상 요약')
		assert.equal(agent.statusSummary().last_assist.summary, 'LLM 어시스트 응답이에요.')
		agent.stop()
		agent = null

		// 7) cli.mjs status도 SQLite 원본에서 마지막 판단과 마지막 Assist를 분리 표시
		const cli = spawnSync(process.execPath, ['src/cli.mjs', 'status'], {
			cwd: ROOT, env: { ...process.env, HAAGENT_DATA_DIR: TMP }, encoding: 'utf8',
		})
		assert.equal(cli.status, 0, cli.stderr)
		assert.match(cli.stdout, /마지막 판단 .*정각 점검 정상 요약/)
		assert.match(cli.stdout, /마지막 Assist .*LLM 어시스트 응답이에요\./)

		// 6) 실패한 cycle() -> lastRun 갱신 및 heartbeat last_ok=false, '실패: ...' 전송
		const ha2 = new MockHA([st('light.a', 'on', { friendly_name: '거실 불' })])
		ha2.beats = []
		ha2.heartbeat = async d => { ha2.beats.push(d) }
		failBrain = true
		now += 5 * MIN
		agent = new Agent({ cfg, ha: ha2, clock: () => now, canUse: () => true, brain })
		agent.attach()
		ha2.emit('ready', [...ha2.map.values()])
		const eFail = await agent.cycle([{ type: 'manual', reason: '실패 시험' }])
		await flush()
		assert.match(eFail.error, /모델 응답 오류/)
		assert.match(agent.lastRun.error, /모델 응답 오류/)
		assert.equal(ha2.beats.at(-1).last_ok, false)
		assert.match(ha2.beats.at(-1).last_summary, /^실패: 모델 응답 오류/)
	} finally {
		agent?.stop()
	}
})
