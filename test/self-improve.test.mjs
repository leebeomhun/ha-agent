// 자가개선 우선순위 1~5 통합·회귀 테스트:
// 1) 학습 신호(조작 주체·자동화 뒤집힘·알림 후 조치·제안 무시·사용자의 자동화 직접 수정)
// 2) 루틴 → 자동화 제안(사람 조작 확인·중복 제거·트리거 선택·백테스트), 주간 보고서 초안 → proposals
// 3) 루프 닫기(실험 후속 조치, 별칭 회귀 평가 게이트)
// 4) 자기 성능 지표(스코어카드)
// 5) 기기 건강, 씬·헬퍼 관리 제안
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'haagent-selfimprove-'))
process.env.HAAGENT_DATA_DIR = DATA
after(() => rmSync(DATA, { recursive: true, force: true }))

const { mergeConfig, saveControl } = await import('../src/config.mjs')
const { P, DAY, kst, writeJson, readJson } = await import('../src/util.mjs')
const { Store } = await import('../src/core/store.mjs')
const { PolicyEngine } = await import('../src/core/policy.mjs')
const { checkMessage } = await import('../src/ha.mjs')
const { Agent, reportHasAutomationDraft, automationChangeSummary } = await import('../src/agent.mjs')
const { OriginTracker, logbookOrigin } = await import('../src/engine/origin.mjs')
const { ImplicitFeedbackTracker, registerExperiment } = await import('../src/engine/learning.mjs')
const { suggestAutomations } = await import('../src/engine/automation-suggest.mjs')
const { buildScorecard, renderScorecard } = await import('../src/engine/scorecard.mjs')
const { scanDeviceHealth, newHealthIssues, healthIssueKeys } = await import('../src/engine/device-health.mjs')
const { checkAliasChange, runFastPathRegression, directoryIndexFor, fastPathCases } = await import('../src/engine/regression.mjs')
const { changeLines } = await import('../src/context.mjs')
const { AssistServer } = await import('../src/channels/assist-server.mjs')

const MIN = 60000
const T0 = Date.parse('2026-11-25T10:00:00+09:00') // 수요일 오전 10시 KST
const st = (entity_id, state, at = T0 - 60 * MIN, attrs = {}) => ({
	entity_id, state, attributes: { friendly_name: entity_id, ...attrs },
	last_changed: new Date(at).toISOString(), last_updated: new Date(at).toISOString(),
	context: { id: `init_${entity_id}`, parent_id: null, user_id: null },
})
const answer = over => ({
	summary: '요약', notifications: [], rule_changes: { upsert: [], delete: [] }, next_wakes: [], memory: { mode: 'keep', text: '' },
	memory_ops: [], lesson_ops: [], info_requests: [], actions: [], proposals: [], report: '', ...over,
})
const at = (date, hm) => Date.parse(`${date}T${hm}:00+09:00`)

class FakeHA extends EventEmitter {
	constructor(list, policy) {
		super()
		this.connected = true
		this.map = new Map(list.map(s => [s.entity_id, s]))
		this.guard = { services: new Set(['notify.mobile_app_x']), actionEntities: new Set(), policy, allowConfigWrite: false }
		this.sent = [] // 휴대폰 알림
		this.serviceCalls = []
		this.autoCfg = {}
		this.rest = new Map() // HA 설정 파일(automation/script/scene)
		this.helpers = { input_boolean: [] }
		this.logRows = []
		// 엔티티 레지스트리의 통합 이름. 서재 스위치는 HA에만 붙는 Zigbee(zha) 벽 스위치라 조작자 기록 없는 변화를 물리 조작으로 본다.
		this.registry = [{ entity_id: 'switch.study', platform: 'zha' }, { entity_id: 'light.auto', platform: 'zha' }, { entity_id: 'switch.covered', platform: 'zha' }]
		this.ctxN = 0
	}
	start() {}
	stop() {}
	setState(id, state, { at: when = T0, ctx = {} } = {}) {
		const old = this.map.get(id)
		const n = { ...st(id, state, when, old?.attributes ?? {}), context: { id: ctx.id ?? `ctx_${++this.ctxN}`, parent_id: ctx.parent_id ?? null, user_id: ctx.user_id ?? null } }
		this.map.set(id, n)
		this.emit('state', { entity_id: id, old_state: old, new_state: n })
	}
	// 실제 연결과 같은 메시지 검사(헬퍼 쓰기는 승인된 제안을 적용할 때만)를 거친다
	async call(msg) {
		const bad = checkMessage(msg, this.guard)
		if (bad) throw new Error(bad)
		const t = msg.type
		if (t === 'get_states') return [...this.map.values()]
		if (t === 'repairs/list_issues') return { issues: [] }
		if (t === 'config/entity_registry/list') return structuredClone(this.registry)
		if (/registry\/list$/.test(t) || t === 'system_log/list') return []
		if (t === 'automation/config') { const c = this.autoCfg[msg.entity_id]; if (!c) throw new Error('not found'); return { config: structuredClone(c) } }
		if (t === 'script/config') return { config: { fields: {} } }
		const m = /^(input_boolean)\/(list|create|update|delete)$/.exec(t)
		if (m) {
			const list = this.helpers[m[1]]
			if (m[2] === 'list') return structuredClone(list)
			if (m[2] === 'create') { const item = { id: msg.name.replace(/\s+/g, '_').toLowerCase(), name: msg.name, ...(msg.icon ? { icon: msg.icon } : {}) }; list.push(item); return item }
			const id = msg[`${m[1]}_id`]
			const i = list.findIndex(h => h.id === id)
			if (i < 0) throw new Error('없는 헬퍼')
			if (m[2] === 'update') { const { type, [`${m[1]}_id`]: _, ...fields } = msg; list[i] = { ...list[i], ...fields }; return list[i] }
			list.splice(i, 1)
			return null
		}
		throw new Error(`가짜 HA가 모르는 명령: ${t}`)
	}
	async callService(domain, service, { data = {}, target } = {}) {
		if (domain === 'notify') { this.sent.push(data); return {} }
		if (domain === 'weather' || domain === 'calendar') return { response: {} }
		this.serviceCalls.push(`${domain}.${service}${target?.entity_id ? ` ${target.entity_id}` : ''}`)
		if (target?.entity_id && ['turn_on', 'turn_off'].includes(service)) {
			// 실제 HA처럼 상태 변화 이벤트가 호출 응답보다 먼저 온다
			const id = `agentctx_${++this.ctxN}`
			this.setState(target.entity_id, service === 'turn_on' ? 'on' : 'off', { at: Date.now(), ctx: { id, user_id: 'owner' } })
			return { context: { id, parent_id: null, user_id: 'owner' } }
		}
		return { context: { id: `svc_${++this.ctxN}` } }
	}
	async heartbeat() {}
	async history() { return {} }
	async statistics() { return {} }
	async logbook(ids) { return this.logRows.filter(r => ids.includes(r.entity_id)) }
	async getConfigRest(d, id) { const k = `${d}:${id}`; if (!this.rest.has(k)) throw new Error('HA REST 404: Resource not found'); return structuredClone(this.rest.get(k)) }
	async saveConfigRest(d, id, c) { if (!this.guard.allowConfigWrite) throw new Error('쓰기 가드'); this.rest.set(`${d}:${id}`, structuredClone(c)) }
	async deleteConfigRest(d, id) { if (!this.guard.allowConfigWrite) throw new Error('쓰기 가드'); this.rest.delete(`${d}:${id}`) }
	async checkConfig() { return { result: 'valid' } }
	async renderTemplate() { return 'ok' }
	async traces() { return [] }
	async configEntries() { return [] }
	async backupInfo() { return {} }
}

