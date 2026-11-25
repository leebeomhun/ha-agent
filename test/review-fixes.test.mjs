// 종합 보완 회귀 테스트: 1~4번 모든 개선 항목 검증
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'haagent-review-'))
process.env.HAAGENT_DATA_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

const { mergeConfig, validateConfig, saveControl } = await import('../src/config.mjs')
const { P, writeJson, readJson } = await import('../src/util.mjs')
const { PolicyEngine } = await import('../src/core/policy.mjs')
const { Store } = await import('../src/core/store.mjs')
const { AnomalyEngine } = await import('../src/engine/anomaly.mjs')
const { HaAdmin, ruleToAutomationConfig, extractDeclaredVars } = await import('../src/admin/ha-admin.mjs')
const { ToolBroker } = await import('../src/tools/registry.mjs')
const { AssistServer, isIpAllowed, ipMatchesCidr } = await import('../src/channels/assist-server.mjs')
const { buildDirectory, matchFastCommand, claimsUnexecutedControl } = await import('../src/orchestrator/assist-context.mjs')
const { buildPrompt } = await import('../src/context.mjs')
const { runApi } = await import('../src/api.mjs')
const { runGemini } = await import('../src/llm/providers/gemini.mjs')
const { runAnthropic } = await import('../src/llm/providers/anthropic.mjs')
const { runOllama } = await import('../src/llm/providers/ollama.mjs')
const { sanitizedAgyEnv } = await import('../src/llm/providers/agy.mjs')
const { brainSettings } = await import('../src/brain.mjs')
const { refreshKakaoToken } = await import('../src/oob.mjs')
const { pcmToWav } = await import('../src/voice/gemini-voice.mjs')
const { Agent } = await import('../src/agent.mjs')

const T0 = Date.parse('2026-11-20T12:00:00+09:00')
const MIN = 60000
const st = (entity_id, state, attrs = {}, at = T0) => ({
	entity_id,
	state,
	attributes: { friendly_name: entity_id, ...attrs },
	last_changed: new Date(at).toISOString(),
	last_updated: new Date(at).toISOString(),
})

function cleanState() {
	rmSync(TMP, { recursive: true, force: true })
	mkdirSync(P.state, { recursive: true })
	saveControl({ paused: false, send: true })
	writeJson(P.rules, { updated: new Date(T0).toISOString(), rules: [] })
}

test('1.1 AssistServer: XSS 제거, CSP/보안 헤더, allowed_networks 403 차단, 401 레이트 리밋 429', async () => {
	cleanState()
	const ha = new EventEmitter()
	ha.connected = true
	ha.start = () => {}
	ha.stop = () => {}
	ha.call = async () => []
	ha.heartbeat = async () => {}

	// 1) CIDR/IP 허용 목록 유틸 검증
	assert.equal(ipMatchesCidr('::ffff:100.121.130.25', '100.64.0.0/10'), true)
	assert.equal(ipMatchesCidr('100.121.130.25', '100.64.0.0/10'), true)
	assert.equal(ipMatchesCidr('8.8.8.8', '100.64.0.0/10'), false)
	assert.equal(ipMatchesCidr('::1', '::1'), true)
	assert.equal(isIpAllowed('127.0.0.1', ['127.0.0.0/8', '100.64.0.0/10']), true)
	assert.equal(isIpAllowed('127.0.0.1', ['100.64.0.0/10']), false)

	// 2) allowed_networks에 127.0.0.1이 없으면 403 반환
	const cfgBlocked = mergeConfig({
		heartbeat: { enabled: false },
		assist: { enabled: true, host: '127.0.0.1', port: 0, token_file: join(TMP, 'tok1'), allowed_networks: ['100.64.0.0/10'] },
	})
	const srvBlocked = new AssistServer({ cfg: cfgBlocked, agent: { statusSummary: () => ({}) }, token: 'secret-tok' })
	const pBlocked = await srvBlocked.start()
	try {
		const res403 = await fetch(`http://127.0.0.1:${pBlocked}/health`)
		assert.equal(res403.status, 403)
	} finally {
		await srvBlocked.stop()
	}

	// 3) 허용된 네트워크에서 CSP/보안 헤더·XSS 제거·401 레이트 리밋 검증
	const cfgOk = mergeConfig({
		heartbeat: { enabled: false },
		assist: { enabled: true, host: '127.0.0.1', port: 0, token_file: join(TMP, 'tok2'), allowed_networks: ['127.0.0.0/8', '100.64.0.0/10'] },
	})
	const srvOk = new AssistServer({ cfg: cfgOk, agent: { statusSummary: () => ({ ok: true }) }, token: 'secret-tok' })
	const pOk = await srvOk.start()
	try {
		const htmlRes = await fetch(`http://127.0.0.1:${pOk}/`)
		assert.equal(htmlRes.status, 200)
		assert.ok(htmlRes.headers.get('content-security-policy')?.includes("default-src 'self'"))
		assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff')
		assert.equal(htmlRes.headers.get('x-frame-options'), 'DENY')
		const html = await htmlRes.text()
		assert.equal(/\.innerHTML\b/.test(html), false, '웹 콘솔에서 innerHTML을 사용하지 않음')
		assert.ok(html.includes('ROLLBACK_KINDS.has(p.kind)'))

		for (let i = 1; i <= 19; i++) {
			const r = await fetch(`http://127.0.0.1:${pOk}/api/status`, { headers: { authorization: 'Bearer wrong' } })
			assert.equal(r.status, 401)
		}
		const r20 = await fetch(`http://127.0.0.1:${pOk}/api/status`, { headers: { authorization: 'Bearer wrong' } })
		assert.equal(r20.status, 429)
		const r21 = await fetch(`http://127.0.0.1:${pOk}/api/status`, { headers: { authorization: 'Bearer secret-tok' } })
		assert.equal(r21.status, 429, '차단 기간 중에는 정상 토큰도 잠시 차단')
	} finally {
		await srvOk.stop()
	}
})

