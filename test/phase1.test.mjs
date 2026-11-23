// Phase 0 & Phase 1 테스트: Slack OOB, 브리핑 모드, SQLite Store, PolicyEngine(Tier 0~3), ToolBroker, AnomalyEngine
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'haagent-p1-'))
process.env.HAAGENT_DATA_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

const { sendOob, resolveSlackConfig, checkOobSlackConfig } = await import('../src/oob.mjs')
const { mergeConfig, validateConfig } = await import('../src/config.mjs')
const { checkMessage, checkRest } = await import('../src/ha.mjs')
const { PolicyEngine } = await import('../src/core/policy.mjs')
const { Store } = await import('../src/core/store.mjs')
const { ToolBroker } = await import('../src/tools/registry.mjs')
const { AnomalyEngine } = await import('../src/engine/anomaly.mjs')
const { validateResponse } = await import('../src/brain.mjs')
const { Agent } = await import('../src/agent.mjs')

const T0 = Date.parse('2026-11-20T09:00:00+09:00')
const MIN = 60000
const st = (entity_id, state, at = T0, attributes = {}) => ({
	entity_id, state, attributes: { friendly_name: entity_id, ...attributes },
	last_changed: new Date(at).toISOString(), last_updated: new Date(at).toISOString(),
})

test('Slack OOB: env_file 파싱, 성공·API 오류(ok:false) 처리, 시크릿 마스킹', async () => {
	const envPath = join(TMP, 'slack.env')
	writeFileSync(envPath, '# comment\nSLACK_BOT_TOKEN="xoxb-secret-token-123"\nSLACK_CHANNEL_ID=C09044TEST\n')
	const cfg = mergeConfig({ oob: { type: 'slack', env_file: envPath, token_env: 'SLACK_BOT_TOKEN', channel_env: 'SLACK_CHANNEL_ID' } })
	assert.deepEqual(validateConfig(cfg), { errors: [], warnings: [] })
	assert.equal(checkOobSlackConfig(cfg, { env: {} }), null)
	const resolved = resolveSlackConfig(cfg, { env: {} })
	assert.equal(resolved.token, 'xoxb-secret-token-123')
	assert.equal(resolved.channel, 'C09044TEST')

	let captured = null
	const ok = await sendOob(cfg, '제목', '본문', {
		urgent: true,
		env: {},
		fetchFn: async (url, init) => {
			captured = { url, headers: init.headers, body: JSON.parse(init.body) }
			return { ok: true, status: 200, json: async () => ({ ok: true, ts: '1.2' }) }
		},
	})
	assert.equal(ok, true)
	assert.equal(captured.url, 'https://slack.com/api/chat.postMessage')
	assert.equal(captured.headers.authorization, 'Bearer xoxb-secret-token-123')
	assert.equal(captured.body.channel, 'C09044TEST')
	assert.match(captured.body.text, /🚨 제목/)

	await assert.rejects(
		sendOob(cfg, 't', 'm', { env: {}, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'channel_not_found' }) }) }),
		err => /channel_not_found/.test(err.message) && !err.message.includes('xoxb-secret-token-123'),
	)
	assert.ok(validateConfig(mergeConfig({ oob: { type: 'slack' } })).errors.some(e => /slack/.test(e)))
})

test('SQLite Store: 테이블 CRUD, WAL 모드, 레거시 JSONL 이관', () => {
	const dir = mkdtempSync(join(TMP, 'db-'))
	const evFile = join(dir, 'events.jsonl'), actFile = join(dir, 'actions.jsonl'), decFile = join(dir, 'decisions.jsonl')
	writeFileSync(evFile, JSON.stringify({ t: T0, id: 'light.a', name: '불', from: 'off', to: 'on' }) + '\n')
	writeFileSync(actFile, JSON.stringify({ aid: 'a1', ts: new Date(T0).toISOString(), entity_id: 'light.a', action: 'turn_off', status: 'done', reason: 'r', tier: 'auto' }) + '\n')
	writeFileSync(decFile, JSON.stringify({ ts: new Date(T0).toISOString(), reasons: ['hourly'], tokens: 100, summary: 'ok' }) + '\n')

	const store = new Store(join(dir, 'test.db'))
	try {
		store.migrateFromLegacyFiles({ eventsPath: evFile, actionsPath: actFile, decisionsPath: decFile })
		const stats = store.stats()
		assert.equal(stats.events, 1)
		assert.equal(stats.actions, 1)
		assert.equal(stats.decisions, 1)
		store.migrateFromLegacyFiles({ eventsPath: evFile, actionsPath: actFile, decisionsPath: decFile })
		assert.equal(store.stats().events, 1)

		store.upsertMemory({ category: 'preference', key: 'quiet_room', content: '작은방 밤에 끄지 마', now: T0 })
		assert.equal(store.searchMemory('작은방').length, 1)
		store.ensureConversation('conv1', 'ha_assist', null, T0)
		store.appendMessage('conv1', 'user', '거실 불 켜줘', null, T0)
		assert.equal(store.recentMessages('conv1').length, 1)
	} finally {
		store.close()
	}
})