const baseStates = () => [
	st('person.me', 'home'), st('zone.home', '1'),
	st('light.a', 'off'), st('fan.bath', 'off'), st('sensor.bath_humidity', '60', T0 - 60 * MIN, { unit_of_measurement: '%' }),
	st('switch.study', 'off', T0 - 60 * MIN, { friendly_name: '서재 스위치' }),
	st('light.auto', 'off', T0 - 60 * MIN, { friendly_name: '자동 조명' }),
	st('switch.covered', 'off', T0 - 60 * MIN, { friendly_name: '커버 스위치' }),
	st('switch.b', 'off', T0 - 60 * MIN, { friendly_name: '작업 스위치' }),
	st('switch.geosil_seuwici', 'off', T0 - 60 * MIN, { friendly_name: '거실 스위치' }),
	st('automation.morning', 'on'), st('automation.made_by_agent', 'on'), st('automation.old', 'on'),
]

function setup({ states, cfg = {}, brain, rules = [] } = {}) {
	rmSync(DATA, { recursive: true, force: true })
	mkdirSync(P.state, { recursive: true })
	saveControl({ paused: false, send: true })
	writeJson(P.rules, { updated: new Date(T0).toISOString(), rules })
	const t = { now: T0, prompts: [], oob: [] }
	const full = mergeConfig({
		heartbeat: { enabled: false }, notify_targets: ['mobile_app_x'], ...cfg,
		actions: { enabled: true, verify_seconds: 1, ...(cfg.actions ?? {}) },
		policy: { admin_enabled: true, tier2_confirm: ['switch.b', 'switch.geosil_seuwici'], tier3_blocked: ['lock.*', 'switch.danger*', 'input_boolean.kona_*'], ...(cfg.policy ?? {}) },
		assist: { enabled: false, aliases: { 'switch.geosil_seuwici': ['거실 불'] }, ...(cfg.assist ?? {}) },
	})
	const ha = new FakeHA(states ?? baseStates(), new PolicyEngine(full))
	const run = brain ?? (async () => ({ result: answer(), ms: 1, tokens: 10 }))
	const agent = new Agent({
		cfg: full, ha, clock: () => t.now, canUse: () => false,
		brain: async a => { t.prompts.push(a.prompt); return run(a) },
		oob: async (_c, title, message) => { t.oob.push([title, message]); return true },
	})
	agent.attach()
	ha.emit('ready', [...ha.map.values()])
	return { agent, ha, t }
}
const implicitKinds = agent => agent.store.recentImplicitFeedback({ sinceMs: 0, limit: 500 }).map(r => r.kind)

test('1-1. 조작 주체: 집 비서 호출(응답보다 먼저 온 이벤트 포함)·자동화 실행 context·자식 context·사용자·기기를 가린다', () => {
	const o = new OriginTracker()
	o.noteAgentCall('light.a', 'on', null, T0) // 부르기 직전 예고
	assert.deepEqual(o.classify({ entity_id: 'light.a', state: 'on', context: { id: 'c1', user_id: 'owner' } }, T0 + 500), { origin: 'agent', actor: null })
	o.noteAgentCall('light.b', 'on', { context: { id: 'c2' } }, T0)
	assert.equal(o.classify({ entity_id: 'light.b', state: 'on', context: { id: 'c2', user_id: 'owner' } }, T0 + 60000).origin, 'agent', 'context id로 집 비서 확인')
	o.noteAutomationTriggered({ context: { id: 'a1' }, data: { entity_id: 'automation.lights' } }, T0)
	assert.deepEqual(o.classify({ entity_id: 'light.c', state: 'on', context: { id: 'a1' } }, T0), { origin: 'automation', actor: 'automation.lights' })
	assert.deepEqual(o.classify({ entity_id: 'light.c', state: 'off', context: { id: 'x', parent_id: 'a1' } }, T0), { origin: 'automation', actor: 'automation.lights' })
	assert.equal(o.classify({ entity_id: 'light.c', state: 'off', context: { id: 'y', parent_id: 'zz' } }, T0).origin, 'automation', '다른 일이 이어서 일으킨 변화')
	assert.deepEqual(o.classify({ entity_id: 'light.c', state: 'on', context: { id: 'z', user_id: 'u1' } }, T0), { origin: 'user', actor: 'u1' })
	assert.equal(o.classify({ entity_id: 'light.c', state: 'off', context: { id: 'w' } }, T0).origin, 'device', '벽 스위치 등 기기 쪽 조작')
	// logbook으로 과거 기록의 주체 되짚기
	assert.equal(logbookOrigin({ context_event_type: 'automation_triggered', context_entity_id: 'automation.x' }), 'automation')
	assert.equal(logbookOrigin({ context_event_type: 'call_service', context_user_id: 'u1' }), 'user')
	assert.equal(logbookOrigin({ context_event_type: 'homekit_state_change' }), 'device')
	assert.equal(logbookOrigin({}), 'device')
	// 판단 프롬프트의 변화 줄에 주체가 붙는다
	const lines = changeLines([
		{ t: T0, id: 'light.c', from: 'off', to: 'on', origin: 'automation', actor: 'automation.lights' },
		{ t: T0 + MIN, id: 'light.d', from: 'off', to: 'on', origin: 'device' },
		{ t: T0 + 2 * MIN, id: 'light.e', from: 'off', to: 'on', origin: 'agent' },
	])
	assert.match(lines[0], /\[자동화: automation\.lights\]$/)
	assert.match(lines[1], /\[사람·기기\]$/)
	assert.match(lines[2], /\[집 비서\]$/)
})