test('1.2 PolicyEngine ADMIN_SERVICES Tier3 차단 & Config 중복·effort_weekly 검증', () => {
	const pol = new PolicyEngine(mergeConfig({
		actions: { enabled: true },
		policy: { admin_enabled: true, tier1_auto: ['light.a'], tier3_blocked: ['switch.jubang_jubang_hairaiteu*'] },
	}))
	// service_data.entity_id 및 배열 우회 차단
	assert.match(pol.checkHaServiceCall({
		type: 'call_service', domain: 'homeassistant', service: 'disable_entity',
		service_data: { entity_id: 'lock.front' },
	}), /Tier 3/)
	assert.match(pol.checkHaServiceCall({
		type: 'call_service', domain: 'homeassistant', service: 'rename_entity',
		service_data: { entity_id: 'switch.jubang_jubang_hairaiteu_1' },
	}), /Tier 3/)
	assert.match(pol.checkHaServiceCall({
		type: 'call_service', domain: 'homeassistant', service: 'disable_entity',
		target: { entity_id: ['light.a', 'lock.front'] },
	}), /Tier 3/)
	assert.equal(pol.checkHaServiceCall({
		type: 'call_service', domain: 'homeassistant', service: 'disable_entity',
		service_data: { entity_id: 'light.a' },
	}), null)

	// 중복 권한 경고
	const dupRes = validateConfig(mergeConfig({
		actions: { enabled: true, auto: ['light.a'] },
		policy: { tier1_auto: ['light.a'] },
	}))
	assert.ok(dupRes.warnings.some(w => /중복/.test(w)))

	// effort_weekly 상속 및 경고
	const wCfg = mergeConfig({ codex: { effort_deep: 'high', effort_weekly: 'max' } })
	assert.equal(brainSettings(wCfg, 'codex').effort_weekly, 'max')
	assert.equal(brainSettings(wCfg, 'api').effort_weekly, 'max')
	assert.ok(validateConfig(wCfg).warnings.some(w => /max/.test(w)))
})

test('1.3~1.5 동시성 격리(answer.json, sessionLocks), 야간 답장 즉시 발송, failover heartbeat brain', async () => {
	cleanState()
	// 1) includeFileTools: false일 때 answer.json 보존
	const brainDir = join(TMP, 'brain-iso')
	const runDir = join(brainDir, 'run')
	mkdirSync(runDir, { recursive: true })
	const answerFile = join(runDir, 'answer.json')
	writeFileSync(answerFile, '{"keep":true}')

	const prevOa = process.env.TEST_REV_OA
	const prevGem = process.env.TEST_REV_GEM
	process.env.TEST_REV_OA = 'oa-k'
	process.env.TEST_REV_GEM = 'gem-k'
	try {
		const cfg = mergeConfig({ api: { key_env: 'TEST_REV_OA' }, gemini: { key_env: 'TEST_REV_GEM' } })
		await runApi({
			cfg, prompt: 'hi', effort: 'none', timeoutSec: 5, model: 'gpt-6-luna',
			brainDir, runDir, customSchema: { type: 'object' }, includeFileTools: false,
			fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"speech":"ok","continue_conversation":false}' }] }] }) }),
		})
		assert.equal(existsSync(answerFile), true, 'OpenAI Assist 호출이 answer.json을 지우지 않음')

		await runGemini({
			cfg, prompt: 'hi', effort: 'low', timeoutSec: 5, model: 'gemini-4-hydrogen',
			brainDir, runDir, customSchema: { type: 'object' }, includeFileTools: false,
			fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'text', text: '```json\n{"speech":"ok","continue_conversation":false}\n```' }] }] }) }),
		})
		assert.equal(existsSync(answerFile), true, 'Gemini Assist 호출이 answer.json을 지우지 않음')
	} finally {
		if (prevOa === undefined) delete process.env.TEST_REV_OA; else process.env.TEST_REV_OA = prevOa
		if (prevGem === undefined) delete process.env.TEST_REV_GEM; else process.env.TEST_REV_GEM = prevGem
	}

	// 2) sessionLocks 정리 + 야간(00:24) user 답장 즉시 발송 + failover heartbeat brain='gemini'
	class MockHA extends EventEmitter {
		constructor() { super(); this.connected = true; this.sent = []; this.beats = [] }
		start() {}
		stop() {}
		async call(m) { return m.type === 'get_states' ? [st('light.a', 'off')] : m.type === 'repairs/list_issues' ? { issues: [] } : [] }
		async callService(d, _s, { data }) { if (d === 'notify') this.sent.push(data); return { response: {} } }
		async heartbeat(d) { this.beats.push(d) }
	}
	const ha = new MockHA()
	const night = Date.parse('2026-11-22T00:24:00+09:00')
	const cfg2 = mergeConfig({
		active_hours: { start: 7, end: 23 },
		heartbeat: { enabled: true, interval_seconds: 10 },
		llm: { routes: { assist: 'api' } },
		assist: { fast_path: false, model: 'gpt-6-luna', effort: 'low' },
	})
	const agent = new Agent({
		cfg: cfg2, ha, clock: () => night, canUse: () => true,
		brain: async a => ({
			result: a.customSchema
				? { speech: '확인했어요.', continue_conversation: false }
				: { summary: '사용자 확인', notifications: [{ kind: 'info', level: 'normal', title: '화장실 설정', message: '권한이 없어요.', related_rule_ids: [] }], rule_changes: { upsert: [], delete: [] }, next_wakes: [], memory: { mode: 'keep', text: '' }, memory_ops: [], info_requests: [], actions: [], proposals: [], report: '' },
			ms: 1, tokens: 10,
		}),
	})
	agent.attach()
	ha.emit('ready', [st('light.a', 'off')])
	try {
		await agent.handleAssist({ text: '상태 어때?', conversationId: 'conv_leak_check' })
		assert.equal(agent.sessionLocks.has('conv_leak_check'), false, 'handleAssist 종료 후 sessionLocks 해제')

		// 야간 사용자 답장은 held 되지 않고 즉시 발송됨
		const e = await agent.cycle([{ type: 'user', text: '이전설정이 맞는데', at: night }])
		assert.equal(e.applied.notifications[0], 'sent: 화장실 설정')
		assert.equal(ha.sent.length, 1)
		assert.equal(agent.held.length, 0)

		// failover 시 heartbeat brain 필드 정확성 (agy -> gemini)
		agent.failover = { primary: 'agy', mode: 'gemini', until: night + 600000 }
		agent.lastBeat = 0
		agent.notifier.heartbeat(night)
		await new Promise(r => setImmediate(r))
		assert.equal(ha.beats.at(-1).brain, 'gemini')
	} finally {
		agent.stop()
	}
})