test('PolicyEngine: Tier 0~3, 파라미터 검증, 재실 도우미 차단, 스냅샷 Undo, HA 게이트', () => {
	const cfg = mergeConfig({
		actions: { enabled: true, auto: ['light.hwanpunggi', 'select.fan_speed', 'lock.front'], confirm: ['light.room', 'media_player.tv', 'input_number.kwh'] },
		policy: { admin_enabled: true, away_override_exempt: ['light.hwanpunggi'] },
	})
	const pol = new PolicyEngine(cfg)
	assert.equal(pol.tiersMap().has('lock.front'), false, 'Tier 3는 설정에 넣어도 제외')

	const states = new Map([
		['light.hwanpunggi', st('light.hwanpunggi', 'on')],
		['light.room', st('light.room', 'on', T0, { brightness: 180, color_temp_kelvin: 4000 })],
		['select.fan_speed', st('select.fan_speed', 'low', T0, { options: ['low', 'medium', 'turbo'] })],
		['input_number.kwh', st('input_number.kwh', '300', T0, { min: 100, max: 1000 })],
		['media_player.tv', st('media_player.tv', 'playing', T0, { volume_level: 0.3, is_volume_muted: false, source_list: ['HDMI1', 'HDMI2'] })],
		['lock.front', st('lock.front', 'locked')],
	])

	const rLock = pol.evaluateControl({ entity_id: 'lock.front', action: 'turn_off' }, { states })
	assert.equal(rLock.ok, false)
	assert.match(rLock.error, /Tier 3/)

	assert.equal(pol.evaluateControl({ entity_id: 'select.fan_speed', action: 'select_option', service_data: { option: 'turbo' } }, { states }).ok, true)
	assert.equal(pol.evaluateControl({ entity_id: 'select.fan_speed', action: 'select_option', service_data: { option: 'invalid_opt' } }, { states }).ok, false)
	assert.equal(pol.evaluateControl({ entity_id: 'light.room', action: 'turn_on', service_data: { brightness_pct: 150 } }, { states }).ok, false)
	assert.equal(pol.evaluateControl({ entity_id: 'light.room', action: 'turn_on', service_data: { brightness_pct: 50 } }, { states }).ok, true)
	assert.equal(pol.evaluateControl({ entity_id: 'input_number.kwh', action: 'set_value', service_data: { value: 50 } }, { states }).ok, false)

	assert.equal(pol.evaluateControl({ entity_id: 'light.room', action: 'turn_off' }, { states, awayOverrideOn: true, requested: false }).ok, false)
	assert.equal(pol.evaluateControl({ entity_id: 'light.room', action: 'turn_off' }, { states, awayOverrideOn: true, requested: true }).ok, true)
	assert.equal(pol.evaluateControl({ entity_id: 'light.hwanpunggi', action: 'turn_off' }, { states, awayOverrideOn: true, requested: false }).ok, true)

	const selUndo = pol.buildUndoCall({ entity_id: 'select.fan_speed', action: 'select_option', prev_snapshot: pol.captureSnapshot(states.get('select.fan_speed')) })
	assert.deepEqual(selUndo, { domain: 'select', service: 'select_option', data: { option: 'low' } })
	const lightUndo = pol.buildUndoCall({ entity_id: 'light.room', action: 'turn_off', prev_snapshot: pol.captureSnapshot(states.get('light.room')) })
	assert.deepEqual(lightUndo, { domain: 'light', service: 'turn_on', data: { brightness: 180, color_temp_kelvin: 4000 } })
	assert.equal(pol.buildUndoCall({ entity_id: 'media_player.tv', action: 'turn_off', prev_snapshot: { state: 'playing', attrs: {} } }), null)

	const guard = { services: new Set(['notify.mobile_app_x']), actionEntities: new Set(), policy: pol, allowConfigWrite: false }
	assert.equal(checkMessage({ type: 'call_service', domain: 'select', service: 'select_option', target: { entity_id: 'select.fan_speed' }, service_data: { option: 'turbo' } }, guard), null)
	assert.match(checkMessage({ type: 'call_service', domain: 'homeassistant', service: 'restart' }, guard), /Tier 3/)
	assert.match(checkMessage({ type: 'call_service', domain: 'lock', service: 'unlock', target: { entity_id: 'lock.front' } }, guard), /차단|허용되지 않은/)
	assert.equal(checkRest('POST', '/api/config/core/check_config', guard), null)
	assert.match(checkRest('POST', '/api/config/automation/config/abc', guard), /허용되지 않은 REST/)
	assert.equal(checkRest('POST', '/api/config/automation/config/abc', { allowConfigWrite: true }), null)
})