test('1-2. 학습 신호: 자동화 뒤집힘, 알림 후 조치, 집 비서 제어 되돌림(사람만), 이벤트에 주체 저장', async () => {
	const x = setup({ rules: [{ id: 'hum_high', description: '욕실 습도 높음', entity_id: 'sensor.bath_humidity', attribute: null, op: 'gt', value: 80, for_minutes: 0, cooldown_minutes: 60, priority: 'normal', also: [], hour_from: null, hour_to: null }] })
	try {
		// 자동화가 켠 불을 사람이 2분 뒤 벽 스위치로 끔 → automation_overridden
		x.ha.emit('automation_triggered', { entity_id: 'automation.lights' }, { context: { id: 'run1' }, data: { entity_id: 'automation.lights' } })
		x.ha.setState('light.a', 'on', { at: x.t.now, ctx: { id: 'run1' } })
		x.t.now += 2 * MIN
		x.ha.setState('light.a', 'off', { at: x.t.now })
		const ov = x.agent.store.recentImplicitFeedback({ sinceMs: 0, kind: 'automation_overridden' })
		assert.equal(ov.length, 1)
		assert.equal(ov[0].ref_id, 'automation.lights')
		const ev = x.agent.store.recentEvents({ entityId: 'light.a', limit: 5 })
		assert.deepEqual(ev.map(e => [e.to, e.origin, e.actor ?? null]), [['on', 'automation', 'automation.lights'], ['off', 'device', null]], '이벤트에 주체 저장')

		// 습도 알림 뒤 5분 안에 사람이 같은 방(욕실) 환풍기를 앱으로 켬 → notification_acted
		x.agent.meta.areaOf = new Map([['sensor.bath_humidity', '욕실'], ['fan.bath', '욕실'], ['light.a', '거실']])
		await x.agent.notifier.deliver({ kind: 'alert', level: 'normal', title: '욕실 습도가 높아요', message: '85%', related_rule_ids: ['hum_high'] })
		x.t.now += 5 * MIN
		x.ha.setState('fan.bath', 'on', { at: x.t.now, ctx: { user_id: 'u1' } })
		const acted = x.agent.store.recentImplicitFeedback({ sinceMs: 0, kind: 'notification_acted' })
		assert.equal(acted.length, 1)
		assert.equal(acted[0].entity_id, 'fan.bath')
		x.ha.setState('fan.bath', 'off', { at: x.t.now + MIN, ctx: { user_id: 'u1' } })
		assert.equal(x.agent.store.recentImplicitFeedback({ sinceMs: 0, kind: 'notification_acted' }).length, 1, '알림 하나에 한 번만')

		// 집 비서가 켠 기기를 자동화가 끈 것은 사람의 거부(action_reverted)가 아니다
		const fb = new ImplicitFeedbackTracker({ store: x.agent.store })
		fb.trackExecutedControl({ entity_id: 'switch.b', service: 'turn_on', prev: 'off', aid: 'a1' }, T0)
		assert.equal(fb.onStateEvent({ id: 'switch.b', from: 'on', to: 'off', origin: 'automation' }, { now: T0 + MIN }), null)
		fb.trackExecutedControl({ entity_id: 'switch.b', service: 'turn_on', prev: 'off', aid: 'a2' }, T0)
		assert.equal(fb.onStateEvent({ id: 'switch.b', from: 'on', to: 'off', origin: 'device' }, { now: T0 + MIN })?.kind, 'action_reverted')
	} finally { x.agent.stop() }
})

test('1-3. 학습 신호: 승인 없이 만료된 제안 = 무시(proposal_ignored), 사용자의 자동화 직접 수정 감지·기억', async () => {
	const x = setup({ cfg: { policy: { proposal_expire_hours: 1 } } })
	try {
		const r = await x.agent.haAdmin.createProposal({ kind: 'backup_create', target_id: 'ha', title: '백업', summary: '수동 백업' }, x.t.now)
		assert.equal(r.ok, true)
		x.t.now += 2 * 3600000
		await x.agent.tick()
		assert.ok(implicitKinds(x.agent).includes('proposal_ignored'))

		// 기준선
		x.ha.autoCfg = {
			'automation.morning': { id: 'morning', alias: '아침', triggers: [{ trigger: 'time', at: '07:00:00' }], actions: [] },
			'automation.made_by_agent': { id: 'made_by_agent', alias: '[집 비서] 귀가 조명', triggers: [{ trigger: 'time', at: '18:00:00' }], actions: [{ action: 'light.turn_on', target: { entity_id: 'light.a' } }] },
			'automation.old': { id: 'old', alias: '옛 자동화', triggers: [], actions: [] },
		}
		await x.agent.refreshMeta(x.t.now, true)
		assert.ok(x.agent.runtime.auto_cfg['automation.morning'].hash)
		assert.equal(implicitKinds(x.agent).filter(k => k === 'automation_user_edited').length, 0, '첫 기준선에서는 신호 없음')
		// 집 비서 제안으로 만든 자동화(예전에 적용)
		x.agent.store.upsertProposal({ pid: 'pmade', ts: T0 - 3 * DAY, kind: 'automation_upsert', title: '귀가 조명', summary: 's', target_id: 'automation.made_by_agent', payload: { config_id: 'made_by_agent', config: {} }, status: 'applied', applied_at: T0 - 3 * DAY, decided_at: T0 - 3 * DAY })

		// 사용자가 HA에서: 집 비서 자동화 시각 변경, 아침 자동화 이름 변경, 옛 자동화 삭제
		x.ha.autoCfg['automation.made_by_agent'].triggers[0].at = '18:30:00'
		x.ha.autoCfg['automation.morning'].alias = '아침 루틴'
		delete x.ha.autoCfg['automation.old']
		x.ha.map.delete('automation.old')
		x.agent.states.delete('automation.old')
		x.t.now += 7 * 3600000
		await x.agent.refreshMeta(x.t.now, true)
		const edits = x.agent.store.recentImplicitFeedback({ sinceMs: 0, kind: 'automation_user_edited' })
		assert.deepEqual(edits.map(e => [e.entity_id, e.detail.change]).sort(), [['automation.made_by_agent', 'modified'], ['automation.morning', 'modified'], ['automation.old', 'deleted']])
		assert.ok(edits.find(e => e.entity_id === 'automation.made_by_agent').detail.fields.includes('시각 18:00:00→18:30:00'))
		assert.equal(x.agent.store.recentImplicitFeedback({ sinceMs: 0, kind: 'proposal_edited_by_user' })[0]?.ref_id, 'pmade')
		const mem = x.agent.store.getMemory('auto_edit_made_by_agent')
		assert.match(mem.content, /18:00:00→18:30:00/)
		assert.equal(mem.source, 'user_edit')
		assert.equal(automationChangeSummary({ alias: 'a' }, { alias: 'b' }).includes('이름'), true)
	} finally { x.agent.stop() }
})