test('2.1 AnomalyEngine: 누적 센서 제외, 캐시 사용, 야간 anomaly held 보류', async () => {
	cleanState()
	const store = new Store(join(TMP, 'anom2.db'))
	try {
		const ae = new AnomalyEngine({ store })
		// 누적 센서들은 샘플 수집 단계부터 제외됨
		assert.equal(ae.onNumericState('sensor.electricity_kwh_month', st('sensor.electricity_kwh_month', '15.8', { unit_of_measurement: 'kWh' }), T0), false)
		assert.equal(ae.onNumericState('sensor.electricity_cost_month', st('sensor.electricity_cost_month', '2940', { unit_of_measurement: '원' }), T0), false)
		assert.equal(ae.onNumericState('sensor.custom_energy', st('sensor.custom_energy', '100', { state_class: 'total_increasing' }), T0), false)
		assert.equal(ae.onNumericState('sensor.living_power', st('sensor.living_power', '120', { state_class: 'measurement', unit_of_measurement: 'W' }), T0), true)

		// 기존 DB에 잘못 남아 있던 누적 센서 샘플도 recomputeBaselines에서 제거됨
		const baseDay = Date.parse('2026-11-13T10:05:00+09:00')
		for (let i = 0; i < 8; i++) {
			store.recordSensorSample('sensor.electricity_kwh_month', 10 + i, baseDay + i * 10 * MIN)
			store.recordSensorSample('sensor.living_power', 100 + (i % 2) * 5, baseDay + i * 10 * MIN)
		}
		ae.recomputeBaselines(baseDay + 120 * MIN)
		const allBase = store.listBaselines()
		assert.equal(allBase.some(b => b.entity_id === 'sensor.electricity_kwh_month'), false)
		assert.equal(allBase.some(b => b.entity_id === 'sensor.living_power'), true)

		// checkAnomalies는 DB getBaseline을 호출하지 않고 메모리 캐시를 사용한다
		let dbGetCalls = 0
		store.getBaseline = () => { dbGetCalls++; return null }
		const tCheck = Date.parse('2026-11-20T10:15:00+09:00')
		const cur = new Map([['sensor.living_power', st('sensor.living_power', '800', { unit_of_measurement: 'W' })]])
		ae.checkAnomalies(cur, tCheck)
		const hits = ae.checkAnomalies(cur, tCheck + 16 * MIN)
		assert.equal(hits.length, 1)
		assert.equal(dbGetCalls, 0, 'tick마다 SQLite getBaseline을 호출하지 않음')
	} finally {
		store.close()
	}

	// 야간(02:00 KST) anomaly는 LLM 즉시 호출 대신 held에 보류되고 프롬프트에 렌더링됨
	cleanState()
	const night = Date.parse('2026-11-20T02:00:00+09:00')
	const ha = new EventEmitter()
	ha.connected = true; ha.start = () => {}; ha.stop = () => {}
	ha.call = async m => (m.type === 'get_states' ? [st('sensor.living_power', '900', { unit_of_measurement: 'W' })] : m.type === 'repairs/list_issues' ? { issues: [] } : [])
	ha.callService = async () => ({ response: {} })
	ha.heartbeat = async () => {}

	let brainRuns = 0
	const agent = new Agent({
		cfg: mergeConfig({ active_hours: { start: 7, end: 23 }, heartbeat: { enabled: false } }),
		ha, clock: () => night,
		brain: async () => { brainRuns++; return { result: { summary: 'ok' }, ms: 1, tokens: 1 } },
	})
	agent.attach()
	ha.emit('ready', [st('sensor.living_power', '900', { unit_of_measurement: 'W' })])
	try {
		agent.anomaly.checkAnomalies = () => [{ type: 'anomaly', entity_id: 'sensor.living_power', name: '거실 전력', value: 900, avg: 100, z: 8.5, at: night }]
		await agent.tick()
		assert.equal(brainRuns, 0, '조용한 시간에는 이상탐지로 LLM을 바로 깨우지 않음')
		assert.equal(agent.held.length, 1)
		assert.equal(agent.held[0].type, 'anomaly')
		const p = buildPrompt({ guide: 'g', now: night, quiet: false, reasons: [{ type: 'held' }], rules: [], runtime: {}, schedule: [], memory: '', held: agent.held, ring: [], weather: null, calendar: [] })
		assert.match(p, /이상 패턴 감지 sensor\.living_power.*900.*8\.5σ/)
	} finally {
		agent.stop()
	}
})