test('ToolBroker & validateResponse 확장 스키마 호환성', async () => {
	const states = new Map([['light.a', st('light.a', 'on', T0, { friendly_name: '거실 불' })]])
	const broker = new ToolBroker({
		states,
		areaOf: new Map([['light.a', '거실']]),
		executeControl: async req => ({ ok: true, status: 'done', req }),
		handleProposalDecision: async () => ({ ok: true }),
	})
	const tools = broker.tools({ adminEnabled: true })
	assert.ok(tools.every(t => t.strict === true && t.parameters.additionalProperties === false))
	const found = JSON.parse(await broker.run('ha_search_entities', JSON.stringify({ query: '거실', domain: null, area: null, limit: null })))
	assert.equal(found[0].id, 'light.a')
	const blocked = await broker.run('ha_proposal_action', JSON.stringify({ pid: 'p1', decision: 'approve' }), { allowDirectRequest: false })
	assert.match(blocked, /직접 대화에서만/)

	const v = validateResponse({
		summary: 's',
		actions: [{ entity_id: 'select.a', action: 'select_option', service_data_json: '{"option":"turbo"}', reason: 'r', requested: false }],
		proposals: [{ kind: 'backup_create', target_id: 'ha', title: '백업', summary: '자동 백업', payload_json: null }],
		memory_ops: [{ op: 'upsert', category: 'preference', key: 'k1', content: '내용' }],
		info_requests: [{ kind: 'config_entries', entity_ids: [], hours: 24 }],
	})
	assert.deepEqual(v.actions[0].service_data, { option: 'turbo' })
	assert.equal(v.proposals[0].kind, 'backup_create')
	assert.equal(v.memory_ops[0].key, 'k1')
	assert.equal(v.info_requests[0].kind, 'config_entries')
})

test('AnomalyEngine & 브리핑 모드 스케줄링', async () => {
	const dir = mkdtempSync(join(TMP, 'anom-'))
	const store = new Store(join(dir, 'anom.db'))
	try {
		const ae = new AnomalyEngine({ store })
		const baseDay = Date.parse('2026-11-13T10:05:00+09:00')
		for (let i = 0; i < 8; i++) {
			store.recordSensorSample('sensor.power', 200 + (i % 2) * 10, baseDay + i * 10 * MIN)
		}
		assert.ok(ae.recomputeBaselines(baseDay + 120 * MIN) >= 1)
		const cur = new Map([['sensor.power', st('sensor.power', '950', baseDay + 7 * 86400000, { unit_of_measurement: 'W' })]])
		const tCheck = Date.parse('2026-11-20T10:15:00+09:00')
		assert.equal(ae.checkAnomalies(cur, tCheck).length, 0)
		const hits = ae.checkAnomalies(cur, tCheck + 16 * MIN)
		assert.equal(hits.length, 1)
		assert.equal(hits[0].entity_id, 'sensor.power')
	} finally { store.close() }

	const prompts = []
	const now = Date.parse('2026-11-20T07:35:00+09:00')
	const cfg = mergeConfig({ briefing_hours: [7, 18], hourly_checkin: false, reflection_hour: 23, heartbeat: { enabled: false } })
	const fakeHa = {
		connected: true, on() {}, once() {}, start() {}, stop() {},
		async call(m) { return m.type === 'repairs/list_issues' ? { issues: [] } : [] },
		async callService() { return { response: {} } },
	}
	const ag = new Agent({ cfg, ha: fakeHa, clock: () => now, brain: async a => { prompts.push(a.prompt); return { result: { summary: 'ok' }, ms: 1, tokens: 10 } } })
	try {
		await ag.tick()
		assert.equal(prompts.length, 1)
		assert.match(prompts[0], /\[정기 브리핑\] 7시/)
	} finally { ag.stop() }
})