// 3주치 생활 기록: 평일 18:00 귀가 → 18:05 서재 스위치를 손으로 켬, 23:00 끔.
// 자동 조명은 자동화가 켜고 끔(주체 기록은 없고 logbook에만 있음), 커버 스위치는 이미 자동화가 다룸.
function seedRoutineData(store, ha, now) {
	for (let d = 21; d >= 1; d--) {
		const date = kst(new Date(now - d * DAY)).date
		const wd = kst(new Date(at(date, '12:00'))).wd
		if (wd === '토' || wd === '일') continue
		store.recordEvent({ t: at(date, '08:00'), id: 'person.me', from: 'home', to: 'not_home', origin: 'device' })
		store.recordEvent({ t: at(date, '18:00'), id: 'person.me', from: 'not_home', to: 'home', origin: 'device' })
		store.recordEvent({ t: at(date, '18:05'), id: 'switch.study', name: '서재 스위치', from: 'off', to: 'on', origin: 'device' })
		store.recordEvent({ t: at(date, '23:00'), id: 'switch.study', name: '서재 스위치', from: 'on', to: 'off', origin: 'device' })
		store.recordEvent({ t: at(date, '18:02'), id: 'light.auto', name: '자동 조명', from: 'off', to: 'on' })
		store.recordEvent({ t: at(date, '23:05'), id: 'light.auto', name: '자동 조명', from: 'on', to: 'off' })
		ha.logRows.push({ entity_id: 'light.auto', when: at(date, '18:02') / 1000, state: 'on', context_event_type: 'automation_triggered', context_entity_id: 'automation.lights' })
		ha.logRows.push({ entity_id: 'light.auto', when: at(date, '23:05') / 1000, state: 'off', context_event_type: 'automation_triggered', context_entity_id: 'automation.lights' })
		store.recordEvent({ t: at(date, '18:10'), id: 'switch.covered', name: '커버 스위치', from: 'off', to: 'on', origin: 'user' })
	}
}

test('2-1. 루틴 → 자동화 제안: 사람 조작만, 기존 자동화 제외, 귀가 트리거 선택, 백테스트 근거, 승인·적용, 중복 방지', async () => {
	const x = setup()
	try {
		x.t.now = Date.parse('2026-11-25T20:00:00+09:00')
		seedRoutineData(x.agent.store, x.ha, x.t.now)
		x.ha.autoCfg = { 'automation.morning': { id: 'covered', alias: '커버 자동', triggers: [], actions: [{ action: 'switch.turn_on', target: { entity_id: 'switch.covered' } }] } }
		await x.agent.refreshMeta(x.t.now, true)

		const dry = await x.agent.suggestAutomationsNow({ dry: true })
		const by = (id, dir) => dry.candidates.find(c => c.entity_id === id && c.direction === dir)
		assert.equal(by('light.auto', 'on').reason, 'automation_driven', '자동화가 한 일(logbook)로 확인되어 제외')
		assert.deepEqual(by('switch.covered', 'on').reason, 'existing_automation')
		assert.deepEqual(by('switch.covered', 'on').automations, ['커버 자동'])
		const on = by('switch.study', 'on')
		assert.equal(on.status, 'eligible')
		assert.equal(on.trigger, 'arrival', '귀가 직후 켠 것이라 귀가 트리거')
		assert.equal(on.backtest[0].precision, 1)
		assert.equal(on.config.triggers[0].entity_id, 'person.me')
		assert.deepEqual(on.config.conditions.at(-1), { condition: 'state', entity_id: 'switch.study', state: 'off' })
		assert.deepEqual(on.config.actions, [{ action: 'switch.turn_on', target: { entity_id: 'switch.study' } }])
		assert.match(on.evidence, /사람이 켠 것으로 보여요/, '사용자 조작 확인이 없으면 단정하지 않음')
		assert.match(on.evidence, /벽 스위치·리모컨 조작으로 추정\(zha\)/, '사용자 조작 확인과 물리 조작 추정을 나눠 적는다')
		assert.equal(on.attribution.physical, on.attribution.human + on.attribution.physical, '조작자 기록 없는 날은 물리 조작 추정으로만 셈')
		const off = by('switch.study', 'off')
		assert.equal(off.status, 'eligible')
		assert.equal(off.trigger, 'time')
		assert.equal(off.config.triggers[0].at, '23:00:00')
		assert.deepEqual(off.config.conditions[1], { condition: 'numeric_state', entity_id: 'zone.home', above: 0 }, '집에 누가 있을 때만')
		assert.equal(x.agent.haAdmin.listProposals().length, 0, 'dry는 제안을 올리지 않음')

		// 실제로 올리면: 승인 대기 제안 + 승인 알림, 승인하면 HA 설정에 저장
		const real = await x.agent.suggestAutomationsNow({ dry: false })
		assert.equal(real.created.length, 2)
		const p = x.agent.haAdmin.listProposals({ status: 'pending' }).find(q => q.payload.config_id === on.config_id)
		assert.ok(p)
		assert.match(p.summary, /정확도 100%/)
		assert.ok(x.ha.sent.some(n => /승인 요청: 생활 루틴 자동화/.test(n.title)))
		const ap = await x.agent.handleProposalAction(p.pid, 'approve')
		assert.equal(ap.ok, true, ap.error)
		assert.equal(x.ha.rest.get(`automation:${on.config_id}`).triggers[0].to, 'home')

		// 다시 계산하면 이미 올린 것은 건너뜀
		const again = await x.agent.suggestAutomationsNow({ dry: false })
		assert.equal(again.created.length, 0)
		assert.equal(again.candidates.find(c => c.entity_id === 'switch.study' && c.direction === 'on').reason, 'already_proposed')
	} finally { x.agent.stop() }
})

