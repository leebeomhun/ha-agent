// 2026-11-25 운영 검토 회귀 테스트: 기기 제어 성공 판정·되돌리기, 일시정지·시험 모드 실행 차단, 항목 단위 롤백·충돌,
// 규칙 승격 롤백, 생활 루틴 근거, 스크립트 최종 대상, Assist 요청당 한도·최종 결과, 음성 설정 실시간 반영.
// 실제 state/·config.json은 건드리지 않는다(HAAGENT_DATA_DIR와 임시 configPath를 쓴다).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'haagent-findings-'))
process.env.HAAGENT_DATA_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

const { mergeConfig, saveControl } = await import('../src/config.mjs')
const { P, DAY, writeJson, readJson } = await import('../src/util.mjs')
const { PolicyEngine, controlReached } = await import('../src/core/policy.mjs')
const { analyzeScriptScope } = await import('../src/core/script-scope.mjs')
const { Store } = await import('../src/core/store.mjs')
const { HaAdmin } = await import('../src/admin/ha-admin.mjs')
const { AssistServer } = await import('../src/channels/assist-server.mjs')
const { suggestAutomations } = await import('../src/engine/automation-suggest.mjs')
const { Agent } = await import('../src/agent.mjs')

const MIN = 60000
const T0 = Date.parse('2026-11-25T13:00:00+09:00')
const iso = ms => new Date(ms).toISOString()
const st = (entity_id, state, attrs = {}, at = T0 - 60 * MIN) => ({
	entity_id, state, attributes: { friendly_name: entity_id, ...attrs },
	last_changed: iso(at), last_updated: iso(at), context: { id: `c_${entity_id}`, parent_id: null, user_id: null },
})
const flush = () => new Promise(r => setImmediate(r))
const answer = over => ({ summary: '요약', notifications: [], rule_changes: { upsert: [], delete: [] }, next_wakes: [], memory: { mode: 'keep', text: '' }, info_requests: [], actions: [], ...over })

// 가짜 HA. ignore에 'entity|service'를 넣으면 명령을 받고도 상태를 바꾸지 않는다(값이 그대로인 기기 흉내).
class FakeHA extends EventEmitter {
	constructor(list) {
		super()
		this.connected = true
		this.map = new Map(list.map(s => [s.entity_id, s]))
		this.calls = []
		this.sent = []
		this.ignore = new Set()
		this.saved = new Map() // 'automation:id' → 설정
		this.checkResult = { result: 'valid' }
		this.scriptCfg = {}
		this.autoCfgs = {}
		this.writes = 0
		this.guard = {}
		this.helpers = { input_boolean: [] }
		this.registry = [] // [{ entity_id, platform }]
		this.scriptFail = false
	}
	start() {}
	stop() {}
	set(id, state, attrs = null) {
		const old = this.map.get(id)
		const n = { ...st(id, state, attrs ?? old?.attributes ?? {}, Date.now()), attributes: { ...(old?.attributes ?? {}), ...(attrs ?? {}) } }
		this.map.set(id, n)
		this.emit('state', { entity_id: id, old_state: old, new_state: n })
	}
	async call(msg) {
		if (msg.type === 'get_states') return [...this.map.values()]
		if (msg.type === 'script/config') { if (this.scriptFail) throw new Error('응답 없음'); return { config: this.scriptCfg[msg.entity_id] } }
		if (msg.type === 'config/entity_registry/list') return structuredClone(this.registry)
		const hm = /^(input_boolean)\/(list|create|update|delete)$/.exec(msg.type)
		if (hm) {
			const list = this.helpers[hm[1]], key = `${hm[1]}_id`
			if (hm[2] === 'list') return structuredClone(list)
			this.writes++
			if (hm[2] === 'create') { const { type, id: _i, ...cfg } = msg; const item = { id: cfg.name.toLowerCase().replace(/\W+/g, '_'), ...cfg }; list.push(item); return item }
			const i = list.findIndex(h => h.id === msg[key])
			if (i < 0) throw new Error('not found')
			if (hm[2] === 'update') { const { type, id: _i, [key]: _k, ...cfg } = msg; list[i] = { id: list[i].id, ...cfg }; return list[i] }
			list.splice(i, 1)
			return null
		}
		if (msg.type === 'automation/config') return { config: this.autoCfgs[msg.entity_id] }
		if (msg.type === 'repairs/list_issues') return { issues: [] }
		if (/registry\/list$|system_log|\/list$/.test(msg.type)) return []
		return null
	}
	async callService(domain, service, { data = {}, target } = {}) {
		if (domain === 'notify') { this.sent.push(data); return }
		if (domain === 'weather' || domain === 'calendar') return { response: {} }
		const id = target?.entity_id
		this.calls.push([domain, service, id, data])
		if (service === 'reload' || !id || this.ignore.has(`${id}|${service}`)) return
		if (service === 'turn_on') this.set(id, 'on', { ...(data.brightness != null ? { brightness: data.brightness } : {}), ...(data.brightness_pct != null ? { brightness: Math.round(data.brightness_pct * 255 / 100) } : {}) })
		else if (service === 'turn_off') this.set(id, 'off')
		else if (service === 'select_option') this.set(id, String(data.option))
		else if (service === 'set_value') this.set(id, String(data.value))
	}
	async getConfigRest(d, id) { const v = this.saved.get(`${d}:${id}`); if (!v) throw new Error('HA REST 404: Resource not found'); return structuredClone(v) }
	async saveConfigRest(d, id, c) { this.writes++; this.saved.set(`${d}:${id}`, structuredClone({ ...c, id })) }
	async deleteConfigRest(d, id) { this.writes++; this.saved.delete(`${d}:${id}`) }
	async checkConfig() { return this.checkResult }
	async renderTemplate() { return 'ok' }
	async heartbeat() {}
	async history() { return {} }
	async statistics() { return {} }
	async logbook() { return [] }
}

function cleanState({ paused = false, send = true } = {}) {
	rmSync(TMP, { recursive: true, force: true })
	mkdirSync(P.state, { recursive: true })
	saveControl({ paused, send })
	writeJson(P.rules, { updated: iso(T0), rules: [] })
}

function makeAgent({ states, cfg = {}, brain, rules } = {}) {
	if (rules) writeJson(P.rules, { updated: iso(T0), rules })
	const ha = new FakeHA(states)
	const full = mergeConfig({ heartbeat: { enabled: false }, ...cfg, actions: { enabled: true, verify_seconds: 1, ...cfg.actions }, policy: { admin_enabled: true, ...cfg.policy } })
	const t = { now: T0 }
	const agent = new Agent({ cfg: full, ha, clock: () => t.now, canUse: () => false, oob: async () => true, ...(brain ? { brain } : {}) })
	// 자가 설정 제안이 진짜 config.json을 쓰지 않게 임시 파일로 돌린다.
	const cfgPath = join(TMP, 'config.json')
	// 승인 뒤에는 이 파일을 다시 읽어 설정을 바꾸므로 관리 권한도 같이 둔다(실제로는 config.json 그대로).
	writeFileSync(cfgPath, JSON.stringify({ policy: { admin_enabled: true }, ...(cfg.raw ?? { noise_entities: [] }) }))
	agent.haAdmin.configPath = cfgPath
	agent.attach()
	ha.emit('ready', [...ha.map.values()])
	return { agent, ha, t, cfgPath }
}

