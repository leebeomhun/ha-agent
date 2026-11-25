// Phase 2 & Phase 3 테스트: MemoryManager, SessionManager, HaAdmin(검증·Diff·자동롤백·승격·감사), LlmRouter, AssistServer, Agent 통합
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'haagent-p23-'))
process.env.HAAGENT_DATA_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

const { mergeConfig, saveControl } = await import('../src/config.mjs')
const { P, writeJson } = await import('../src/util.mjs')
const { Store } = await import('../src/core/store.mjs')
const { MemoryManager } = await import('../src/core/memory.mjs')
const { SessionManager } = await import('../src/orchestrator/session.mjs')
const { HaAdmin, unifiedDiff } = await import('../src/admin/ha-admin.mjs')
const { LlmRouter } = await import('../src/llm/router.mjs')
const { runAnthropic } = await import('../src/llm/providers/anthropic.mjs')
const { runGemini } = await import('../src/llm/providers/gemini.mjs')
const { runOllama } = await import('../src/llm/providers/ollama.mjs')
const { AssistServer } = await import('../src/channels/assist-server.mjs')
const { Agent } = await import('../src/agent.mjs')

const T0 = Date.parse('2026-11-20T12:00:00+09:00')
const st = (entity_id, state, attrs = {}) => ({
	entity_id, state, attributes: { friendly_name: entity_id, ...attrs },
	last_changed: new Date(T0).toISOString(), last_updated: new Date(T0).toISOString(),
})

test('MemoryManager & SessionManager: 계층 기억 + 멀티턴 슬라이딩 윈도우', () => {
	const dir = mkdtempSync(join(TMP, 'mem-'))
	const store = new Store(join(dir, 'm.db'))
	const prof = join(dir, 'home-profile.md')
	const leg = join(dir, 'memory.md')
	writeFileSync(prof, '- 시간대: KST\n')
	writeFileSync(leg, '- 기본 메모\n')
	try {
		const mm = new MemoryManager({ store, memoryPath: leg, profilePath: prof })
		assert.match(mm.loadHomeProfile(), /KST/)
		const res = mm.applyOps([
			{ op: 'upsert', category: 'preference', key: 'quiet_fan', content: '밤에는 환풍기 약하게' },
			{ op: 'upsert', category: 'standing_order', key: 'no_living_off', content: '손님 오면 거실 불 끄지 마' },
		], { now: T0 })
		assert.deepEqual(res.upserted, ['quiet_fan', 'no_living_off'])
		assert.equal(mm.search('환풍기').length, 1)
		const promptMem = mm.renderForPrompt(6000)
		assert.match(promptMem, /기본 메모/)
		assert.match(promptMem, /구조화 장기 기억/)
		assert.match(promptMem, /quiet_fan/)
		mm.applyOps([{ op: 'delete', key: 'quiet_fan' }], { now: T0 })
		assert.equal(mm.search('환풍기').length, 0)

		const sm = new SessionManager({ store, maxTurns: 2, timeoutMs: 60000 })
		const sid = sm.ensure('s1', { channel: 'ha_assist', now: T0 })
		sm.append(sid, 'user', '첫 질문', null, T0 - 120000) // 만료
		sm.append(sid, 'user', '최근 질문', null, T0 - 1000)
		sm.append(sid, 'assistant', '최근 답', null, T0)
		assert.deepEqual(sm.history(sid, T0).map(m => m.text), ['최근 질문', '최근 답'])
	} finally { store.close() }
})