test('2-2. 루틴 제안 기준: 들쭉날쭉한 조작은 백테스트에서 떨어진다', async () => {
	const store = new Store(join(DATA, 'noisy.db'))
	try {
		const now = Date.parse('2026-11-25T20:00:00+09:00')
		let i = 0
		for (let d = 21; d >= 1; d--) {
			const date = kst(new Date(now - d * DAY)).date
			const wd = kst(new Date(at(date, '12:00'))).wd
			if (wd === '토' || wd === '일') continue
			i++
			// 매일 18:0x에 켜지만 집에 있는 날은 절반뿐(나머지는 밖에 있다가 21시 귀가)
			store.recordEvent({ t: at(date, '08:00'), id: 'person.me', from: 'home', to: 'not_home', origin: 'device' })
			if (i % 2) store.recordEvent({ t: at(date, '17:50'), id: 'person.me', from: 'not_home', to: 'home', origin: 'device' })
			else store.recordEvent({ t: at(date, '21:00'), id: 'person.me', from: 'not_home', to: 'home', origin: 'device' })
			if (i % 2) store.recordEvent({ t: at(date, '18:05'), id: 'switch.study', name: '서재', from: 'off', to: 'on', origin: 'device' })
			if (i % 2) store.recordEvent({ t: at(date, '23:00'), id: 'switch.study', name: '서재', from: 'on', to: 'off', origin: 'device' })
		}
		const states = new Map(['person.me', 'switch.study'].map(id => [id, st(id, 'off')]))
		const zha = { platformOf: new Map([['switch.study', 'zha']]) }
		const r = await suggestAutomations({ store, states, meta: zha, now, dry: true, options: { min_consistency: 40, min_days: 4 } })
		const on = r.candidates.find(c => c.entity_id === 'switch.study' && c.direction === 'on')
		// 켠 날은 모두 집에 있던 날이라 정확도는 높지만, 시각 트리거는 집에 있는 날마다 맞고 귀가 트리거도 맞는다 → 통과해야 정상
		assert.equal(on?.status, 'eligible')
		// 반대로 집에 있는 날의 절반만 켜는 기기는, 자동화가 켜지 않았으면 할 날에도 켜게 되어 정확도 미달로 떨어진다
		const store2 = new Store(join(DATA, 'noisy2.db'))
		try {
			let j = 0
			for (let d = 21; d >= 1; d--) {
				const date = kst(new Date(now - d * DAY)).date
				const wd = kst(new Date(at(date, '12:00'))).wd
				if (wd === '토' || wd === '일') continue
				j++
				if (j % 2 === 0) {
					store2.recordEvent({ t: at(date, '18:05'), id: 'switch.study', name: '서재', from: 'off', to: 'on', origin: 'device' })
					store2.recordEvent({ t: at(date, '23:00'), id: 'switch.study', name: '서재', from: 'on', to: 'off', origin: 'device' })
				}
			}
			const r2 = await suggestAutomations({ store: store2, states: new Map([['switch.study', st('switch.study', 'off')]]), meta: zha, now, dry: true, options: { min_consistency: 40 } })
			const c2 = r2.candidates.find(c => c.entity_id === 'switch.study' && c.direction === 'on')
			assert.equal(c2.status, 'skipped')
			assert.equal(c2.reason, 'backtest_failed', '켜지 않은 날에도 실행됐을 것이라 정확도 미달')
		} finally { store2.close() }
	} finally { store.close() }
})