const control = (agent, req) => agent.actionExecutor.executeControlItem({ reason: '시험', requested: true, ...req }, { byUser: true })

// ── 1. 성공 판정·되돌리기 ──
test('1-1 선택값·숫자값이 그대로면 done이 아니라 unverified', async () => {
	cleanState()
	const { agent, ha } = makeAgent({
		states: [st('select.purifier_mode', 'auto', { options: ['auto', 'sleep', 'turbo'] }), st('number.purifier_speed', '2', { min: 1, max: 5, step: 1 })],
		cfg: { policy: { tier1_auto: ['select.purifier_mode', 'number.purifier_speed'] } },
	})
	ha.ignore.add('select.purifier_mode|select_option')
	ha.ignore.add('number.purifier_speed|set_value')
	const a = await control(agent, { entity_id: 'select.purifier_mode', action: 'select_option', service_data: { option: 'turbo' } })
	const b = await control(agent, { entity_id: 'number.purifier_speed', action: 'set_value', service_data: { value: 4 } })
	assert.equal(a.status, 'unverified')
	assert.equal(b.status, 'unverified')
	// 값이 실제로 바뀌면 done
	ha.ignore.clear()
	assert.equal((await control(agent, { entity_id: 'select.purifier_mode', action: 'select_option', service_data: { option: 'sleep' } })).status, 'done')
	assert.equal((await control(agent, { entity_id: 'number.purifier_speed', action: 'set_value', service_data: { value: 3 } })).status, 'done')
})

test('1-2 이미 켜진 조명의 밝기 변경: 밝기가 안 바뀌면 unverified, 되돌리기는 끄기가 아니라 이전 밝기로 켜기', async () => {
	cleanState()
	const { agent, ha } = makeAgent({
		states: [st('light.living', 'on', { brightness: 255, color_mode: 'brightness' })],
		cfg: { policy: { tier1_auto: ['light.living'] } },
	})
	ha.ignore.add('light.living|turn_on')
	const r1 = await control(agent, { entity_id: 'light.living', action: 'turn_on', service_data: { brightness_pct: 40 } })
	assert.equal(r1.status, 'unverified', '켜짐 상태만으로 성공 처리하지 않음')
	ha.ignore.clear()
	const r2 = await control(agent, { entity_id: 'light.living', action: 'turn_on', service_data: { brightness_pct: 40 } })
	assert.equal(r2.status, 'done')
	const undo = agent.policy.buildUndoCall(r2.rec)
	assert.deepEqual(undo, { domain: 'light', service: 'turn_on', data: { brightness: 255 } })
	// [되돌리기] 버튼: 조명을 끄지 않고 이전 밝기로 돌린다
	ha.emit('action', { action: `HAAGENT_UNDO_${r2.rec.aid}` })
	for (let i = 0; i < 5; i++) await flush()
	await new Promise(r => setTimeout(r, 50))
	assert.deepEqual(ha.calls.at(-1), ['light', 'turn_on', 'light.living', { brightness: 255 }])
	assert.equal(ha.map.get('light.living').state, 'on')
	assert.equal(ha.map.get('light.living').attributes.brightness, 255)
	// 꺼져 있던 조명을 켰으면 되돌리기는 끄기
	assert.deepEqual(agent.policy.buildUndoCall({ entity_id: 'light.living', service: 'turn_on', prev_snapshot: { state: 'off', attrs: {} } }), { domain: 'light', service: 'turn_off', data: {} })
})

test('1-3 서비스별 확인 규칙(팬 단계·기후 켜기·커버·확인 불가 서비스)', () => {
	assert.equal(controlReached('fan', 'set_percentage', { percentage: 50 }, st('fan.a', 'on', { percentage: 66, percentage_step: 33.33 })), true, '한 단계 안')
	assert.equal(controlReached('fan', 'set_percentage', { percentage: 100 }, st('fan.a', 'on', { percentage: 33, percentage_step: 33.33 })), false)
	assert.equal(controlReached('fan', 'set_percentage', { percentage: 0 }, st('fan.a', 'off', {})), true)
	assert.equal(controlReached('climate', 'turn_on', {}, st('climate.a', 'heat')), true, '기후는 켜지면 on이 아니라 운전 모드')
	assert.equal(controlReached('climate', 'set_temperature', { temperature: 22 }, st('climate.a', 'heat', { temperature: 20 })), false)
	assert.equal(controlReached('cover', 'open_cover', {}, st('cover.a', 'opening')), true)
	assert.equal(controlReached('cover', 'stop_cover', {}, st('cover.a', 'open')), null, '상태로 확인할 수 없는 서비스')
	assert.equal(controlReached('light', 'turn_on', { brightness: 100 }, st('light.a', 'on', {})), false, '밝기를 보고하지 않으면 확인 못 함')
	assert.equal(controlReached('light', 'turn_on', { color_temp_kelvin: 6500 }, st('light.a', 'on', { color_temp_kelvin: 5000, max_color_temp_kelvin: 5000 })), true, '기기 한계로 맞춰진 값')
	assert.equal(controlReached('select', 'select_option', { option: 'a' }, st('select.x', 'unavailable')), false)
})

// ── 2. 일시정지·시험 모드 ──
const humid = { id: 'bath_humid_high', description: '화장실 습도 80% 이상 20분', entity_id: 'sensor.bath_humidity', attribute: null, op: 'gt', value: 80, for_minutes: 20, cooldown_minutes: 60, priority: 'normal', also: [], hour_from: null, hour_to: null }

test('2-1 진행 중이던 판단: 판단 도중 일시정지되면 결과(기기·규칙·알림)를 하나도 적용하지 않고, 사용자 지시는 다시 넣지 않는다', async () => {
	cleanState()
	const { agent, ha } = makeAgent({
		states: [st('switch.fan', 'off'), st('sensor.bath_humidity', '60')],
		rules: [humid],
		cfg: { policy: { tier1_auto: ['switch.fan'] } },
		brain: async () => {
			saveControl({ paused: true, send: true }) // 판단(LLM)을 기다리는 사이 사용자가 pause
			return { result: answer({
				actions: [{ entity_id: 'switch.fan', action: 'turn_on', reason: '습도' }],
				rule_changes: { upsert: [], delete: ['bath_humid_high'] },
				notifications: [{ kind: 'info', level: 'normal', title: '알림', message: '본문', related_rule_ids: [] }],
			}), ms: 1, tokens: 1 }
		},
	})
	const entry = await agent.cycle([{ type: 'manual', reason: '점검' }, { type: 'user', text: '선풍기 켜줘', at: T0 }])
	assert.equal(entry.paused, true)
	assert.equal(entry.deferred, true)
	assert.equal(ha.calls.filter(c => c[0] === 'switch').length, 0)
	assert.equal(agent.engine.rules.length, 1, '규칙 삭제를 적용하지 않음')
	assert.equal(readJson(P.rules, {}).rules.length, 1, 'rules.json도 그대로')
	assert.equal(ha.sent.length, 0, '알림도 보내지 않음')
	assert.deepEqual(agent.queue.map(r => r.type), ['manual'], '감시·점검 이유만 재개 뒤 다시 판단, 옛 사용자 명령은 버림')
})