test('2.2 HaAdmin: 만료 정리, 롤백 불가 제안 거부, ruleToAutomationConfig 확장·차단, 동시 승인 직렬화', async () => {
	cleanState()
	const store = new Store(join(TMP, 'adm-fix.db'))
	try {
		const ha = {
			connected: true,
			guard: { allowConfigWrite: false },
			saved: new Map(),
			async saveConfigRest(d, id, c) {
				assert.equal(this.guard.allowConfigWrite, true)
				await new Promise(r => setTimeout(r, 15))
				this.saved.set(`${d}:${id}`, c)
			},
			async deleteConfigRest() {},
			async callService() {},
			async checkConfig() { return { result: 'valid' } },
			async renderTemplate() { return 'ok' },
		}
		const states = new Map([['light.a', st('light.a', 'on')], ['person.me', st('person.me', 'home')]])
		const cfg = mergeConfig({ policy: { admin_enabled: true, proposal_expire_hours: 1 } })
		const adm = new HaAdmin({ cfg, ha, store, states })

		// 1) 만료 정리
		const expProp = await adm.createProposal({ kind: 'backup_create', target_id: 'ha', title: '백업', summary: '수동 백업' }, T0)
		assert.equal(expProp.ok, true)
		assert.equal(adm.isRollbackable(expProp.proposal), false)
		const expired = adm.expireProposals(T0 + 2 * 3600000)
		assert.equal(expired.length, 1)
		assert.equal(expired[0].status, 'expired')

		// 2) 롤백 불가 제안 거부
		const bakProp = await adm.createProposal({ kind: 'backup_create', target_id: 'ha', title: '백업2', summary: '백업' }, T0)
		await adm.approveProposal(bakProp.proposal.pid, T0)
		const rbErr = await adm.rollbackProposal(bakProp.proposal.pid, T0)
		assert.equal(rbErr.ok, false)
		assert.match(rbErr.error, /롤백을 지원하지 않음/)

		// 3) ruleToAutomationConfig: ne/not_in/in 변환 & stale 거부
		const autoNe = ruleToAutomationConfig({
			id: 'away_on', description: '외출 시 켜짐', entity_id: 'light.a', op: 'eq', value: 'on', for_minutes: 5,
			also: [{ entity_id: 'person.me', op: 'ne', value: 'home' }],
		})
		assert.equal(autoNe.conditions[0].condition, 'template')
		assert.match(autoNe.conditions[0].value_template, /!= "home"/)
		assert.throws(() => ruleToAutomationConfig({ id: 's1', description: 'd', entity_id: 'light.a', op: 'stale', value: null, for_minutes: 60 }), /지원하지 않음/)

		// 4) 동시 승인 직렬화 시 allowConfigWrite 복원 보장
		const p1 = await adm.createProposal({ kind: 'automation_upsert', target_id: 'automation.a1', title: 't1', summary: 's1', payload: { config: { alias: 'a1', triggers: [{ trigger: 'state', entity_id: 'light.a' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] } } }, T0)
		const p2 = await adm.createProposal({ kind: 'automation_upsert', target_id: 'automation.a2', title: 't2', summary: 's2', payload: { config: { alias: 'a2', triggers: [{ trigger: 'state', entity_id: 'light.a' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] } } }, T0)
		const [r1, r2] = await Promise.all([adm.approveProposal(p1.proposal.pid, T0), adm.approveProposal(p2.proposal.pid, T0)])
		assert.equal(r1.ok, true)
		assert.equal(r2.ok, true)
		assert.equal(ha.guard.allowConfigWrite, false)
	} finally {
		store.close()
	}
})

test('3.1~3.2 STT 유음 폴백, 새 Assist 도구 3종, 빠른 경로 확장, claimsUnexecutedControl 오탐 방지, 정렬 일관성', async () => {
	cleanState()
	const ha = new EventEmitter()
	ha.connected = true; ha.start = () => {}; ha.stop = () => {}
	const statesList = [
		st('switch.gonggi', 'off', { friendly_name: '공기청정기' }),
		st('media_player.tv', 'playing', { friendly_name: '거실 TV' }),
		st('sensor.temp', '22.5', { friendly_name: '거실 온도', device_class: 'temperature', unit_of_measurement: '°C' }),
		st('weather.jib', 'sunny', { temperature: 10, humidity: 40, wind_speed: 2 }),
		st('calendar.personal', 'off', { friendly_name: '개인 달력' }),
	]
	ha.call = async m => {
		if (m.type === 'get_states') return statesList
		if (m.type === 'config/area_registry/list') return [{ area_id: 'living', name: '거실' }]
		if (m.type === 'config/device_registry/list') return []
		if (m.type === 'config/entity_registry/list') return [{ entity_id: 'sensor.temp', area_id: 'living' }, { entity_id: 'switch.gonggi', area_id: 'living' }]
		return []
	}
	ha.callService = async (d, s, opts) => {
		if (d === 'weather') return { response: { [opts.target.entity_id]: { forecast: [{ datetime: new Date(T0 + 3600000).toISOString(), condition: 'rainy', temperature: 9, precipitation: 2.5 }] } } }
		if (d === 'calendar') return { response: { 'calendar.personal': { events: [{ start: '2026-11-20T18:00:00+09:00', end: '2026-11-20T19:00:00+09:00', summary: '저녁 약속' }] } } }
		return { response: {} }
	}
	ha.heartbeat = async () => {}

	const sttCalls = []
	const cfg = mergeConfig({
		heartbeat: { enabled: false },
		actions: { enabled: true },
		policy: { tier1_auto: ['switch.gonggi'], tier2_confirm: ['media_player.tv'] },
		assist: { voice: { stt_model: 'gemini-3.5-transcribe', stt_fallback_model: 'gemini-3.5-flash-lite', stt_debug_keep: 0 } },
	})
	const agent = new Agent({
		cfg, ha, clock: () => T0,
		sttFn: async args => {
			sttCalls.push(args)
			if ((args.model ?? cfg.assist.voice.stt_model) === 'gemini-3.5-transcribe') return { text: '', ms: 5, model: 'gemini-3.5-transcribe' }
			return { text: '공기청정기 끄자', ms: 8, model: args.model }
		},
	})
	agent.attach()
	ha.emit('ready', statesList)
	try {
		// 1) 유음 오디오 -> transcribe 빈 응답 시 fallback 모델 1회 재시도 & PCM->WAV 단일 래핑 전달
		const sr = 16000, loudPcm = Buffer.alloc(sr * 2) // 1초, 16-bit
		for (let i = 0; i < sr; i++) loudPcm.writeInt16LE(i % 2 ? 12000 : -12000, i * 2)
		const rLoud = await agent.handleStt({ audioBuffer: loudPcm, mimeType: 'audio/l16;rate=16000;channels=1' })
		assert.equal(rLoud.text, '공기청정기 끄자')
		assert.equal(sttCalls.length, 2)
		assert.equal(sttCalls[0].mimeType, 'audio/wav')
		assert.equal(sttCalls[1].model, 'gemini-3.5-flash-lite')

		// 무음 오디오 -> fallback 재시도 안 함
		sttCalls.length = 0
		const rSilent = await agent.handleStt({ audioBuffer: pcmToWav(Buffer.alloc(sr * 2), { sampleRate: sr }), mimeType: 'audio/wav' })
		assert.equal(rSilent.text, '')
		assert.equal(sttCalls.length, 1)

		// 2) matchFastCommand 확장 + claimsUnexecutedControl 과거 질문 필터
		const dir = agent.assistDirectory()
		assert.equal(matchFastCommand('공기청정기는 끄자', dir.index)?.service, 'turn_off')
		assert.equal(matchFastCommand('거실 TV 꺼줘', dir.index)?.service, 'turn_off')
		assert.equal(matchFastCommand('거실 TV 켜줘', dir.index), null, 'media_player는 turn_on 미지원')
		assert.equal(claimsUnexecutedControl('어제 화장실 환풍기 누가 켰어?', '자동화가 켰어요.', 0), false)
		assert.equal(claimsUnexecutedControl('주방 불 켜줘', '주방 불을 켰어요.', 0), true)

		// 3) ToolBroker 새 도구 & unit 포함
		const found = JSON.parse(await agent.toolBroker.run('ha_search_entities', JSON.stringify({ query: '온도', domain: null, area: null, limit: null })))
		assert.equal(found[0].unit, '°C')
		assert.equal(found[0].device_class, 'temperature')
		const wOut = JSON.parse(await agent.toolBroker.run('ha_get_weather', JSON.stringify({ entity_id: null })))
		assert.match(wOut.summary, /비 2\.5mm/)
		const cOut = JSON.parse(await agent.toolBroker.run('ha_get_calendar', JSON.stringify({ days: 2 })))
		assert.match(cOut.summary, /저녁 약속/)
		await agent.notifier.deliver({ kind: 'info', level: 'normal', title: '테스트 알림', message: '본문', related_rule_ids: [] })
		const nOut = JSON.parse(await agent.toolBroker.run('ha_get_recent_notifications', JSON.stringify({ hours: 24, limit: 10 })))
		assert.equal(nOut.length, 1)
		assert.equal(nOut[0].title, '테스트 알림')

		// 4) buildDirectory 정렬 일관성
		const revStates = new Map([...agent.states].reverse())
		const d1 = buildDirectory({ policy: agent.policy, states: agent.states })
		const d2 = buildDirectory({ policy: agent.policy, states: revStates })
		assert.equal(d1.staticText, d2.staticText)
	} finally {
		agent.stop()
	}
})

test('4.1~4.3 Store.maintain 정리, reflection Assist 대화 포함, OOB 락 중복갱신 방지, fallback 시크릿 차단, Anthropic/Ollama 보완', async () => {
	cleanState()
	const DAY = 86400000
	// 1) Store.maintain() 보존 정리
	const stDb = new Store(join(TMP, 'maint.db'))
	try {
		stDb.recordEvent({ t: T0 - 90 * DAY, id: 'light.old', to: 'on' })
		stDb.recordEvent({ t: T0 - 5 * DAY, id: 'light.new', to: 'on' })
		stDb.upsertNotification({ nid: 'n_old', ts: T0 - 100 * DAY, kind: 'info', title: 'old', message: 'm', status: 'sent' })
		stDb.upsertNotification({ nid: 'n_new', ts: T0 - 1 * DAY, kind: 'info', title: 'new', message: 'm', status: 'sent' })
		stDb.recordFeedback({ ts: T0 - 200 * DAY, kind: 'up', title: 'old' })
		stDb.recordFeedback({ ts: T0 - 1 * DAY, kind: 'up', title: 'new' })
		stDb.ensureConversation('c_old', 'ha_assist', null, T0 - 100 * DAY)
		stDb.appendMessage('c_old', 'user', '오래된 말', null, T0 - 100 * DAY)
		stDb.ensureConversation('c_new', 'ha_assist', null, T0 - 1 * DAY)
		stDb.appendMessage('c_new', 'user', '최근 말', null, T0 - 1 * DAY)

		const del = stDb.maintain(T0)
		assert.equal(del.events, 1)
		assert.equal(del.notifications, 1)
		assert.equal(del.feedback, 1)
		assert.equal(del.messages, 1)
		assert.equal(del.conversations, 1)
		assert.equal(stDb.recentConversationMessages({ sinceMs: T0 - 2 * DAY }).length, 1)
	} finally {
		stDb.close()
	}

	// 2) reflection 프롬프트에 최근 24시간 Assist 대화 반영 & effort_weekly vs effort_deep 분리
	const ha = new EventEmitter()
	ha.connected = true; ha.start = () => {}; ha.stop = () => {}
	ha.call = async m => (m.type === 'get_states' ? [st('light.a', 'off')] : m.type === 'repairs/list_issues' ? { issues: [] } : [])
	ha.callService = async () => ({ response: {} })
	ha.heartbeat = async () => {}
	const seen = []
	const agent = new Agent({
		cfg: mergeConfig({ heartbeat: { enabled: false }, codex: { effort_deep: 'high', effort_weekly: 'max' } }),
		ha, clock: () => T0,
		brain: async a => { seen.push({ prompt: a.prompt, effort: a.effort }); return { result: { summary: 'ok', report: '# 주간 분석\n' }, ms: 1, tokens: 1 } },
	})
	agent.attach()
	ha.emit('ready', [st('light.a', 'off')])
	try {
		agent.sessions.ensure('conv_r', { channel: 'ha_assist', now: T0 - 3600000 })
		agent.sessions.append('conv_r', 'user', '내일 제주도 출장 가요', null, T0 - 3600000)
		await agent.cycle([{ type: 'reflection', hour: 23 }])
		await agent.cycle([{ type: 'weekly' }])
		assert.equal(seen[0].effort, 'high')
		assert.match(seen[0].prompt, /최근 24시간 HA Assist 대화[\s\S]*내일 제주도 출장 가요/)
		assert.equal(seen[1].effort, 'max')
	} finally {
		agent.stop()
	}

	// 3) Kakao refreshKakaoToken: 다른 프로세스가 이미 .env를 갱신했으면 중복 OAuth 생략
	const envFile = join(TMP, 'shared.env')
	writeFileSync(envFile, 'KAKAO_ACCESS_TOKEN=fresh-by-other\nKAKAO_REFRESH_TOKEN=refresh-2\n', { mode: 0o600 })
	let oauthHits = 0
	const kCfg = { accessToken: 'stale-token', refreshToken: 'refresh-1', clientId: 'cid', envFile, tokenEnv: 'KAKAO_ACCESS_TOKEN', refreshEnv: 'KAKAO_REFRESH_TOKEN' }
	const tokRes = await refreshKakaoToken(kCfg, {
		failedToken: 'stale-token',
		fetchFn: async () => { oauthHits++; return { ok: true, status: 200, text: async () => '{}' } },
	})
	assert.equal(oauthHits, 0)
	assert.equal(tokRes.accessToken, 'fresh-by-other')

	// 4) agy 환경변수에서 oob.fallback 시크릿 제거
	const cleanEnv = sanitizedAgyEnv(
		mergeConfig({ oob: { type: 'kakao', fallback: { type: 'slack', token_env: 'MY_FALLBACK_SLACK_TOK' } } }),
		{ PATH: '/usr/bin', MY_FALLBACK_SLACK_TOK: 'xoxb-secret', SAFE_VAR: 'keep' },
	)
	assert.equal(cleanEnv.MY_FALLBACK_SLACK_TOK, undefined)
	assert.equal(cleanEnv.SAFE_VAR, 'keep')

	// 5) Anthropic 재시도 + cache_read_input_tokens + 병렬 읽기, Ollama 도구 루프
	const prevAnt = process.env.TEST_ANT_REV
	process.env.TEST_ANT_REV = 'ant-k'
	try {
		let antTry = 0, peak = 0, active = 0
		const broker = new ToolBroker({ states: new Map([['light.a', st('light.a', 'on')]]) })
		const origRun = broker.run.bind(broker)
		broker.run = async (n, a, c) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 15)); const out = await origRun(n, a, c); active--; return out }

		const antRes = await runAnthropic({
			cfg: mergeConfig({ llm: { anthropic: { key_env: 'TEST_ANT_REV' } } }),
			prompt: '확인', toolBroker: broker, customSchema: { type: 'object' }, includeFileTools: false,
			fetchFn: async () => {
				antTry++
				if (antTry === 1) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), text: async () => '{"error":{"message":"rate"}}' }
				if (antTry === 2) return { ok: true, status: 200, text: async () => JSON.stringify({ usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'ha_get_state', input: { entity_ids: ['light.a'] } }, { type: 'tool_use', id: 't2', name: 'ha_get_state', input: { entity_ids: ['light.a'] } }] }) }
				return { ok: true, status: 200, text: async () => JSON.stringify({ usage: { input_tokens: 30, cache_read_input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: '{"speech":"완료"}' }] }) }
			},
		})
		assert.equal(peak, 2)
		assert.equal(antRes.usage.cached, 200)
		assert.equal(antRes.result.speech, '완료')

		let olTry = 0
		const olRes = await runOllama({
			cfg: mergeConfig({}), prompt: '불 상태', toolBroker: broker, customSchema: { type: 'object' }, includeFileTools: false,
			fetchFn: async () => {
				olTry++
				if (olTry === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ prompt_eval_count: 10, eval_count: 5, message: { tool_calls: [{ function: { name: 'ha_get_state', arguments: { entity_ids: ['light.a'] } } }] } }) }
				return { ok: true, status: 200, text: async () => JSON.stringify({ prompt_eval_count: 20, eval_count: 8, message: { content: '{"speech":"켜져 있어요"}' } }) }
			},
		})
		assert.equal(olRes.tool_calls, 1)
		assert.equal(olRes.result.speech, '켜져 있어요')
	} finally {
		if (prevAnt === undefined) delete process.env.TEST_ANT_REV; else process.env.TEST_ANT_REV = prevAnt
	}
})