test('2-3. 주간 보고서의 YAML 자동화 초안 → proposals로 한 번 더 묻고 승인 대기에 올린다 + 지표 절 자동 추가', async () => {
	const report = '# 주간 분석 2026-11-25\n\n## 한눈에\n- 평일 저녁 서재 조명\n\n## 새 자동화 제안\n1. 귀가 시 서재 켜기\n```yaml\nalias: 귀가 시 서재 켜기\ntriggers:\n  - trigger: state\n```\n\n## 손댈 필요 없음\n- 없음'
	assert.equal(reportHasAutomationDraft(report), true)
	assert.equal(reportHasAutomationDraft('# 주간\n## 새 자동화 제안\n아직 없어요.\n## 손댈 필요 없음'), false)
	const config = { alias: '귀가 시 서재 켜기', triggers: [{ trigger: 'state', entity_id: 'person.me', to: 'home' }], conditions: [], actions: [{ action: 'switch.turn_on', target: { entity_id: 'switch.study' } }] }
	let round = 0
	const x = setup({
		brain: async () => {
			round++
			const proposals = round === 1 ? [] : [{ kind: 'automation_upsert', target_id: '', title: '귀가 시 서재 켜기', summary: '평일 귀가 후 서재 조명', payload_json: JSON.stringify({ config }) }]
			return { result: answer({ summary: '주간 분석', report, proposals }), ms: 1, tokens: 10 }
		},
	})
	try {
		const entry = await x.agent.cycle([{ type: 'weekly', at: x.t.now }])
		assert.equal(entry.error, undefined, entry.error)
		assert.equal(round, 2)
		assert.equal(entry.weekly_drafts_repaired, true)
		assert.match(x.t.prompts[1], /주간 보고서의 새 자동화 제안/)
		assert.equal(x.agent.haAdmin.listProposals({ status: 'pending' }).filter(p => p.kind === 'automation_upsert').length, 1)
		const saved = readFileSync(join(P.weekly, `${kst(new Date(x.t.now)).date}.md`), 'utf8')
		assert.match(saved, /## 자기 성능 지표 \(자동 집계\)/)
	} finally { x.agent.stop() }
})

test('3-1. 실험 후속 조치: 악화된 규칙은 이전 판으로·새 규칙은 삭제, 제안은 롤백 버튼, 약한 교훈은 끔, 개선된 규칙은 검증 표시', async () => {
	const ruleOf = (id, value, desc) => ({ id, description: desc, entity_id: 'sensor.bath_humidity', attribute: null, op: 'gt', value, for_minutes: 0, cooldown_minutes: 60, priority: 'normal', also: [], hour_from: null, hour_to: null })
	const x = setup({ rules: [ruleOf('r_changed', 70, '습도 70 넘음(바꾼 판)'), ruleOf('r_new', 90, '새 규칙'), ruleOf('r_good', 85, '좋아진 규칙')] })
	try {
		const s = x.agent.store
		const mark = (exp, status) => s.upsertExperiment({ ...exp, status, verdict: status, evaluated_at: x.t.now, notes: '대상 범위 부정 신호 0→4 (악화 감지: 롤백 또는 재조정 검토 권장)' })
		mark(registerExperiment(s, { kind: 'rule', ref_id: 'r_changed', title: '규칙 수정', now: T0 - 8 * DAY, revert: { prev_rule: ruleOf('r_changed', 80, '습도 80 넘음(이전 판)'), new_rule: ruleOf('r_changed', 70, '습도 70 넘음(바꾼 판)') } }), 'regressed')
		mark(registerExperiment(s, { kind: 'rule', ref_id: 'r_new', title: '규칙 추가', now: T0 - 8 * DAY, revert: { prev_rule: null, new_rule: ruleOf('r_new', 90, '새 규칙') } }), 'regressed')
		mark(registerExperiment(s, { kind: 'rule', ref_id: 'r_good', title: '규칙 수정', now: T0 - 8 * DAY }), 'improved')
		s.upsertProposal({ pid: 'papplied', ts: T0 - 8 * DAY, kind: 'automation_upsert', title: '거실 자동화', summary: 's', target_id: 'automation.x', payload: { config_id: 'x', config: {} }, status: 'applied', applied_at: T0 - 8 * DAY })
		mark(registerExperiment(s, { kind: 'proposal:automation_upsert', ref_id: 'papplied', title: '거실 자동화', now: T0 - 8 * DAY }), 'regressed')
		s.upsertLesson({ key: 'weak', scope: 'assist', condition_text: 'c', rule_text: 'r', confidence: 0.3, source: 'user_approved', now: T0 })
		mark(registerExperiment(s, { kind: 'lesson', ref_id: 'weak', title: '교훈', now: T0 - 8 * DAY }), 'regressed')

		const done = await x.agent.applyExperimentVerdicts(x.t.now)
		assert.equal(done.length, 5)
		const rules = readJson(P.rules, {}).rules
		assert.equal(rules.find(r => r.id === 'r_changed').value, 80, '이전 판으로 원복')
		assert.equal(rules.some(r => r.id === 'r_new'), false, '새로 만든 규칙은 삭제')
		assert.ok(x.agent.runtime.rules.r_good.validated_at, '개선된 규칙에 검증 표시')
		assert.ok(x.ha.sent.some(n => (n.data?.actions ?? []).some(a => a.action === 'HAAGENT_ROLL_papplied')), '롤백 버튼과 함께 묻기')
		assert.ok(x.ha.sent.some(n => /감시 규칙을 되돌렸어요/.test(n.title)))
		assert.equal(Boolean(s.getLesson('weak')?.active), false, '약해진 교훈은 끔')
		assert.equal((await x.agent.applyExperimentVerdicts(x.t.now)).length, 0, '한 번만 조치')
	} finally { x.agent.stop() }
})

test('3-2. 별칭 회귀 평가 게이트: 다른 기기와 겹치는 별칭은 막고, 안전한 별칭은 평가 결과와 함께 올린다', async () => {
	const x = setup()
	try {
		const { policy, states, meta, cfg } = x.agent
		const bad = checkAliasChange({ policy, states, meta, cfg, entityId: 'switch.b', alias: '거실 불' })
		assert.equal(bad.ok, false)
		assert.ok(bad.errors.some(e => /거실 불/.test(e)))
		const good = checkAliasChange({ policy, states, meta, cfg, entityId: 'switch.b', alias: '작업등' })
		assert.equal(good.ok, true, good.errors.join())
		const reg = runFastPathRegression({ index: directoryIndexFor({ policy, states, meta, cfg }), cases: fastPathCases() })
		assert.equal(reg.failed.length, 0, JSON.stringify(reg.failed))
		assert.ok(reg.total >= 10)

		const rejected = await x.agent.haAdmin.createProposal({ kind: 'self_alias_proposal', target_id: 'switch.b', title: '별칭', summary: 's', payload: { entity_id: 'switch.b', alias: '거실 불' } }, x.t.now)
		assert.equal(rejected.ok, false)
		assert.match(rejected.error, /빠른 경로 회귀 평가 실패/)
		const okP = await x.agent.haAdmin.createProposal({ kind: 'self_alias_proposal', target_id: 'switch.b', title: '별칭', summary: 's', payload: { entity_id: 'switch.b', alias: '작업등' } }, x.t.now)
		assert.equal(okP.ok, true, okP.error)
		assert.match(okP.proposal.validation.summary_text, /빠른 경로 회귀 평가 \d+\/\d+ 통과/)
	} finally { x.agent.stop() }
})

test('4. 자기 성능 지표: 주 단위 알림 조치율·제안 수락률·Assist 성공률·빈 판단·토큰과 전주 대비 추세', () => {
	const s = new Store(join(DATA, 'score.db'))
	try {
		const now = T0
		const w1 = now - 3 * DAY, w2 = now - 10 * DAY
		// 지난주: 판단 4회(빈 판단 1), 알림 2건 중 1건 조치, 제안 2건(수락 1·거절 1), Assist 4턴 중 부정 1
		for (const [i, applied] of [[0, { notifications: ['x'] }], [1, { actions: ['a'] }], [2, {}], [3, { notifications: ['y'] }]]) s.recordDecision({ ts: w1 + i * 1000, reasons: ['hourly'], tokens: 1000, applied })
		// Assist: 요청마다 최종 결과(outcome)가 하나 남는다. 4건 중 1건은 사용자가 바로 다시 말해 실패(재요청과 정정이 한 말에서 함께 잡혀도 한 번만), 1건은 모델 전환
		for (let i = 0; i < 4; i++) s.recordDecision({ ts: w1 + 10000 + i, reasons: ['assist'], tokens: 10, applied: { outcome: 'ok', fell_back: i === 3 } })
		s.recordImplicitFeedback({ ts: w1 + 10002, kind: 'assist_retry', score: -0.5 })
		s.recordImplicitFeedback({ ts: w1 + 10002, kind: 'assist_correction', score: -1 })
		// 최종 결과가 없는 예전 기록은 세지 않는다
		s.recordDecision({ ts: w1 + 20000, reasons: ['assist'], tokens: 10, applied: {} })
		s.upsertNotification({ nid: 'n1', ts: w1, kind: 'alert', level: 'normal', title: 'a', message: 'm', status: 'sent', related_rule_ids: [] })
		s.upsertNotification({ nid: 'n2', ts: w1 + 1, kind: 'alert', level: 'normal', title: 'b', message: 'm', status: 'sent', related_rule_ids: [] })
		s.recordImplicitFeedback({ ts: w1 + 100, kind: 'notification_acted', score: 1 })
		s.upsertProposal({ pid: 'pa', ts: w1, kind: 'backup_create', title: 't', summary: 's', status: 'applied' })
		s.upsertProposal({ pid: 'pr', ts: w1, kind: 'backup_create', title: 't', summary: 's', status: 'rejected' })
		// 그 전 주: 판단 2회 모두 빈 판단, 토큰 더 많음, 자동화 뒤집힘 2회
		for (let i = 0; i < 2; i++) s.recordDecision({ ts: w2 + i, reasons: ['hourly'], tokens: 3000, applied: {} })
		s.recordImplicitFeedback({ ts: w2, kind: 'automation_overridden', score: -1 })
		s.recordImplicitFeedback({ ts: w2 + 1, kind: 'automation_overridden', score: -1 })

		const sc = buildScorecard({ store: s, now, regression: { passed: 12, total: 12, failed: [] } })
		const w = sc.weeks[0]
		assert.equal(w.cycles, 4)
		assert.equal(w.noop_pct, 25)
		assert.equal(w.avg_tokens, 1000)
		assert.equal(w.alert_useful_pct, 50)
		assert.equal(w.proposal_accept_pct, 50)
		assert.equal(w.assist_success_pct, 75)
		assert.equal(w.assist_retry_pct, 25, '같은 말에서 잡힌 재요청·정정은 앞 요청 하나에만 매김')
		assert.equal(w.assist_fallback_pct, 25)
		assert.equal(w.assist_requests, 4)
		assert.equal(w.assist_legacy_turns, 1)
		const trend = Object.fromEntries(sc.trends.map(t => [t.key, t.better]))
		assert.equal(trend.noop_pct, true, '100% → 25%')
		assert.equal(trend.avg_tokens, true)
		assert.equal(trend.automation_overrides, true, '2 → 0')
		assert.equal(trend.alert_useful_pct, null, '전주 표본 없음 → 판단 보류')
		const text = renderScorecard(sc)
		assert.match(text, /\| 알림 뒤 조치 비율\(%\) \| 50 \| – \| – \|/)
		assert.match(text, /빈 판단 비율\(%\) \| 25 \| 100 \| ▲ 좋아짐/)
		assert.match(text, /회귀 평가: 12\/12 통과/)
		assert.match(text, /Assist 지표는 요청마다 최종 결과를 남기기 시작한 뒤의 기록만/)
	} finally { s.close() }
})

test('5-1. 기기 건강: 응답 없음·배터리·신호·방 미지정을 찾고, 새로 생긴 문제만 한 번 알린다', async () => {
	const states = [
		...baseStates(),
		st('switch.offline', 'unavailable', T0 - 8 * 3600000),
		st('switch.blip', 'unavailable', T0 - 10 * MIN),
		st('sensor.door_battery', '12', T0, { device_class: 'battery', unit_of_measurement: '%' }),
		st('sensor.plug_lqi', '18', T0),
		st('sensor.cam_rssi', '-90', T0, { device_class: 'signal_strength', unit_of_measurement: 'dBm' }),
	]
	const report = scanDeviceHealth({ states: new Map(states.map(s => [s.entity_id, s])), meta: { areaOf: new Map([['switch.study', '서재']]) }, now: T0 })
	assert.deepEqual(report.unavailable.map(u => u.entity_id), ['switch.offline'], '잠깐 끊긴 것은 빼고 6시간 넘은 것만')
	assert.deepEqual(report.low_battery.map(b => [b.entity_id, b.level]), [['sensor.door_battery', 12]])
	assert.deepEqual(report.weak_signal.map(w => w.kind).sort(), ['LQI', 'RSSI'])
	assert.ok(report.no_area.some(n => n.entity_id === 'switch.b') && !report.no_area.some(n => n.entity_id === 'switch.study'))
	assert.equal(newHealthIssues(report, healthIssueKeys(report)).length, 0)

	const x = setup({ states })
	try {
		const r1 = await x.agent.checkDeviceHealth(x.t.now)
		assert.equal(r1.notified, 4)
		assert.ok(x.ha.sent.some(n => n.title === '🔧 기기 점검이 필요해요' && /배터리 부족 12%: sensor.door_battery/.test(n.message)))
		const r2 = await x.agent.checkDeviceHealth(x.t.now + 3600000)
		assert.equal(r2.notified, 0, '같은 문제는 다시 알리지 않음')
		// 잠깐 끊겼던 기기도 6시간을 넘기면 새 문제로 한 번 알린다
		const r3 = await x.agent.checkDeviceHealth(x.t.now + DAY)
		assert.equal(r3.notified, 1)
		assert.ok(x.ha.sent.some(n => /응답 없음 \d+시간째: switch.blip/.test(n.message)))
		const audit = await x.agent.haAdmin.auditHealth()
		assert.equal(audit.device_health.low_battery.length, 1)
	} finally { x.agent.stop() }
})

test('5-2. 씬·헬퍼 관리 제안: 검증(Tier 3·없는 엔티티), 승인 적용, 롤백, 쓰기 가드', async () => {
	const x = setup()
	try {
		const adm = x.agent.haAdmin
		// 씬
		const badScene = await adm.createProposal({ kind: 'scene_upsert', target_id: '', title: '씬', summary: 's', payload: { config: { name: '위험', entities: { 'switch.danger_heater': 'on', 'light.nope': 'on' } } } }, x.t.now)
		assert.equal(badScene.ok, false)
		assert.match(badScene.error, /Tier 3/)
		assert.match(badScene.error, /존재하지 않는 엔티티: light.nope/)
		const scene = await adm.createProposal({ kind: 'scene_upsert', target_id: '', title: '영화 보기', summary: '조명 끄기', payload: { config: { name: '영화 보기', entities: { 'light.a': 'off', 'switch.study': { state: 'off' } } } } }, x.t.now)
		assert.equal(scene.ok, true, scene.error)
		assert.equal((await adm.approveProposal(scene.proposal.pid, x.t.now)).ok, true)
		const sceneId = scene.proposal.payload.config_id
		assert.equal(x.ha.rest.get(`scene:${sceneId}`).name, '영화 보기')
		assert.ok(x.ha.serviceCalls.includes('scene.reload'))
		assert.equal((await adm.rollbackProposal(scene.proposal.pid, x.t.now)).ok, true)
		assert.equal(x.ha.rest.has(`scene:${sceneId}`), false, '새로 만든 씬은 롤백하면 지움')

		// 헬퍼: 승인 없이는 쓸 수 없다
		assert.match(checkMessage({ type: 'input_boolean/create', name: 'x' }, x.ha.guard), /승인된 관리 제안 밖/)
		assert.match(checkMessage({ type: 'input_boolean/delete', input_boolean_id: 'kona_start' }, { ...x.ha.guard, allowConfigWrite: true }), /Tier 3/)
		const tier3 = await adm.createProposal({ kind: 'helper_upsert', target_id: 'input_boolean.kona_start', title: 'x', summary: 's', payload: { domain: 'input_boolean', id: 'kona_start', config: { name: '코나' } } }, x.t.now)
		assert.match(tier3.error, /Tier 3/)
		const create = await adm.createProposal({ kind: 'helper_upsert', target_id: '', title: '손님 모드 헬퍼', summary: 's', payload: { domain: 'input_boolean', config: { name: '손님 모드', icon: 'mdi:account', bogus: 1 } } }, x.t.now)
		assert.equal(create.ok, true, create.error)
		assert.deepEqual(create.proposal.payload.config, { name: '손님 모드', icon: 'mdi:account' }, '허용 키만')
		const ap = await adm.approveProposal(create.proposal.pid, x.t.now)
		assert.equal(ap.ok, true, ap.error)
		assert.equal(ap.proposal.payload.created_id, '손님_모드')
		assert.equal(x.ha.helpers.input_boolean.length, 1)
		assert.equal(x.ha.guard.allowConfigWrite, false, '적용 뒤 쓰기 가드 복원')
		// 고치기 → 롤백하면 이전 이름
		const upd = await adm.createProposal({ kind: 'helper_upsert', target_id: 'input_boolean.손님_모드', title: '이름 변경', summary: 's', payload: { domain: 'input_boolean', id: '손님_모드', config: { name: '방문객 모드' } } }, x.t.now)
		assert.equal(upd.ok, true, upd.error)
		await adm.approveProposal(upd.proposal.pid, x.t.now)
		assert.equal(x.ha.helpers.input_boolean[0].name, '방문객 모드')
		await adm.rollbackProposal(upd.proposal.pid, x.t.now)
		assert.equal(x.ha.helpers.input_boolean[0].name, '손님 모드')
		// 만든 것 롤백 → 지움, 지운 것 롤백 → 다시 만듦
		await adm.rollbackProposal(create.proposal.pid, x.t.now)
		assert.equal(x.ha.helpers.input_boolean.length, 0)
		x.ha.helpers.input_boolean.push({ id: 'old_flag', name: '옛 플래그' })
		const del = await adm.createProposal({ kind: 'helper_delete', target_id: 'input_boolean.old_flag', title: '지우기', summary: 's', payload: { domain: 'input_boolean', id: 'old_flag' } }, x.t.now)
		assert.equal(del.ok, true, del.error)
		await adm.approveProposal(del.proposal.pid, x.t.now)
		assert.equal(x.ha.helpers.input_boolean.length, 0)
		await adm.rollbackProposal(del.proposal.pid, x.t.now)
		assert.deepEqual(x.ha.helpers.input_boolean.map(h => h.name), ['옛 플래그'])
	} finally { x.agent.stop() }
})

test('통합: 하루 자가개선 작업, 웹 API(지표·회귀·건강·루틴 제안), 콘솔 스크립트 구문', async () => {
	const x = setup()
	try {
		x.t.now = Date.parse('2026-11-25T19:00:00+09:00')
		seedRoutineData(x.agent.store, x.ha, x.t.now)
		x.ha.autoCfg = { 'automation.morning': { id: 'covered', alias: '커버 자동', triggers: [], actions: [{ action: 'switch.turn_on', target: { entity_id: 'switch.covered' } }] } }
		const out = await x.agent.runDailyLearning(x.t.now)
		assert.ok(out.regression.total > 0)
		assert.equal(out.regression.passed, out.regression.total)
		assert.equal(out.suggest.created.length, 2)
		assert.equal(x.agent.runtime.last_regression.total, out.regression.total)
		assert.equal(await x.agent.runDailyLearning(x.t.now).then(r => r.suggest.created.length), 0, '두 번 올리지 않음')

		const srv = new AssistServer({ cfg: mergeConfig({ assist: { enabled: true, host: '127.0.0.1', port: 0, allowed_networks: ['127.0.0.0/8'] } }), agent: x.agent, token: 't' })
		const port = await srv.start()
		try {
			const get = async p => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: 'Bearer t' } }); return [r.status, await r.json()] }
			const [s1, sc] = await get('/api/scorecard')
			assert.equal(s1, 200)
			assert.match(sc.text, /\| 지표 \|/)
			const [s2, reg] = await get('/api/regression')
			assert.equal(s2, 200)
			assert.equal(reg.failed.length, 0)
			const [s3, health] = await get('/api/health')
			assert.equal(s3, 200)
			assert.ok(Array.isArray(health.no_area))
			const [s4, sug] = await get('/api/automation-suggestions')
			assert.equal(s4, 200)
			assert.ok(sug.candidates.some(c => c.reason === 'already_proposed'))
			const [s5, learn] = await get('/api/learning')
			assert.equal(s5, 200)
			assert.ok(learn.scorecard?.trends?.length)
			// 콘솔이 내려보내는 스크립트가 문법 오류 없이 읽힌다
			const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
			const js = /<script>([\s\S]*?)<\/script>/.exec(html)[1]
			assert.doesNotThrow(() => new Function(js))
			assert.ok(html.includes('findAutomations()') && html.includes("'helper_upsert'"))
		} finally { await srv.stop() }
	} finally { x.agent.stop() }
})