test('2-5 시험 모드·일시정지에서는 판단이 끝난 뒤 주간 보고서를 HA 알림에 올리지 않는다', async () => {
	cleanState({ send: false })
	const report = '# 주간 분석 2026-11-25\n\n## 한눈에\n- 시험'
	const { agent, ha } = makeAgent({ states: [st('light.a', 'off')], cfg: { weekly: { publish: true } }, brain: async () => ({ result: answer({ report }), ms: 1, tokens: 1 }) })
	const entry = await agent.cycle([{ type: 'weekly' }])
	assert.ifError(entry.error)
	assert.equal(entry.applied.published, false)
	assert.equal(ha.calls.filter(c => c[0] === 'persistent_notification').length, 0)
	saveControl({ paused: false, send: true })
	const entry2 = await agent.cycle([{ type: 'weekly' }])
	assert.equal(entry2.applied.published, true, '발송이 켜져 있으면 올림')
	assert.equal(ha.calls.filter(c => c[0] === 'persistent_notification').length, 1)
})

test('2-2 send-off 뒤 예전 승인 버튼: 실행하지 않고 승인 대기로 남김', async () => {
	cleanState()
	const { agent, ha } = makeAgent({ states: [st('switch.tv', 'on')], cfg: { policy: { tier2_confirm: ['switch.tv'] } } })
	const r = await agent.actionExecutor.executeControlItem({ entity_id: 'switch.tv', action: 'turn_off', reason: '아무도 없음' })
	assert.equal(r.status, 'pending')
	saveControl({ paused: false, send: false })
	ha.emit('action', { action: `HAAGENT_DO_${r.rec.aid}` })
	for (let i = 0; i < 5; i++) await flush()
	assert.equal(ha.calls.filter(c => c[0] === 'switch').length, 0)
	assert.ok(agent.pendingActs.some(p => p.aid === r.rec.aid))
	// 실행 직전 관문: 다른 길로 execute까지 와도 부르지 않는다
	const rec = await agent.actionExecutor.execute({ ...r.rec })
	assert.equal(rec.status, 'test_mode')
	assert.equal(ha.calls.filter(c => c[0] === 'switch').length, 0)
})

test('2-3 관리 제안: 일시정지·시험 모드에서 승인과 버튼 롤백은 막고, CLI·콘솔의 직접 롤백만 허용', async () => {
	cleanState()
	const { agent, ha } = makeAgent({ states: [st('light.a', 'off')] })
	const cfg = { alias: '시험 자동화', triggers: [{ trigger: 'time', at: '07:00:00' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.a' } }] }
	const mk = async () => (await agent.haAdmin.createProposal({ kind: 'automation_upsert', target_id: 'automation.t1', title: '시험', summary: 's', payload: { config_id: 't1', config: cfg } }, T0)).proposal
	const p1 = await mk()
	saveControl({ paused: true, send: true })
	const a1 = await agent.handleProposalAction(p1.pid, 'approve')
	assert.equal(a1.ok, false)
	assert.equal(a1.blocked, 'paused')
	assert.equal(agent.haAdmin.getProposal(p1.pid).status, 'pending', '승인 대기로 남김')
	assert.equal(ha.writes, 0)
	saveControl({ paused: false, send: false })
	assert.equal((await agent.handleProposalAction(p1.pid, 'approve')).blocked, 'test_mode')
	assert.equal(ha.writes, 0)
	saveControl({ paused: false, send: true })
	assert.equal((await agent.handleProposalAction(p1.pid, 'approve')).ok, true)
	assert.equal(ha.writes, 1)
	saveControl({ paused: true, send: true })
	const rb1 = await agent.handleProposalAction(p1.pid, 'rollback') // 알림 버튼·Assist 도구
	assert.equal(rb1.blocked, 'paused')
	assert.equal(agent.haAdmin.getProposal(p1.pid).status, 'applied')
	const rb2 = await agent.handleProposalAction(p1.pid, 'rollback', { explicit: true }) // CLI·콘솔
	assert.equal(rb2.ok, true)
	assert.equal(ha.saved.has('automation:t1'), false)
})

test('2-4 하루 자가개선 작업은 일시정지 중 돌지 않는다, 일시정지 중에도 긴급 알림은 보낸다', async () => {
	cleanState({ paused: true })
	const { agent, ha } = makeAgent({ states: [st('switch.fan', 'off')] })
	const r = await agent.runDailyLearning(T0)
	assert.deepEqual(r, { skipped: 'paused' })
	const normal = await agent.notifier.deliver({ kind: 'info', level: 'normal', title: 'a', message: 'b', related_rule_ids: [] })
	assert.match(normal, /^paused:/)
	const urgent = await agent.notifier.deliver({ kind: 'alert', level: 'urgent', title: '누수', message: '물', related_rule_ids: [] })
	assert.match(urgent, /^sent:/)
	assert.equal(ha.sent.length, 1)
	await assert.rejects(() => agent.notifier.send({ title: 'x', message: 'y' }), /일시정지/)
	// 사용자 조작에 대한 확인 문구는 보낸다
	await agent.notifier.send({ title: 'x', message: 'y' }, { reply: true })
	assert.equal(ha.sent.length, 2)
})

// ── 3. 항목 단위 롤백·충돌 ──
test('3-1 소음 제외 A·B를 차례로 승인하고 A만 롤백하면 B와 그 사이 수동 변경은 그대로', async () => {
	cleanState()
	const { agent, cfgPath } = makeAgent({ states: [st('sensor.a', '1'), st('sensor.b', '2')], cfg: { raw: { noise_entities: ['sensor.base', 'sensor.manual_*'] } } })
	const adm = agent.haAdmin
	const A = (await adm.createProposal({ kind: 'self_noise_proposal', target_id: 'sensor.a', title: 'A', summary: 's', payload: { entity_id: 'sensor.a' } }, T0)).proposal
	assert.equal((await adm.approveProposal(A.pid, T0)).ok, true)
	// 그 사이 사람이 config.json에서 한 항목을 지움
	const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
	raw.noise_entities = raw.noise_entities.filter(x => x !== 'sensor.manual_*')
	writeFileSync(cfgPath, JSON.stringify(raw))
	const B = (await adm.createProposal({ kind: 'self_noise_proposal', target_id: 'sensor.b', title: 'B', summary: 's', payload: { entity_id: 'sensor.b' } }, T0)).proposal
	const apB = await adm.approveProposal(B.pid, T0); assert.equal(apB.ok, true, apB.error)
	assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).noise_entities, ['sensor.base', 'sensor.a', 'sensor.b'])
	const rb = await adm.rollbackProposal(A.pid, T0)
	assert.equal(rb.ok, true)
	assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).noise_entities, ['sensor.base', 'sensor.b'], 'A만 빠지고 B·수동 변경은 그대로')
	assert.equal(agent.isNoise('sensor.b'), true)
	assert.equal(agent.isNoise('sensor.a'), false)
})