test('HaAdmin.validateHaConfig: 런타임·선언 변수 UndefinedError 허용 및 11번째 이후 문법 오류 검출', async () => {
	cleanState()
	const store = new Store(join(TMP, 'adm-tpl.db'))
	try {
		const ha = {
			connected: true,
			guard: { allowConfigWrite: false },
			async renderTemplate(tpl) {
				const errFor = name => new Error(`HA REST 400: {"message":"Error rendering template: UndefinedError: '${name}' is undefined"}`)
				if (tpl.includes('bad_syntax')) throw new Error('HA REST 400: {"message":"Error rendering template: TemplateSyntaxError: unexpected \'}\'"}')
				if (tpl.includes('bogus_filter')) throw new Error('HA REST 400: {"message":"Error rendering template: TemplateAssertionError: No filter named \'bogus_filter\'."}')
				for (const name of ['trigger', 'context', 'this', 'repeat', 'wait', 'away_due', 'tvar', 'resp_var', 'my_field', 'typo_var']) {
					if (tpl.includes(name)) throw errFor(name)
				}
				return 'ok'
			},
		}
		const states = new Map([['light.a', st('light.a', 'on')]])
		const adm = new HaAdmin({ cfg: mergeConfig({ policy: { admin_enabled: true } }), ha, store, states })

		const validCfg = {
			alias: '런타임 변수 테스트',
			trigger_variables: { tvar: 1 },
			fields: { my_field: { description: '필드' } },
			triggers: [{ trigger: 'template', value_template: '{{ trigger.id == "left" and tvar == 1 }}' }],
			conditions: [{ condition: 'template', value_template: '{{ this.attributes.last_triggered is none }}' }],
			actions: [
				{ variables: { away_due: '{{ 123 }}' } },
				{ action: 'test.svc', response_variable: 'resp_var', data: { variables: { ignored_nested: 1 } } },
				{ repeat: { for_each: ['x'], sequence: [{ action: 'notify.mobile_app_ibeomhun', data: { message: '{{ context.id }} {{ repeat.item }} {{ wait.completed }} {{ away_due }} {{ resp_var }} {{ my_field }}' } }] } },
			],
		}
		assert.deepEqual([...extractDeclaredVars(validCfg)].sort(), ['away_due', 'my_field', 'resp_var', 'tvar'])
		const vOk = await adm.validateHaConfig('automation_upsert', validCfg)
		assert.equal(vOk.valid, true)
		assert.equal(vOk.errors.length, 0)
		assert.equal(vOk.warnings.length, 1)
		assert.match(vOk.warnings[0], /문법 검사만 통과/)

		// 미선언 변수, 필터 오류, 문법 오류(11번째 이후 포함)는 거부되어야 함
		const extraActions = Array.from({ length: 12 }, (_, i) => ({
			action: 'notify.mobile_app_ibeomhun',
			data: { message: i === 11 ? '{{ bad_syntax }}' : `{{ ${i} }}` },
		}))
		const vSyntaxLate = await adm.validateHaConfig('automation_upsert', {
			alias: '11번째 이후 문법 오류',
			triggers: [{ trigger: 'state', entity_id: 'light.a' }],
			actions: extraActions,
		})
		assert.equal(vSyntaxLate.valid, false)
		assert.match(vSyntaxLate.errors[0], /TemplateSyntaxError/)

		const vFilter = await adm.validateHaConfig('automation_upsert', {
			alias: '필터 오류',
			triggers: [{ trigger: 'state', entity_id: 'light.a' }],
			actions: [{ action: 'notify.mobile_app_ibeomhun', data: { message: '{{ 1 | bogus_filter }}' } }],
		})
		assert.equal(vFilter.valid, false)
		assert.match(vFilter.errors[0], /TemplateAssertionError/)

		const vTypo = await adm.validateHaConfig('automation_upsert', {
			alias: '미선언 변수',
			triggers: [{ trigger: 'state', entity_id: 'light.a' }],
			actions: [{ action: 'notify.mobile_app_ibeomhun', data: { message: '{{ typo_var }}' } }],
		})
		assert.equal(vTypo.valid, false)
		assert.match(vTypo.errors[0], /UndefinedError: 'typo_var'/)
	} finally {
		store.close()
	}
})