test('HaAdmin: 검증·Diff·승인·check_config 실패 자동 롤백·수동 롤백·규칙 승격·건강 감사', async () => {
	const dir = mkdtempSync(join(TMP, 'adm-'))
	const store = new Store(join(dir, 'adm.db'))
	const mm = new MemoryManager({ store, memoryPath: join(dir, 'm.md'), profilePath: join(dir, 'p.md') })
	try {
		const saved = new Map([['automation:old_1', { id: 'old_1', alias: '기존', triggers: [{ trigger: 'state', entity_id: 'light.a' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] }]])
		let checkResult = { result: 'valid', errors: null }
		let checkCalls = 0
		let promotedRemoved = null
		const calls = []
		const ha = {
			connected: true,
			guard: { allowConfigWrite: false },
			async getConfigRest(dom, id) { const v = saved.get(`${dom}:${id}`); if (!v) throw new Error('404'); return v },
			async saveConfigRest(dom, id, cfg) { assert.equal(this.guard.allowConfigWrite, true); saved.set(`${dom}:${id}`, cfg) },
			async deleteConfigRest(dom, id) { assert.equal(this.guard.allowConfigWrite, true); saved.delete(`${dom}:${id}`) },
			async callService(d, s, opts) { calls.push(`${d}.${s}`); if (d === 'homeassistant' && s === 'list_orphaned_database_entities') return { response: { entities: ['sensor.orphan_1'] } } },
			async checkConfig() { checkCalls++; return typeof checkResult === 'function' ? checkResult() : checkResult },
			async renderTemplate(tpl) { if (tpl.includes('bad_syntax')) throw new Error('TemplateSyntaxError'); return 'ok' },
			async configEntries() { return [{ entry_id: 'e1', domain: 'hue', title: 'Hue', state: 'setup_retry', reason: 'timeout' }] },
			async traces() { return [{ item_id: 'old_1', run_id: 'r1', last_step: 'action/0', script_execution: 'error', error: 'boom', timestamp: { start: '2026-11-20T01:00:00Z' } }] },
			async backupInfo() { return { state: 'idle', last_completed_automatic_backup: '2026-11-19', backups: [{ id: 'b1' }] } },
		}
		const states = new Map([
			['light.a', st('light.a', 'on')],
			['binary_sensor.door', st('binary_sensor.door', 'off')],
			['update.core', st('update.core', 'on', { friendly_name: 'Core', installed_version: '1.0', latest_version: '1.1' })],
		])
		const meta = {
			autoCfg: {
				'automation.old_1': saved.get('automation:old_1'),
				'automation.broken_1': { id: 'broken_1', alias: '깨짐', triggers: [{ trigger: 'state', entity_id: 'sensor.missing_xyz' }], actions: [] },
			},
		}
		const cfg = mergeConfig({ policy: { admin_enabled: true } })
		const adm = new HaAdmin({ cfg, ha, store, states, meta, memory: mm, onRulePromoted: async id => { promotedRemoved = id } })

		// 1) 없는 엔티티 또는 템플릿 오류 검증 실패 시 생성 단계에서 거절하고 pending에 쌓지 않음
		const badProp = await adm.createProposal({
			kind: 'automation_upsert', target_id: 'automation.old_1', title: '잘못된 수정', summary: '테스트',
			payload: { config: { alias: 'x', triggers: [{ trigger: 'state', entity_id: 'sensor.none' }], actions: [{ action: 'notify.x', data: { message: '{{ bad_syntax }}' } }] } },
		}, T0)
		assert.equal(badProp.ok, false)
		assert.equal(badProp.validation.valid, false)
		assert.equal(adm.listProposals({ status: 'pending' }).length, 0)
		// 방어적 검증: DB에 validation.valid=false 제안이 남아 있어도 approveProposal이 거부
		store.upsertProposal({ pid: 'pbad1', ts: T0, kind: 'automation_upsert', title: '잘못된 제안', summary: 's', target_id: 'automation.old_1', payload: {}, validation: { valid: false, errors: ['테스트'] }, status: 'pending', expires: T0 + 3600000 })
		const badApprove = await adm.approveProposal('pbad1', T0)
		assert.equal(badApprove.ok, false)
		store.db.prepare('DELETE FROM proposals WHERE pid = ?').run('pbad1')

		// 2) check_config 실패 시 pre_snapshot으로 자동 롤백. 깨진 설정이 들어가 있는 동안만 invalid(되돌리면 다시 valid)
		checkResult = () => (saved.get('automation:old_1')?.alias === '수정됨' ? { result: 'invalid', errors: 'bad yaml' } : { result: 'valid', errors: null })
		const failProp = await adm.createProposal({
			kind: 'automation_upsert', target_id: 'automation.old_1', title: '수정 후 실패', summary: '테스트',
			payload: { config: { alias: '수정됨', triggers: [{ trigger: 'state', entity_id: 'light.a' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] } },
		}, T0)
		assert.match(unifiedDiff('a\nb', 'a\nc'), /\+ c/)
		assert.match(failProp.proposal.diff_text, /\+.*"alias": "수정됨"/)
		const checksBefore = checkCalls
		const failApprove = await adm.approveProposal(failProp.proposal.pid, T0)
		assert.equal(failApprove.ok, false)
		assert.equal(failApprove.proposal.status, 'rolled_back')
		assert.equal(checkCalls - checksBefore, 2, '적용 직후 + 되돌린 뒤 다시 check_config')
		assert.equal(saved.get('automation:old_1').alias, '기존', 'pre_snapshot으로 자동 롤백됨')
		assert.equal(ha.guard.allowConfigWrite, false, '작업 종료 후 쓰기 플래그 해제')

		// 3) 정상 승인 + 수동 롤백
		checkResult = { result: 'valid', errors: null }
		const goodProp = await adm.createProposal({
			kind: 'automation_upsert', target_id: 'automation.old_1', title: '정상 수정', summary: '알림 개선',
			payload: { config: { alias: '개선됨', triggers: [{ trigger: 'state', entity_id: 'light.a' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] } },
		}, T0)
		const okApprove = await adm.approveProposal(goodProp.proposal.pid, T0)
		assert.equal(okApprove.ok, true)
		assert.equal(saved.get('automation:old_1').alias, '개선됨')
		const rb = await adm.rollbackProposal(goodProp.proposal.pid, T0 + 1000)
		assert.equal(rb.ok, true)
		assert.equal(saved.get('automation:old_1').alias, '기존')

		// 4) 거절 시 rejection 메모리 기록
		const rejProp = await adm.createProposal({ kind: 'backup_create', target_id: 'ha', title: '백업 실행', summary: '백업' }, T0)
		adm.rejectProposal(rejProp.proposal.pid, T0, '지금 안 함')
		assert.equal(mm.list('rejection').length, 1)

		// 5) 규칙 -> HA 자동화 승격
		const prom = await adm.createProposal({
			kind: 'promote_rule', target_id: 'door_open', title: '문 열림 자동화 승격', summary: '규칙 승격',
			payload: { rule: { id: 'door_open', description: '문 10분 열림', entity_id: 'binary_sensor.door', op: 'eq', value: 'on', for_minutes: 10, also: [] } },
		}, T0)
		const promRes = await adm.approveProposal(prom.proposal.pid, T0)
		assert.equal(promRes.ok, true)
		assert.equal(promotedRemoved, 'door_open')
		assert.ok(saved.has('automation:haagent_door_open'))

		// 6) 건강 감사
		const health = await adm.auditHealth()
		assert.equal(health.broken_automation_refs[0].missing_entities[0], 'sensor.missing_xyz')
		assert.equal(health.integration_errors[0].domain, 'hue')
		assert.equal(health.recent_trace_errors[0].run_id, 'r1')
		assert.equal(health.pending_updates[0].id, 'update.core')
		assert.equal(health.orphaned_entities[0], 'sensor.orphan_1')
	} finally { store.close() }
})

test('LlmRouter & 다중 프로바이더(Anthropic / Gemini / Ollama) 어댑터', async () => {
	const cfg = mergeConfig({
		brain: 'codex',
		llm: {
			routes: { assist: 'anthropic', summary: 'ollama' },
			anthropic: { key_env: 'TEST_ANTHROPIC_KEY', model: 'claude-test' },
			gemini: { key_env: 'TEST_GEMINI_KEY', model: 'gemini-test' },
			ollama: { base_url: 'http://127.0.0.1:11434', model: 'qwen-test' },
		},
	})
	const prevA = process.env.TEST_ANTHROPIC_KEY
	const prevG = process.env.TEST_GEMINI_KEY
	process.env.TEST_ANTHROPIC_KEY = 'ant-key'
	process.env.TEST_GEMINI_KEY = 'gem-key'
	try {
		const router = new LlmRouter({ cfg, canUse: (_c, m) => m === 'codex' })
		assert.equal(router.resolveMode({ task: 'assist' }), 'anthropic')
		assert.equal(router.resolveMode({ task: 'hourly' }), 'codex')

		const broker = { tools: () => [{ name: 'ping', description: 'p', parameters: { type: 'object', properties: {}, required: [] } }], run: async () => 'pong' }
		let aCalls = 0
		const aRes = await runAnthropic({
			cfg, prompt: '안녕', toolBroker: broker, customSchema: { type: 'object' },
			fetchFn: async () => ({
				ok: true, status: 200,
				text: async () => JSON.stringify(++aCalls === 1
					? { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'tu1', name: 'ping', input: {} }] }
					: { usage: { input_tokens: 12, output_tokens: 8 }, content: [{ type: 'text', text: '{"speech":"네, 확인했어요.","continue_conversation":false}' }] }),
			}),
		})
		assert.equal(aRes.result.speech, '네, 확인했어요.')
		assert.equal(aRes.tool_calls, 1)

		let gCalls = 0
		const gRes = await runGemini({
			cfg, prompt: '안녕', toolBroker: broker, customSchema: { type: 'object' },
			fetchFn: async () => ({
				ok: true, status: 200,
				text: async () => JSON.stringify(++gCalls === 1
					? { usage: { total_tokens: 20 }, steps: [{ type: 'function_call', id: 'fc_1', name: 'ping', arguments: {} }] }
					: { usage: { total_tokens: 30 }, steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"speech":"제미니 응답","continue_conversation":true}' }] }] }),
			}),
		})
		assert.equal(gRes.result.speech, '제미니 응답')
		assert.equal(gRes.tokens, 50)

		const oRes = await runOllama({
			cfg, prompt: '안녕', customSchema: { type: 'object' },
			fetchFn: async () => ({
				ok: true, status: 200,
				text: async () => JSON.stringify({ prompt_eval_count: 5, eval_count: 10, message: { content: '{"speech":"로컬 응답","continue_conversation":false}' } }),
			}),
		})
		assert.equal(oRes.result.speech, '로컬 응답')
		assert.equal(oRes.tokens, 15)
	} finally {
		if (prevA === undefined) delete process.env.TEST_ANTHROPIC_KEY; else process.env.TEST_ANTHROPIC_KEY = prevA
		if (prevG === undefined) delete process.env.TEST_GEMINI_KEY; else process.env.TEST_GEMINI_KEY = prevG
	}
})

test('AssistServer & Agent 통합: 인증, Assist 멀티턴, OpenAI 호환, 웹 콘솔, 제안 버튼(APPR/REJ/ROLL)', async () => {
	rmSync(TMP, { recursive: true, force: true })
	mkdirSync(P.state, { recursive: true })
	saveControl({ paused: false, send: true })
	writeJson(P.rules, { updated: new Date(T0).toISOString(), rules: [] })

	class MockHA extends EventEmitter {
		constructor() {
			super()
			this.connected = true
			this.guard = { allowConfigWrite: false }
			this.sent = []
			this.configs = new Map()
			this.map = new Map([
				['light.hwanpunggi', st('light.hwanpunggi', 'off')],
				['select.gonggi_speed', st('select.gonggi_speed', 'low', { options: ['low', 'turbo'] })],
			])
		}
		start() {}
		stop() {}
		async call(m) {
			if (m.type === 'get_states') return [...this.map.values()]
			if (m.type === 'repairs/list_issues') return { issues: [] }
			if (/registry\/list$|system_log/.test(m.type)) return []
			if (m.type === 'trace/list') return []
			if (m.type === 'config_entries/get') return []
			if (m.type === 'backup/info') return { state: 'idle', backups: [] }
			return []
		}
		async callService(d, s, { data = {}, target } = {}) {
			if (d === 'notify') { this.sent.push(data); return }
			if (d === 'weather' || d === 'calendar') return { response: {} }
			if (d === 'select' && s === 'select_option') {
				this.map.set(target.entity_id, st(target.entity_id, data.option, { options: ['low', 'turbo'] }))
			}
		}
		async checkConfig() { return { result: 'valid', errors: null } }
		async saveConfigRest(d, id, c) { this.configs.set(`${d}:${id}`, c) }
		async deleteConfigRest(d, id) { this.configs.delete(`${d}:${id}`) }
		async getConfigRest(d, id) { return this.configs.get(`${d}:${id}`) }
		async heartbeat() {}
	}

	const ha = new MockHA()
	const cfg = mergeConfig({
		heartbeat: { enabled: false },
		actions: { enabled: true, auto: ['light.hwanpunggi', 'select.gonggi_speed'], confirm: [], verify_seconds: 1 },
		policy: { admin_enabled: true },
		assist: { enabled: true, host: '127.0.0.1', port: 0, token_file: join(TMP, 'assist-token') },
	})
	let turn = 0
	const agent = new Agent({
		cfg, ha, clock: () => T0 + turn * 1000,
		brain: async a => {
			turn++
			if (a.toolBroker) {
				await a.toolBroker.run('ha_control_device', JSON.stringify({ entity_id: 'select.gonggi_speed', service: 'select_option', service_data_json: '{"option":"turbo"}', reason: '공기청정기 속도 터보', requested: true }), a.toolContext)
				return { result: { speech: '공기청정기 속도를 터보로 바꿨어요.', continue_conversation: false }, ms: 1, tokens: 20 }
			}
			return {
				result: {
					summary: '제안 생성',
					notifications: [],
					rule_changes: { upsert: [], delete: [] },
					next_wakes: [],
					memory: { mode: 'keep', text: '' },
					memory_ops: [{ op: 'upsert', category: 'preference', key: 'turbo_pref', content: '터보 선호' }],
					info_requests: [],
					actions: [],
					proposals: [{ kind: 'automation_upsert', target_id: 'automation.new_one', title: '새 자동화 추가', summary: '테스트 자동화', payload_json: JSON.stringify({ config: { alias: '테스트', triggers: [{ trigger: 'state', entity_id: 'light.hwanpunggi' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.hwanpunggi' } }] } }) }],
					report: '',
				},
				ms: 1, tokens: 30,
			}
		},
	})
	agent.attach()
	ha.emit('ready', [...ha.map.values()])
	const port = await agent.assistServer.start()
	const token = agent.assistServer.token
	try {
		// 1) /health 무인증, /api/status 인증 필수, / HTML 응답
		const hRes = await fetch(`http://127.0.0.1:${port}/health`)
		assert.equal((await hRes.json()).ok, true)
		const unauth = await fetch(`http://127.0.0.1:${port}/api/status`)
		assert.equal(unauth.status, 401)
		const htmlRes = await fetch(`http://127.0.0.1:${port}/`)
		assert.match(await htmlRes.text(), /집 비서/)

		// 2) Assist 대화 + 도구 실행 + OpenAI 호환 API
		const cRes = await fetch(`http://127.0.0.1:${port}/api/assist/converse`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ text: '공기청정기 터보로 해줘', conversation_id: 'ha_conv_1' }),
		})
		const cj = await cRes.json()
		assert.equal(cRes.status, 200)
		assert.equal(cj.conversation_id, 'ha_conv_1')
		assert.match(cj.response.speech, /터보/)
		assert.equal(ha.map.get('select.gonggi_speed').state, 'turbo')

		const oaiRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'ha-agent', messages: [{ role: 'user', content: '상태 확인' }] }),
		})
		const oj = await oaiRes.json()
		assert.equal(oaiRes.status, 200)
		assert.ok(oj.choices[0].message.content)

		// 3) cycle에서 proposal + memory_ops 생성 → 모바일 알림 [승인] 버튼 → 롤백 API
		const e = await agent.cycle([{ type: 'manual', reason: '제안 테스트' }])
		assert.equal(e.applied.proposals.length, 1)
		assert.ok(agent.memoryMgr.search('터보').length >= 1)
		const propNote = ha.sent.find(n => n.data?.actions?.some(x => x.action.startsWith('HAAGENT_APPR_')))
		assert.ok(propNote, '제안 승인 버튼 알림이 발송됨')
		const apprAction = propNote.data.actions[0].action
		ha.emit('action', { action: apprAction })
		await new Promise(r => setTimeout(r, 50))
		const pid = apprAction.split('_')[2]
		assert.equal(agent.haAdmin.getProposal(pid).status, 'applied')
		assert.ok(ha.configs.has('automation:new_one'))

		const rbRes = await fetch(`http://127.0.0.1:${port}/api/proposals/${pid}/rollback`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
		})
		assert.equal((await rbRes.json()).ok, true)
		assert.equal(agent.haAdmin.getProposal(pid).status, 'rolled_back')
		assert.equal(ha.configs.has('automation:new_one'), false)
	} finally {
		agent.stop()
	}
})