test('3-2 예전 판이 승인한 소음 제안(적용 직후 값 없음)도 그 항목만 되돌린다 — 운영 DB와 같은 모양', async () => {
	cleanState()
	const { agent, cfgPath } = makeAgent({ states: [], cfg: { raw: { noise_entities: ['sensor.base', 'media_player.stb', 'sensor.air'] } } })
	const store = agent.store
	// 운영 DB의 승인 건처럼: payload에는 entity_id만, pre_snapshot은 제안 때 목록, post_snapshot 없음
	store.upsertProposal({ pid: 'legacyA', ts: T0 - 2 * DAY, kind: 'self_noise_proposal', title: 'A', summary: 's', target_id: 'media_player.stb', payload: { entity_id: 'media_player.stb' }, pre_snapshot: { noise_entities: ['sensor.base', 'sensor.gone_*'] }, status: 'applied', applied_at: T0 - 2 * DAY })
	const rb = await agent.haAdmin.rollbackProposal('legacyA', T0)
	assert.equal(rb.ok, true)
	assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).noise_entities, ['sensor.base', 'sensor.air'], '다른 항목을 지우지도, 지운 항목을 되살리지도 않음')
})

test('3-3 HA 자동화: 승인 뒤 HA에서 다시 고쳤으면 수동 롤백은 충돌로 표시하고 덮어쓰지 않는다', async () => {
	cleanState()
	const { agent, ha } = makeAgent({ states: [st('light.a', 'off')] })
	const adm = agent.haAdmin
	const cfg = { alias: '아침 조명', triggers: [{ trigger: 'time', at: '07:00:00' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.a' } }] }
	const p = (await adm.createProposal({ kind: 'automation_upsert', target_id: 'automation.morning', title: '아침', summary: 's', payload: { config_id: 'morning', config: cfg } }, T0)).proposal
	assert.equal((await adm.approveProposal(p.pid, T0)).ok, true)
	assert.ok(adm.getProposal(p.pid).post_snapshot?.config, '적용 직후 값을 남김')
	// 사용자가 HA UI에서 시각을 바꿈
	ha.saved.set('automation:morning', { ...ha.saved.get('automation:morning'), triggers: [{ trigger: 'time', at: '06:30:00' }] })
	const writes = ha.writes
	const rb = await adm.rollbackProposal(p.pid, T0)
	assert.equal(rb.ok, false)
	assert.equal(rb.conflict, true)
	assert.equal(ha.writes, writes, 'HA에 쓰지 않음')
	assert.equal(ha.saved.get('automation:morning').triggers[0].at, '06:30:00')
	const after = adm.getProposal(p.pid)
	assert.equal(after.status, 'applied')
	assert.match(after.error, /^롤백 충돌/)
})

test('3-4 롤백 뒤 check_config가 실패하면 rolled_back이 아니라 rollback_failed', async () => {
	cleanState()
	const { agent, ha } = makeAgent({ states: [st('light.a', 'off')] })
	const adm = agent.haAdmin
	const cfg = { alias: '시험', triggers: [{ trigger: 'time', at: '07:00:00' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.a' } }] }
	const p = (await adm.createProposal({ kind: 'automation_upsert', target_id: 'automation.x1', title: '시험', summary: 's', payload: { config_id: 'x1', config: cfg } }, T0)).proposal
	assert.equal((await adm.approveProposal(p.pid, T0)).ok, true)
	ha.checkResult = { result: 'invalid', errors: 'Invalid config for automation' }
	const rb = await adm.rollbackProposal(p.pid, T0)
	assert.equal(rb.ok, false)
	assert.equal(adm.getProposal(p.pid).status, 'rollback_failed')
	assert.match(rb.error, /check_config/)
})

test('3-5 음성 설정 조정: 바꾼 키만 되돌리고, 그 키를 다시 바꿨으면 충돌', async () => {
	cleanState()
	const { agent, cfgPath } = makeAgent({ states: [], cfg: { raw: { assist: { voice: { endpoint: { silence_ms: 700, max_seconds: 8 } } } } } })
	const adm = agent.haAdmin
	const p = (await adm.createProposal({ kind: 'self_stt_tune', target_id: 'assist.voice.endpoint', title: '말끝', summary: 's', payload: { endpoint: { silence_ms: 900 } } }, T0)).proposal
	assert.equal((await adm.approveProposal(p.pid, T0)).ok, true)
	// 다른 키(max_seconds)를 나중에 바꾼 것은 롤백해도 남는다
	let raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
	raw.assist.voice.endpoint.max_seconds = 10
	writeFileSync(cfgPath, JSON.stringify(raw))
	assert.equal((await adm.rollbackProposal(p.pid, T0)).ok, true)
	assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).assist.voice.endpoint, { silence_ms: 700, max_seconds: 10 })
	// 같은 키를 그 뒤 다시 바꿨으면 충돌
	const q = (await adm.createProposal({ kind: 'self_stt_tune', target_id: 'assist.voice.endpoint', title: '말끝', summary: 's', payload: { endpoint: { silence_ms: 1000 } } }, T0)).proposal
	assert.equal((await adm.approveProposal(q.pid, T0)).ok, true)
	raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
	raw.assist.voice.endpoint.silence_ms = 1200
	writeFileSync(cfgPath, JSON.stringify(raw))
	const rb = await adm.rollbackProposal(q.pid, T0)
	assert.equal(rb.conflict, true)
	assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).assist.voice.endpoint.silence_ms, 1200)
})

// ── 4. 규칙 승격 롤백 ──
const humidRule = { id: 'bath_humid_high', description: '화장실 습도 80% 이상 20분', entity_id: 'sensor.bath_humidity', attribute: null, op: 'gt', value: 80, for_minutes: 20, cooldown_minutes: 60, priority: 'normal', also: [], hour_from: null, hour_to: null }

test('4-1 감시 규칙을 HA 자동화로 승격한 뒤 롤백하면 원래 규칙이 다시 감시 중이고 HA 자동화는 없다', async () => {
	cleanState()
	const { agent, ha } = makeAgent({ states: [st('sensor.bath_humidity', '60', { unit_of_measurement: '%' })], rules: [humidRule] })
	assert.equal(agent.engine.rules.length, 1)
	const adm = agent.haAdmin
	const cr = await adm.createProposal({ kind: 'promote_rule', target_id: 'automation.haagent_bath_humid_high', title: '승격', summary: 's', payload: { rule: humidRule } }, T0)
	assert.equal(cr.ok, true, cr.error)
	assert.equal((await adm.approveProposal(cr.proposal.pid, T0)).ok, true)
	assert.equal(agent.engine.rules.length, 0, '승격하면 감시 규칙은 지운다')
	assert.equal(ha.saved.size, 1)
	assert.equal(adm.getProposal(cr.proposal.pid).post_snapshot.removed_rule.id, 'bath_humid_high')
	const rb = await adm.rollbackProposal(cr.proposal.pid, T0)
	assert.equal(rb.ok, true, rb.error)
	assert.equal(adm.getProposal(cr.proposal.pid).status, 'rolled_back')
	assert.equal(agent.engine.rules.length, 1, '원래 규칙이 다시 감시 중')
	assert.equal(agent.engine.rules[0].id, 'bath_humid_high')
	assert.equal(readJson(P.rules, {}).rules.length, 1, 'rules.json에도 되살아남')
	assert.equal(ha.saved.size, 0, 'HA 자동화는 없다')
})

test('4-2 규칙 정의가 없는 예전 승격 제안은 롤백하지 않는다(감시가 모두 사라지지 않게)', async () => {
	cleanState()
	const { agent, ha } = makeAgent({ states: [st('sensor.bath_humidity', '60')] })
	ha.saved.set('automation:haagent_old', { id: 'haagent_old', alias: 'old' })
	agent.store.upsertProposal({ pid: 'oldpromo', ts: T0 - DAY, kind: 'promote_rule', title: '옛 승격', summary: 's', target_id: 'automation.haagent_old', payload: { config_id: 'haagent_old', rule_id: 'old_rule', config: { alias: 'old' } }, status: 'applied', applied_at: T0 - DAY })
	const rb = await agent.haAdmin.rollbackProposal('oldpromo', T0)
	assert.equal(rb.ok, false)
	assert.match(rb.error, /규칙 정의가 남아 있지 않아/)
	assert.equal(ha.saved.has('automation:haagent_old'), true, 'HA 자동화는 그대로')
	assert.equal(agent.haAdmin.getProposal('oldpromo').status, 'applied')
})

// ── 5. 생활 루틴 근거 ──
test('5-1 주체를 모르는 날만으로는 루틴 자동화를 제안하지 않는다', async () => {
	const store = new Store(join(TMP, 'routine.db'))
	try {
		const now = Date.parse('2026-11-25T23:00:00+09:00')
		const states = new Map([['light.desk', st('light.desk', 'off')], ['person.me', st('person.me', 'home')], ['zone.home', st('zone.home', '1')]])
		// 지난 3주 평일 19:30 무렵 켬. 조작 주체 기록 없음(logbook으로도 확인 안 됨)
		for (let d = 1; d <= 21; d++) {
			const date = new Date(now - d * DAY)
			const wd = new Date(date.getTime() + 9 * 3600000).getUTCDay()
			if (wd === 0 || wd === 6) continue
			const dstr = new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10)
			const t = Date.parse(`${dstr}T19:30:00+09:00`)
			store.recordEvent({ t, id: 'light.desk', name: '책상 조명', from: 'off', to: 'on' })
			store.recordEvent({ t: t + 3 * 3600000, id: 'light.desk', name: '책상 조명', from: 'on', to: 'off' })
		}
		const res = await suggestAutomations({ store, ha: { logbook: async () => [] }, states, meta: { autoCfg: {} }, policy: new PolicyEngine(mergeConfig({})), cfg: {}, isNoise: () => false, proposals: [], dry: true, now })
		const onCand = res.candidates.find(c => c.entity_id === 'light.desk' && c.direction === 'on')
		assert.ok(onCand, '루틴 후보는 찾음')
		assert.equal(onCand.status, 'skipped')
		assert.equal(onCand.reason, 'too_few_human_days')
		assert.ok(onCand.unknown_days >= 4)
		assert.equal(onCand.human_days, 0)
	} finally { store.close() }
})

// ── 6. 스크립트 최종 대상 ──
const gonggiPower = {
	alias: '공기청정기 전원', fields: { on: { description: '켜기' }, why: { description: '이유' } },
	sequence: [
		{ action: "switch.turn_{{ 'on' if on else 'off' }}", target: { entity_id: 'switch.purifier' } },
		{ action: 'input_datetime.set_datetime', target: { entity_id: 'input_datetime.retry_at' }, data: { timestamp: '{{ now().timestamp() }}' } },
		{ action: 'logbook.log', data: { name: 'x', message: 'y', entity_id: 'switch.purifier' } },
	],
}
const turnOffAndCheck = {
	alias: '소등', fields: { off_targets: { description: '소등 대상' }, off_source: { description: '출처' } },
	sequence: [{ variables: { command_targets: '{{ off_targets }}' } }, { action: 'homeassistant.turn_off', target: { entity_id: '{{ command_targets }}' } }],
}

test('6-1 스크립트 분석: 서비스명만 템플릿이면 기기를 알고, 대상이 템플릿이거나 다른 자동화를 부르면 실행 때 정해짐', () => {
	const a = analyzeScriptScope(gonggiPower)
	assert.deepEqual(a.devices.map(d => d.entity_id), ['switch.purifier'])
	assert.equal(a.dynamic.length, 0, '기록용 헬퍼·logbook은 범위 밖')
	const b = analyzeScriptScope(turnOffAndCheck)
	assert.equal(b.devices.length, 0)
	assert.match(b.dynamic[0].reason, /대상이 템플릿/)
	const dash = { alias: '대시보드 끄기', sequence: [{ action: 'automation.trigger', target: { entity_id: 'automation.all_off' } }] }
	const c = analyzeScriptScope(dash, { autoCfg: { 'automation.all_off': { actions: [{ action: 'script.turn_on', target: { entity_id: 'script.off_check' }, data: { variables: { off_targets: ['switch.a', 'light.b'] } } }] } } })
	assert.deepEqual(c.candidates, ['switch.a', 'light.b'])
	assert.match(c.dynamic[0].reason, /다른 스크립트/)
})

test('6-2 대상이 실행 때 정해지는 스크립트: 허용 범위를 적지 않으면 Tier 1·직접 요청이어도 승인, 적으면 범위 안에서만 실행', async () => {
	cleanState()
	const states = [st('script.off_check', 'off', { last_triggered: null }), st('switch.a', 'on'), st('switch.washer', 'on'), st('lock.door', 'locked')]
	const base = { policy: { tier1_auto: ['script.off_check', 'switch.a'], tier3_blocked: ['switch.washer'] } }
	{
		const { agent, ha } = makeAgent({ states, cfg: base })
		ha.scriptCfg['script.off_check'] = turnOffAndCheck
		const r = await control(agent, { entity_id: 'script.off_check', action: 'turn_on', service_data: { variables: { off_targets: 'switch.a', off_source: '시험' } } })
		assert.equal(r.status, 'pending', '직접 요청이어도 승인을 거침')
		assert.match(r.rec.approval_reason, /실행할 때 정해져요/)
		assert.equal(ha.calls.filter(c => c[0] === 'script').length, 0)
		const t3 = await control(agent, { entity_id: 'script.off_check', action: 'turn_on', service_data: { variables: { off_targets: 'switch.washer', off_source: '시험' } } })
		assert.equal(t3.ok, false)
		assert.match(t3.error, /Tier 3/)
	}
	cleanState()
	{
		const { agent, ha } = makeAgent({ states, cfg: { policy: { ...base.policy, script_targets: { 'script.off_check': { entities: ['switch.a'], services: ['homeassistant.turn_off'] } } } } })
		ha.scriptCfg['script.off_check'] = turnOffAndCheck
		const ok = await control(agent, { entity_id: 'script.off_check', action: 'turn_on', service_data: { variables: { off_targets: 'switch.a', off_source: '시험' } } })
		assert.notEqual(ok.status, 'pending', '허용 범위를 적으면 바로 실행')
		assert.equal(ha.calls.filter(c => c[0] === 'script').length, 1)
		const out = await control(agent, { entity_id: 'script.off_check', action: 'turn_on', service_data: { variables: { off_targets: 'switch.b', off_source: '시험' } } })
		assert.equal(out.ok, false)
		assert.match(out.error, /허용 범위 밖 기기를 넘길 수 없다: switch\.b/)
	}
})

test('6-3 스크립트가 바뀌어 허용 목록 밖 기기를 움직이게 되면 실행 직전에 다시 읽어 잡아낸다', async () => {
	cleanState()
	const { agent, ha, t } = makeAgent({
		states: [st('script.gonggi', 'off', { last_triggered: null }), st('switch.purifier', 'off'), st('switch.heater', 'off')],
		cfg: { policy: { tier1_auto: ['script.gonggi', 'switch.purifier'] } },
	})
	ha.scriptCfg['script.gonggi'] = gonggiPower
	const r1 = await control(agent, { entity_id: 'script.gonggi', action: 'turn_on', service_data: { variables: { on: true, why: '미세먼지' } } })
	assert.notEqual(r1.status, 'pending')
	// 누군가 스크립트를 고쳐 전기히터도 켜게 됨
	ha.scriptCfg['script.gonggi'] = { ...gonggiPower, sequence: [...gonggiPower.sequence, { action: 'switch.turn_on', target: { entity_id: 'switch.heater' } }] }
	t.now += 2 * MIN
	const r2 = await control(agent, { entity_id: 'script.gonggi', action: 'turn_on', service_data: { variables: { on: true, why: '미세먼지' } } })
	assert.equal(r2.status, 'pending', '허용 목록 밖 기기 → 승인')
	assert.match(r2.rec.approval_reason, /switch\.heater/)
})

// ── 7. Assist 요청당 한도·최종 결과 ──
test('7-1 Assist LLM 도구 경로도 요청 하나에 기기 제어 한도를 적용하고, 실패한 요청도 최종 결과로 남긴다', async () => {
	cleanState()
	const ids = ['switch.s1', 'switch.s2', 'switch.s3', 'switch.s4', 'switch.s5']
	const { agent, ha } = makeAgent({ states: ids.map(id => st(id, 'off')), cfg: { policy: { tier1_auto: ids }, actions: { per_cycle: 3 }, assist: { enabled: false, fast_path: false } } })
	// LLM 대신: 도구로 기기 5개를 켜 달라고 한다
	agent.llmRouter.run = async ({ toolContext }) => {
		for (const id of ids) await toolContext.executeControl({ entity_id: id, action: 'turn_on', service_data: {}, reason: '모두 켜기', requested: true }, { byUser: true })
		return { result: { speech: '켰어요.', continue_conversation: false }, tokens: 1 }
	}
	agent.assist.assistPlans = () => [{ tier: 'fast', mode: 'gemini', model: 'm', effort: 'low' }]
	const res = await agent.assist.runAssistTurn({ sid: 's1', text: '스위치 다 켜줘', language: 'ko', channel: 'test' })
	assert.equal(ha.calls.filter(c => c[1] === 'turn_on').length, 3, '한 요청에 3개까지')
	assert.equal(res.actions.filter(a => a.status === 'rejected').length, 2)
	assert.match(res.actions.find(a => a.status === 'rejected').error, /한 번의 요청에 3개까지/)
	const okDec = agent.store.decisionsInRange(0).filter(d => (d.reasons ?? []).includes('assist')).at(-1)
	assert.equal(okDec.applied.outcome, 'partial', '5개 중 2개가 한도로 거절됐으면 일부 실행')
	// LLM 처리 실패도 판단 기록에 남는다
	agent.llmRouter.run = async () => { throw new Error('모델 응답 없음') }
	const bad = await agent.assist.runAssistTurn({ sid: 's2', text: '거실 분위기 바꿔줘', language: 'ko', channel: 'test' })
	assert.match(bad.speech, /처리하지 못했어요/)
	const errDec = agent.store.decisionsInRange(0).filter(d => (d.reasons ?? []).includes('assist')).at(-1)
	assert.equal(errDec.applied.outcome, 'error')
	assert.match(errDec.error, /모델 응답 없음/)
})

// ── 8. 음성 설정 실시간 반영 ──
test('8-1 말끝 감지 시간 승인값이 재시작 없이 /api/assist/voice-config에 보인다', async () => {
	cleanState()
	const cfgPath = join(TMP, 'voice-config.json')
	writeFileSync(cfgPath, JSON.stringify({ policy: { admin_enabled: true }, assist: { voice: { endpoint: { silence_ms: 700 } } } }))
	const cfg = mergeConfig({ heartbeat: { enabled: false }, policy: { admin_enabled: true }, assist: { enabled: true, host: '127.0.0.1', port: 0, token_file: join(TMP, 'tok'), allowed_networks: ['127.0.0.0/8'], voice: { endpoint: { silence_ms: 700 } } } })
	const agentStub = { cfg, statusSummary: () => ({}) }
	const srv = new AssistServer({ cfg, agent: agentStub, token: 'tok' })
	const adm = new HaAdmin({ cfg, ha: { connected: true }, configPath: cfgPath, onConfigUpdated: async merged => { agentStub.cfg = merged } })
	const port = await srv.start()
	try {
		const get = async () => (await (await fetch(`http://127.0.0.1:${port}/api/assist/voice-config`, { headers: { authorization: 'Bearer tok' } })).json()).endpoint.silence_ms
		assert.equal(await get(), 700)
		const p = (await adm.createProposal({ kind: 'self_stt_tune', target_id: 'assist.voice.endpoint', title: '말끝', summary: 's', payload: { endpoint: { silence_ms: 900 } } }, T0)).proposal
		assert.equal((await adm.approveProposal(p.pid, T0)).ok, true)
		assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).assist.voice.endpoint.silence_ms, 900)
		assert.equal(await get(), 900, 'HA가 읽는 값도 바로 900')
	} finally { await srv.stop() }
})