test('Agent.#apply(weekly): 제안 사전 검증 실패 시 주간 보고서에 참고 문구 추가 및 rejected 기록', async () => {
	cleanState()
	const posted = []
	const ha = new EventEmitter()
	ha.connected = true; ha.start = () => {}; ha.stop = () => {}
	ha.call = async m => (m.type === 'get_states' ? [st('light.a', 'off')] : m.type === 'repairs/list_issues' ? { issues: [] } : [])
	ha.callService = async (domain, service, opts) => {
		if (domain === 'persistent_notification' && service === 'create') posted.push(opts?.data)
		return { response: {} }
	}
	ha.heartbeat = async () => {}
	const agent = new Agent({
		cfg: mergeConfig({ heartbeat: { enabled: false }, policy: { admin_enabled: true }, weekly: { publish: true } }),
		ha, clock: () => T0,
		brain: async () => ({
			result: {
				summary: '주간 점검 완료',
				notifications: [],
				rule_changes: { upsert: [], delete: [] },
				next_wakes: [],
				memory: { mode: 'keep', text: '' },
				memory_ops: [],
				info_requests: [],
				actions: [],
				proposals: [{
					kind: 'automation_upsert',
					target_id: 'automation.bad_one',
					title: '잘못된 제안',
					summary: '없는 엔티티 참조',
					payload_json: JSON.stringify({ alias: 'x', triggers: [{ trigger: 'state', entity_id: 'sensor.missing_entity' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] }),
				}],
				report: '# 주간 분석\n\n내용입니다.',
			},
			ms: 1, tokens: 1,
		}),
	})
	agent.attach()
	ha.emit('ready', [st('light.a', 'off')])
	try {
		const res = await agent.cycle([{ type: 'weekly' }])
		assert.equal(res.applied.proposals.length, 0)
		assert.equal(res.applied.rejected.length, 1)
		assert.equal(res.applied.rejected[0].proposal, '잘못된 제안')
		const savedReport = readFileSync(join(P.weekly, res.applied.report), 'utf8')
		assert.match(savedReport, /> ⚠️ 참고: 아래 승인안은 사전 검증을 통과하지 못해 승인 대기 목록에 등록되지 않았어요\./)
		assert.match(savedReport, /- 잘못된 제안: .*sensor\.missing_entity/)
		assert.equal(posted.length, 1)
		assert.match(posted[0].message, /⚠️ 참고: 아래 승인안은 사전 검증을 통과하지 못해/)
	} finally {
		agent.stop()
	}
})

test('HaAdmin.#resolveConfigId / createProposal: states.attributes.id 및 payload.config.id 일관성 보장', async () => {
	cleanState()
	const store = new Store(join(TMP, 'adm-id.db'))
	try {
		const orig = {
			id: 'alert_away_check',
			alias: '기존 외출 확인',
			triggers: [{ trigger: 'state', entity_id: 'light.a' }],
			actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }],
		}
		const ha = {
			connected: true,
			guard: { allowConfigWrite: false },
			async getConfigRest(dom, id) {
				if (dom === 'automation' && id === 'alert_away_check') return orig
				throw new Error('404')
			},
			async renderTemplate() { return 'ok' },
		}
		const states = new Map([
			['light.a', st('light.a', 'on')],
			['automation.alrim_away', st('automation.alrim_away', 'on', { id: 'alert_away_check' })],
		])
		// meta.autoCfg가 비어 있어도 states.attributes.id를 우선 사용하고 config.id를 일치시킴
		const adm = new HaAdmin({ cfg: mergeConfig({ policy: { admin_enabled: true } }), ha, store, states })
		const p1 = await adm.createProposal({
			kind: 'automation_upsert',
			target_id: 'automation.alrim_away',
			title: '기존 자동화 수정',
			summary: '테스트',
			payload: {
				config: {
					id: 'different_input_id',
					alias: '수정된 외출 확인',
					triggers: [{ trigger: 'state', entity_id: 'light.a' }],
					actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }],
				},
			},
		}, T0)
		assert.equal(p1.ok, true)
		assert.equal(p1.proposal.payload.config_id, 'alert_away_check')
		assert.equal(p1.proposal.payload.config.id, 'alert_away_check')
		assert.deepEqual(p1.proposal.pre_snapshot, orig)
		assert.match(p1.proposal.diff_text, /\+.*"alias": "수정된 외출 확인"/)

		// states와 meta.autoCfg에 없는 신규 자동화는 payload.config.id를 사용
		const p2 = await adm.createProposal({
			kind: 'automation_upsert',
			target_id: 'automation.brand_new_one',
			title: '신규 자동화',
			summary: '테스트',
			payload: {
				config: {
					id: 'custom_new_id',
					alias: '신규',
					triggers: [{ trigger: 'state', entity_id: 'light.a' }],
					actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }],
				},
			},
		}, T0)
		assert.equal(p2.ok, true)
		assert.equal(p2.proposal.payload.config_id, 'custom_new_id')
		assert.equal(p2.proposal.payload.config.id, 'custom_new_id')
	} finally {
		store.close()
	}
})