// ── 2차 검토(2026-11-25) ──
test('R2-2 되돌리기 명령을 기기가 무시하면 원래 행동은 undone이 아니고, [다시 되돌리기]가 남는다', async () => {
	cleanState()
	const { agent, ha } = makeAgent({ states: [st('light.living', 'on', { brightness: 255 })], cfg: { policy: { tier1_auto: ['light.living'] } } })
	const r = await control(agent, { entity_id: 'light.living', action: 'turn_on', service_data: { brightness_pct: 40 } })
	assert.equal(r.status, 'done')
	ha.ignore.add('light.living|turn_on') // 되돌리기 명령을 기기가 무시
	ha.emit('action', { action: `HAAGENT_UNDO_${r.rec.aid}` })
	await new Promise(res => setTimeout(res, 1400))
	const acts = agent.store.actionsInRange(0)
	const orig = acts.find(a => a.aid === r.rec.aid)
	const undo = acts.find(a => a.undo_of === r.rec.aid)
	assert.equal(undo.status, 'unverified')
	assert.equal(orig.status, 'done', '복원이 확인되지 않았으니 원래 행동은 그대로')
	const note = ha.sent.at(-1)
	assert.match(note.title, /되돌리기 확인 안 됨/)
	assert.equal(note.data.actions[0].action, `HAAGENT_UNDO_${r.rec.aid}`, '원래 행동을 다시 되돌릴 수 있다')
	// 기기가 응답하면 다시 눌러 되돌리고, 그때 undone
	ha.ignore.clear()
	ha.emit('action', { action: `HAAGENT_UNDO_${r.rec.aid}` })
	for (let i = 0; i < 6; i++) await flush()
	await new Promise(res => setTimeout(res, 50))
	assert.equal(agent.store.actionsInRange(0).find(a => a.aid === r.rec.aid).status, 'undone')
})

test('R2-3a 제안이 새로 만든 헬퍼를 그 뒤 사용자가 고쳤으면 롤백해도 지우지 않는다', async () => {
	cleanState()
	const { agent, ha } = makeAgent({ states: [] })
	const adm = agent.haAdmin
	const p = (await adm.createProposal({ kind: 'helper_upsert', target_id: 'input_boolean', title: '휴가', summary: 's', payload: { domain: 'input_boolean', config: { name: 'Vacation', icon: 'mdi:beach' } } }, T0)).proposal
	assert.ok(p, '제안 생성')
	assert.equal((await adm.approveProposal(p.pid, T0)).ok, true)
	assert.equal(ha.helpers.input_boolean.length, 1)
	ha.helpers.input_boolean[0].icon = 'mdi:airplane' // 사용자가 HA에서 아이콘을 바꿈
	const rb = await adm.rollbackProposal(p.pid, T0)
	assert.equal(rb.conflict, true)
	assert.equal(ha.helpers.input_boolean.length, 1, '헬퍼를 지우지 않음')
	// 고치지 않았으면 롤백이 지운다
	ha.helpers.input_boolean[0].icon = 'mdi:beach'
	assert.equal((await adm.rollbackProposal(p.pid, T0)).ok, true)
	assert.equal(ha.helpers.input_boolean.length, 0)
})

test('R2-3b 적용 실패 → 자동 롤백 뒤에도 check_config가 실패하면 rolled_back이 아니라 rollback_failed', async () => {
	cleanState()
	const { agent, ha } = makeAgent({ states: [st('light.a', 'off')] })
	const adm = agent.haAdmin
	const cfg = { alias: '시험', triggers: [{ trigger: 'time', at: '07:00:00' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.a' } }] }
	const p = (await adm.createProposal({ kind: 'automation_upsert', target_id: 'automation.y1', title: '시험', summary: 's', payload: { config_id: 'y1', config: cfg } }, T0)).proposal
	let checks = 0
	ha.checkConfig = async () => { checks++; return { result: 'invalid', errors: '다른 곳도 깨짐' } }
	const ap = await adm.approveProposal(p.pid, T0)
	assert.equal(ap.ok, false)
	assert.equal(checks, 2, '적용 직후 + 되돌린 뒤')
	assert.equal(adm.getProposal(p.pid).status, 'rollback_failed')
	assert.equal(ha.saved.has('automation:y1'), false, '새 자동화는 지워 둠')
})

test('R2-4 승인 대기 중 원래 감시 규칙을 고쳤으면 승격하지 않는다(옛 조건이 HA에 올라가고 새 규칙이 지워지지 않게)', async () => {
	cleanState()
	const rule30 = { ...humid, value: 30 }
	const { agent, ha } = makeAgent({ states: [st('sensor.bath_humidity', '60', { unit_of_measurement: '%' })], rules: [rule30] })
	const adm = agent.haAdmin
	// 판단이 옮겨 적은 규칙이 조금 달라도 지금 엔진의 규칙이 기준
	const llmConfig = { alias: '판단이 쓴 다른 설정', triggers: [{ trigger: 'numeric_state', entity_id: 'sensor.bath_humidity', above: 90 }], actions: [{ action: 'notify.mobile_app_x', data: { message: 'x' } }] }
	const cr = await adm.createProposal({ kind: 'promote_rule', target_id: 'automation.haagent_bath_humid_high', title: '승격', summary: 's', payload: { rule: { ...rule30, description: '옮겨 적음' }, config: llmConfig } }, T0)
	assert.equal(cr.ok, true, cr.error)
	assert.equal(cr.proposal.payload.rule.description, humid.description)
	assert.notEqual(cr.proposal.payload.config.alias, llmConfig.alias, '옮길 수 있는 규칙은 판단이 쓴 설정 대신 규칙에서 만든다')
	assert.match(JSON.stringify(cr.proposal.payload.config), /"above":30/)
	// 승인 전에 사용자가 임계값을 40으로 고침
	agent.engine.setRules([{ ...rule30, value: 40 }], agent.states, T0, ['bath_humid_high'])
	const ap = await adm.approveProposal(cr.proposal.pid, T0)
	assert.equal(ap.ok, false)
	assert.match(ap.error, /감시 규칙이 바뀌었어요/)
	assert.equal(ha.saved.size, 0, 'HA에 옛 조건을 올리지 않음')
	assert.equal(agent.engine.rules[0].value, 40, '고친 규칙은 그대로 감시 중')
	// 지금 감시 규칙에 없는 규칙은 승격 제안도 만들지 않는다
	const none = await adm.createProposal({ kind: 'promote_rule', target_id: 'automation.haagent_x', title: '승격', summary: 's', payload: { rule: { ...humid, id: 'not_a_rule' } } }, T0)
	assert.equal(none.ok, false)
})

// 5-1과 같은 모양의 기록에, 조작자 정보가 없는 logbook을 준다
async function routineCase({ platform, logbookRows = true }) {
	const store = new Store(join(TMP, `routine-${platform ?? 'none'}-${Math.random()}.db`))
	try {
		const now = Date.parse('2026-11-25T23:00:00+09:00')
		const states = new Map([['light.desk', st('light.desk', 'off')], ['person.me', st('person.me', 'home')], ['zone.home', st('zone.home', '1')]])
		const rows = []
		for (let d = 1; d <= 21; d++) {
			const date = new Date(now - d * DAY)
			const wd = new Date(date.getTime() + 9 * 3600000).getUTCDay()
			if (wd === 0 || wd === 6) continue
			const dstr = new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10)
			const t = Date.parse(`${dstr}T19:30:00+09:00`)
			store.recordEvent({ t, id: 'light.desk', name: '책상 조명', from: 'off', to: 'on' })
			store.recordEvent({ t: t + 3 * 3600000, id: 'light.desk', name: '책상 조명', from: 'on', to: 'off' })
			// 시각·기기·상태만 있고 조작자(context_*) 정보가 없는 줄
			rows.push({ entity_id: 'light.desk', when: t / 1000, state: 'on' }, { entity_id: 'light.desk', when: (t + 3 * 3600000) / 1000, state: 'off' })
		}
		const meta = { autoCfg: {}, platformOf: platform ? new Map([['light.desk', platform]]) : new Map() }
		const res = await suggestAutomations({ store, ha: { logbook: async () => (logbookRows ? rows : []) }, states, meta, policy: new PolicyEngine(mergeConfig({})), cfg: {}, isNoise: () => false, proposals: [], dry: true, now })
		return res.candidates.find(c => c.entity_id === 'light.desk' && c.direction === 'on')
	} finally { store.close() }
}

test('R2-5 조작자 기록 없는 logbook은 클라우드·Wi-Fi 기기면 주체 불명, 로컬 무선 기기면 물리 조작 추정으로 따로 센다', async () => {
	const cloud = await routineCase({ platform: 'tplink' })
	assert.equal(cloud.reason, 'too_few_human_days', '제조사 앱·예약일 수 있어 사람 조작으로 세지 않음')
	assert.equal(cloud.human_days, 0)
	assert.equal(cloud.physical_days, 0)
	assert.ok(cloud.unknown_days >= 4)
	const unknownPlatform = await routineCase({ platform: null })
	assert.equal(unknownPlatform.reason, 'too_few_human_days', '통합을 모르면 주체 불명')
	const zha = await routineCase({ platform: 'zha' })
	assert.equal(zha.attribution.human, 0, '사용자 조작 확인은 0일')
	assert.ok(zha.attribution.physical >= 4, '물리 조작 추정으로 따로 셈')
	assert.equal(zha.status, 'eligible')
	assert.match(zha.evidence, /사람이 켠 것으로 보여요/)
	assert.match(zha.evidence, /사용자 조작 확인 0일, 조작자 기록 없이 기기에서 바뀐 \d+일은 벽 스위치·리모컨 조작으로 추정\(zha\)/)
})

test('R2-6a 스크립트 설정을 다시 읽지 못하면 예전 분석을 믿지 않고 승인을 받는다', async () => {
	cleanState()
	const { agent, ha, t } = makeAgent({
		states: [st('script.gonggi', 'off', { last_triggered: null }), st('switch.purifier', 'off')],
		cfg: { policy: { tier1_auto: ['script.gonggi', 'switch.purifier'] } },
	})
	ha.scriptCfg['script.gonggi'] = gonggiPower
	assert.notEqual((await control(agent, { entity_id: 'script.gonggi', action: 'turn_on', service_data: { variables: { on: true, why: 'x' } } })).status, 'pending')
	ha.scriptFail = true
	t.now += 2 * MIN
	const r = await control(agent, { entity_id: 'script.gonggi', action: 'turn_on', service_data: { variables: { on: true, why: 'x' } } })
	assert.equal(r.status, 'pending')
	assert.match(r.rec.approval_reason, /다시 읽지 못해/)
	// 다시 읽히면 원래대로
	ha.scriptFail = false
	t.now += 2 * MIN
	assert.notEqual((await control(agent, { entity_id: 'script.gonggi', action: 'turn_on', service_data: { variables: { on: false, why: 'x' } } })).status, 'pending')
})

test('R2-6b 허용 동작을 적은 스크립트: 동작 이름이 템플릿이면 정확한 이름 목록으로는 승인, switch.turn_* 범위로 적으면 바로 실행', async () => {
	cleanState()
	const states = [st('script.gonggi', 'off', { last_triggered: null }), st('switch.purifier', 'off')]
	const run = async services => {
		cleanState()
		const { agent, ha } = makeAgent({ states, cfg: { policy: { tier1_auto: ['script.gonggi'], script_targets: { 'script.gonggi': { entities: ['switch.purifier'], services } } } } })
		ha.scriptCfg['script.gonggi'] = gonggiPower
		return control(agent, { entity_id: 'script.gonggi', action: 'turn_on', service_data: { variables: { on: true, why: 'x' } } })
	}
	const exact = await run(['switch.turn_on', 'switch.turn_off'])
	assert.equal(exact.status, 'pending')
	assert.match(exact.rec.approval_reason, /동작 이름이 실행 때 정해져/)
	const wide = await run(['switch.turn_*'])
	assert.notEqual(wide.status, 'pending')
	const wrong = await run(['light.turn_*'])
	assert.equal(wrong.ok, false, '템플릿의 고정된 앞부분(switch.turn_)이 허용 범위와 맞을 수 없으면 거절')
})

test('R2-7 Assist 요청을 CLI 판단 방식으로 처리할 때도 max_actions_per_turn을 쓰고 Assist 요청 결과로 남긴다', async () => {
	cleanState()
	const ids = ['switch.s1', 'switch.s2', 'switch.s3']
	const { agent, ha } = makeAgent({
		states: ids.map(id => st(id, 'off')),
		cfg: { policy: { tier1_auto: ids }, actions: { per_cycle: 3 }, assist: { max_actions_per_turn: 2 } },
		brain: async () => ({ result: answer({ actions: ids.map(id => ({ entity_id: id, action: 'turn_on', reason: '모두 켜기' })) }), ms: 1, tokens: 1 }),
	})
	const entry = await agent.cycle([{ type: 'user', text: '다 켜줘', about: 'HA Assist', urgent: true, at: T0, assist: true }])
	assert.equal(ha.calls.filter(c => c[1] === 'turn_on').length, 2)
	assert.match(JSON.stringify(entry.applied.rejected), /한 번의 요청에 2개까지/)
	assert.equal(entry.reasons[0], 'assist')
	assert.equal(entry.applied.outcome, 'partial')
})

test('R2-9 Assist 결과 기록: 실제로 부른 모델만 적고, 오늘 한도로 거절한 요청·일시정지 요청도 남긴다', async () => {
	cleanState()
	const { agent } = makeAgent({ states: [st('switch.s1', 'off')], cfg: { policy: { tier1_auto: ['switch.s1'] }, assist: { fast_path: false } } })
	agent.assist.assistPlans = () => [{ tier: 'fast', mode: 'gemini', model: 'fast-m', effort: 'low' }, { tier: 'deep', mode: 'gemini', model: 'deep-m', effort: 'low' }]
	const called = []
	// 첫 모델이 기기를 움직인 뒤 실패 → 중복 실행을 막으려고 두 번째 모델은 부르지 않는다
	agent.llmRouter.run = async ({ model, toolContext }) => {
		called.push(model)
		await toolContext.executeControl({ entity_id: 'switch.s1', action: 'turn_on', service_data: {}, reason: '켜기', requested: true }, { byUser: true })
		throw new Error('응답 형식 오류')
	}
	await agent.assist.runAssistTurn({ sid: 'a1', text: '켜줘', language: 'ko', channel: 'test' })
	assert.deepEqual(called, ['fast-m'])
	const last = () => agent.store.decisionsInRange(0).filter(d => (d.reasons ?? []).includes('assist')).at(-1)
	assert.equal(last().model, 'fast-m', '부르지 않은 두 번째 모델을 적지 않음')
	assert.equal(last().applied.fell_back, false)
	assert.deepEqual(last().applied.tried, ['gemini/fast-m'])
	// 오늘 판단 한도로 거절한 요청
	agent.overLimit = () => true
	await agent.assist.runAssistTurn({ sid: 'a2', text: '꺼줘', language: 'ko', channel: 'test' })
	assert.equal(last().applied.outcome, 'limit')
	// 일시정지 중 받은 요청(성공률 분모에서는 뺀다)
	saveControl({ paused: true, send: true })
	await agent.assist.runAssistTurn({ sid: 'a3', text: '꺼줘', language: 'ko', channel: 'test' })
	assert.equal(last().applied.outcome, 'paused')
})
