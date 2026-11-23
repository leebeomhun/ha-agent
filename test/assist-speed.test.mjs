// Assist 속도 개선 테스트: 기기 목록·캐시 친화 프롬프트, 로컬 빠른 경로, 조기 종료, 단계별 모델 선택, 거짓 제어 응답 차단, OpenAI/Gemini 노력 해석
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'haagent-speed-'))
process.env.HAAGENT_DATA_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

const { mergeConfig, saveControl } = await import('../src/config.mjs')
const { P, writeJson } = await import('../src/util.mjs')
const { PolicyEngine } = await import('../src/core/policy.mjs')
const { Agent } = await import('../src/agent.mjs')
const { brainSettings } = await import('../src/brain.mjs')
const { reasoningFor, runApi } = await import('../src/api.mjs')
const { resolveGeminiModelAndThinking, runGemini } = await import('../src/llm/providers/gemini.mjs')
const ctx = await import('../src/orchestrator/assist-context.mjs')

const T0 = Date.parse('2026-11-20T12:00:00+09:00')
const st = (entity_id, state, attrs = {}) => ({
	entity_id, state, attributes: { friendly_name: entity_id, ...attrs },
	last_changed: new Date(T0).toISOString(), last_updated: new Date(T0).toISOString(),
})

const STATES = () => new Map([
	['switch.kitchen', st('switch.kitchen', 'off', { friendly_name: '주방·세탁실 2구 스위치 주방 스위치' })],
	['light.bul', st('light.bul', 'off', { friendly_name: '불' })],
	['light.fan', st('light.fan', 'on', { friendly_name: '환풍기' })],
	['select.speed', st('select.speed', 'low', { friendly_name: '공기청정기 속도', options: ['low', 'mid', 'high'] })],
	['sensor.temp', st('sensor.temp', '18.6', { friendly_name: '온도', device_class: 'temperature', unit_of_measurement: '°C' })],
	['sensor.outside', st('sensor.outside', '3', { friendly_name: '바깥 온도', device_class: 'temperature', unit_of_measurement: '°C' })],
	['switch.cooktop', st('switch.cooktop', 'off', { friendly_name: '주방 하이라이트' })],
	['switch.cooktop_led', st('switch.cooktop_led', 'on', { friendly_name: '주방 하이라이트 LED' })],
])
const AREAS = new Map([['switch.kitchen', '주방'], ['light.bul', '화장실'], ['light.fan', '화장실'], ['sensor.temp', '화장실'], ['switch.cooktop', '주방'], ['switch.cooktop_led', '주방']])
const BASE_CFG = {
	heartbeat: { enabled: false },
	actions: { enabled: true, auto: ['light.fan', 'select.speed'], confirm: ['switch.kitchen', 'light.bul'], verify_seconds: 1 },
	policy: { admin_enabled: false, tier3_blocked: ['switch.cooktop*'] },
	assist: {
		enabled: false,
		aliases: { 'switch.kitchen': ['주방 불', '주방 조명'], 'light.bul': ['화장실 불'] },
	},
}

test('buildDirectory: 기기 목록(정적)·상태(동적)·빠른 경로 색인·차단 기기', () => {
	const cfg = mergeConfig(BASE_CFG)
	const policy = new PolicyEngine(cfg)
	const catOf = new Map([['switch.cooktop_led', 'config']])
	const d = ctx.buildDirectory({ policy, states: STATES(), areaOf: AREAS, catOf, aliases: cfg.assist.aliases })
	assert.match(d.staticText, /switch\.kitchen \| 주방·세탁실 2구 스위치 주방 스위치 \| 주방 \| 승인/)
	assert.match(d.staticText, /별칭: 주방 불, 주방 조명/)
	assert.match(d.staticText, /select_option\(low\/mid\/high\)/)
	assert.match(d.staticText, /sensor\.temp \| 온도 \| 화장실/)
	assert.doesNotMatch(d.staticText, /sensor\.outside/, '방이 없는 센서는 뺀다')
	assert.match(d.staticText, /차단된 기기.*주방 하이라이트/)
	assert.doesNotMatch(d.staticText, /하이라이트 LED/, '설정용(entity_category) 엔티티는 차단 목록에서 뺀다')
	assert.doesNotMatch(d.staticText, /=off|18\.6/, '상태 값은 정적 부분에 넣지 않는다')
	assert.match(d.dynamicText, /switch\.kitchen=off/)
	assert.match(d.dynamicText, /sensor\.temp=18\.6°C/)
	assert.equal(d.index.get('주방불').entity_id, 'switch.kitchen')
	assert.equal(d.index.has('불'), false, '한 글자 이름은 색인하지 않는다')
	assert.equal(d.labels.get('light.bul'), '화장실 불')
})

test('matchFastCommand: 켜기/끄기 변형, STT 중복, 모호·복합 요청은 LLM으로', () => {
	const cfg = mergeConfig(BASE_CFG)
	const { index } = ctx.buildDirectory({ policy: new PolicyEngine(cfg), states: STATES(), areaOf: AREAS, aliases: cfg.assist.aliases })
	const m = t => ctx.matchFastCommand(t, index)
	assert.deepEqual(m('주방 불 켜줘'), { entity_id: 'switch.kitchen', label: '주방 불', service: 'turn_on' })
	assert.equal(m('주방 불 좀 꺼 줄래?').service, 'turn_off')
	assert.equal(m('주방 조명을 켜 주세요.').entity_id, 'switch.kitchen')
	assert.equal(m('주방 불 켜. 주방 불 켜.').entity_id, 'switch.kitchen')
	assert.equal(m('환풍기 꺼').entity_id, 'light.fan')
	assert.equal(m('불 켜줘'), null)
	assert.equal(m('주방 불 켜고 환풍기 꺼줘'), null)
	assert.equal(m('주방 불 켜져 있어?'), null)
	assert.equal(m('주방 하이라이트 꺼줘'), null, '차단 기기는 색인에 없다')
	assert.equal(m('공기청정기 속도 높여줘'), null)
})

test('controlSpeech·조사, 단계 판정, 모델/프로바이더 짝, 거짓 제어 응답 감지', () => {
	assert.equal(ctx.controlSpeech('주방 불', 'turn_on', { status: 'done' }), '주방 불을 켰어요.')
	assert.equal(ctx.controlSpeech('환풍기', 'turn_off', { status: 'done' }), '환풍기를 껐어요.')
	assert.equal(ctx.controlSpeech('주방 불', 'turn_off', { status: 'noop' }), '주방 불은 이미 꺼져 있어요.')
	assert.match(ctx.controlSpeech('주방 불', 'turn_on', { status: 'rejected', error: '오늘 행동 한도(20회)에 닿았다' }), /^주방 불을 켜지 못했어요\. 오늘 행동 한도/)
	assert.equal(ctx.wantsDeep('어제 환풍기 자동화가 왜 안 돌았어?'), true)
	assert.equal(ctx.wantsDeep('주방 불 켜줘'), false)
	assert.equal(ctx.modelFitsProvider('gemini-4-hydrogen', 'api'), false)
	assert.equal(ctx.modelFitsProvider('gpt-6-luna', 'api'), true)
	assert.equal(ctx.modelFitsProvider('gemini-3.5-flash-lite', 'gemini'), true)
	assert.equal(ctx.modelFitsProvider('llama3', 'ollama'), true)
	assert.equal(ctx.claimsUnexecutedControl('주방 불 켜줘', '주방 불을 켰어요.', 0), true)
	assert.equal(ctx.claimsUnexecutedControl('주방 불 켜줘', '주방 불을 켰어요.', 1), false)
	assert.equal(ctx.claimsUnexecutedControl('습도 몇이야?', '습도는 40%예요.', 0), false)
	assert.equal(ctx.claimsUnexecutedControl('주방 하이라이트 꺼줘', '안전 정책상 끌 수 없어요.', 0), false)
})

test('reasoningFor: effort none은 추론 모델에 명시, 옛 모델·off는 생략 / Gemini 4 minimal→low', () => {
	assert.deepEqual(reasoningFor('gpt-6-luna', 'none'), { reasoning: { effort: 'none' } })
	assert.deepEqual(reasoningFor('gpt-6.1-terra', 'low'), { reasoning: { effort: 'low' }, include: ['reasoning.encrypted_content'] })
	assert.equal(reasoningFor('gpt-4o-mini', 'none'), null)
	assert.equal(reasoningFor('gpt-6-luna', 'off'), null)
	assert.equal(reasoningFor('gpt-6-luna', null), null)
	assert.equal(resolveGeminiModelAndThinking('gemini-4-hydrogen', 'minimal').thinkingLevel, 'low')
	assert.equal(resolveGeminiModelAndThinking('gemini-3.5-flash-lite', 'minimal').thinkingLevel, 'minimal')
})

test('runApi: GPT-6.2부터 지시문을 developer 메시지로 맨 앞에, 조기 종료 시 추가 왕복 없음', async () => {
	const prev = process.env.TEST_OPENAI_SPEED_KEY
	process.env.TEST_OPENAI_SPEED_KEY = 'k'
	try {
		const cfg = mergeConfig({ api: { key_env: 'TEST_OPENAI_SPEED_KEY', base_url: 'https://x.invalid/v1', max_tool_calls: 5 } })
		const bodies = []
		const broker = {
			tools: () => [{ type: 'function', name: 'ha_control_device', parameters: { type: 'object', properties: {} } }],
			has: n => n === 'ha_control_device',
			isReadOnly: () => false,
			run: async () => '{"ok":true,"status":"done"}',
		}
		let taken = null
		const r = await runApi({
			cfg, prompt: [{ role: 'user', content: '주방 불 켜줘' }], effort: 'none', timeoutSec: 5, model: 'gpt-6.2-sol',
			runDir: null, toolBroker: broker, instructions: 'SYS', customSchema: { type: 'object' }, includeFileTools: false,
			toolContext: { takeEarlyResult: names => { taken = names; return { speech: '주방 불을 켰어요.', continue_conversation: false } } },
			fetchFn: async (_u, init) => {
				bodies.push(JSON.parse(init.body))
				return { ok: true, status: 200, json: async () => ({ status: 'completed', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, output: [{ type: 'function_call', call_id: 'c1', name: 'ha_control_device', arguments: '{}' }] }) }
			},
		})
		assert.equal(bodies.length, 1, '제어 성공 후 다시 묻지 않는다')
		assert.equal(bodies[0].instructions, undefined)
		assert.deepEqual(bodies[0].input[0], { role: 'developer', content: 'SYS' })
		assert.deepEqual(bodies[0].reasoning, { effort: 'none' })
		assert.deepEqual(taken, ['ha_control_device'])
		assert.equal(r.result.speech, '주방 불을 켰어요.')
		assert.equal(r.early, true)
		assert.equal(r.rounds, 1)
	} finally {
		if (prev === undefined) delete process.env.TEST_OPENAI_SPEED_KEY; else process.env.TEST_OPENAI_SPEED_KEY = prev
	}
})

test('runGemini: 조회 도구 여러 개는 동시에 실행', async () => {
	const prev = process.env.TEST_GEMINI_SPEED_KEY
	process.env.TEST_GEMINI_SPEED_KEY = 'k'
	try {
		const cfg = mergeConfig({ gemini: { key_env: 'TEST_GEMINI_SPEED_KEY' } })
		let active = 0, peak = 0, n = 0
		const broker = {
			tools: () => [{ name: 'ha_get_state', description: '', parameters: { type: 'object', properties: {} } }],
			isReadOnly: () => true,
			run: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 20)); active--; return 'x' },
		}
		const r = await runGemini({
			cfg, prompt: 'p', runDir: null, toolBroker: broker, toolContext: {}, customSchema: { type: 'object' }, includeFileTools: false,
			fetchFn: async () => ({
				ok: true, status: 200,
				text: async () => JSON.stringify(n++ === 0
					? { steps: [{ type: 'function_call', id: 'a', name: 'ha_get_state', arguments: {} }, { type: 'function_call', id: 'b', name: 'ha_get_state', arguments: {} }] }
					: { steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"speech":"ok"}' }] }] }),
			}),
		})
		assert.equal(peak, 2)
		assert.equal(r.rounds, 2)
		assert.equal(r.tool_calls, 2)
	} finally {
		if (prev === undefined) delete process.env.TEST_GEMINI_SPEED_KEY; else process.env.TEST_GEMINI_SPEED_KEY = prev
	}
})

class MockHA extends EventEmitter {
	constructor() {
		super()
		this.connected = true
		this.guard = { allowConfigWrite: false }
		this.map = STATES()
		this.calls = []
	}
	start() {}
	stop() {}
	async call(m) {
		if (m.type === 'get_states') return [...this.map.values()]
		if (m.type === 'repairs/list_issues') return { issues: [] }
		return []
	}
	async callService(d, s, { target } = {}) {
		if (d === 'notify') return
		this.calls.push(`${d}.${s} ${target?.entity_id}`)
		const id = target.entity_id
		if (s === 'turn_on' || s === 'turn_off') this.map.set(id, { ...this.map.get(id), state: s === 'turn_on' ? 'on' : 'off' })
		this.emit('state', { entity_id: id, new_state: this.map.get(id), old_state: null })
	}
	async heartbeat() {}
}

function makeAgent({ assist = {}, brain, llm } = {}) {
	rmSync(TMP, { recursive: true, force: true })
	mkdirSync(P.state, { recursive: true })
	saveControl({ paused: false, send: true })
	writeJson(P.rules, { updated: new Date(T0).toISOString(), rules: [] })
	const ha = new MockHA()
	const cfg = mergeConfig({ ...BASE_CFG, ...(llm ? { llm } : {}), assist: { ...BASE_CFG.assist, ...assist } })
	const agent = new Agent({ cfg, ha, clock: () => T0, brain, canUse: () => true })
	agent.attach()
	ha.emit('ready', [...ha.map.values()])
	return { agent, ha }
}

test('Agent 빠른 경로: 단순 켜기는 LLM 없이 실행하고, 끄면 LLM으로 간다', async () => {
	let brainCalls = 0
	const { agent, ha } = makeAgent({ brain: async () => { brainCalls++; return { result: { speech: '네', continue_conversation: false }, ms: 1, tokens: 1 } } })
	try {
		const r = await agent.handleAssist({ text: '주방 불 켜줘', conversationId: 'c1' })
		assert.equal(r.speech, '주방 불을 켰어요.')
		assert.equal(r.meta.path, 'fast')
		assert.equal(brainCalls, 0)
		assert.deepEqual(ha.calls, ['switch.turn_on switch.kitchen'])
		const again = await agent.handleAssist({ text: '주방 불 켜줘', conversationId: 'c1' })
		assert.equal(again.speech, '주방 불은 이미 켜져 있어요.')
		assert.equal(ha.calls.length, 1)

		agent.cfg.assist.fast_path = false
		await agent.handleAssist({ text: '주방 불 꺼줘', conversationId: 'c2' })
		assert.equal(brainCalls, 1)
	} finally { agent.stop() }
})

test('Agent LLM 경로: 캐시 친화 프롬프트, 조기 종료, 거짓 제어 응답 시 deep 재시도, 모델/프로바이더 불일치 보정', async () => {
	const seen = []
	let mode = 'early'
	const brain = async a => {
		seen.push({ mode: a.mode, model: a.model, effort: a.effort, instructions: a.instructions, prompt: a.prompt })
		if (mode === 'early') {
			await a.toolBroker.run('ha_control_device', JSON.stringify({ entity_id: 'light.bul', service: 'turn_on', service_data_json: null, reason: '요청', requested: true, speech_if_success: '화장실 불을 켰어요.' }), a.toolContext)
			const early = a.toolContext.takeEarlyResult(['ha_control_device'])
			return { result: early ?? { speech: '다시 물음', continue_conversation: false }, ms: 1, tokens: 1, rounds: 1, early: Boolean(early) }
		}
		if (mode === 'lie' && a.model === 'gpt-fast') return { result: { speech: '주방 불을 껐어요.', continue_conversation: false }, ms: 1, tokens: 1, rounds: 1 }
		return { result: { speech: '정상 답', continue_conversation: false }, ms: 1, tokens: 1, rounds: 2 }
	}
	const { agent, ha } = makeAgent({
		brain,
		llm: { routes: { assist: 'gemini', default: 'codex' } },
		assist: { fast_path: false, model: 'gemini-x-fast', effort: 'minimal', deep: { model: 'gemini-x-deep', effort: 'low' } },
	})
	try {
		const r = await agent.handleAssist({ text: '화장실 불 좀 켜줄 수 있어?', conversationId: 'c3' })
		assert.equal(r.speech, '화장실 불을 켰어요.')
		assert.equal(r.meta.path, 'early')
		assert.deepEqual(ha.calls, ['light.turn_on light.bul'])
		const first = seen[0]
		assert.equal(first.model, 'gemini-x-fast')
		assert.equal(first.effort, 'minimal')
		assert.doesNotMatch(first.instructions, /2026-11-20|18\.6|=off/, '시각·상태는 시스템 지시에 넣지 않는다')
		assert.match(first.instructions, /light\.bul \| 불 \| - \| 승인.*별칭: 화장실 불/)
		const last = first.prompt.at(-1)
		assert.equal(last.role, 'user')
		assert.match(last.content, /^\[현재 상황\][\s\S]*light\.bul=off[\s\S]*\[사용자 말\]\n화장실 불 좀 켜줄 수 있어\?$/)
		assert.equal(agent.sessions.history('c3', T0)[0].text, '화장실 불 좀 켜줄 수 있어?', '대화 기록에는 원문만')

		// 복잡한 요청은 deep 모델로 바로
		mode = 'normal'
		seen.length = 0
		await agent.handleAssist({ text: '어제 환풍기 자동화가 왜 안 돌았어?', conversationId: 'c4' })
		assert.deepEqual(seen.map(s => s.model), ['gemini-x-deep'])

		// fast 모델이 도구 없이 "껐어요"라고 하면 버리고 deep으로 다시
		mode = 'lie'
		agent.cfg.assist.model = 'gpt-fast'
		agent.cfg.llm.routes.assist = 'api'
		agent.cfg.assist.deep = { route: 'gemini', model: 'gemini-x-deep', effort: 'low' }
		seen.length = 0
		const lie = await agent.handleAssist({ text: '주방 불 꺼줘', conversationId: 'c5' })
		assert.deepEqual(seen.map(s => [s.mode, s.model]), [['api', 'gpt-fast'], ['gemini', 'gemini-x-deep']])
		assert.equal(lie.speech, '정상 답')

		// api 라우트에 gemini 모델 이름이 들어가면 무시하고 api 기본 모델을 쓴다
		mode = 'normal'
		agent.cfg.llm.routes.assist = 'api'
		agent.cfg.assist.model = 'gemini-x-fast'
		agent.cfg.assist.deep = null
		seen.length = 0
		await agent.handleAssist({ text: '안녕', conversationId: 'c6' })
		assert.equal(seen[0].mode, 'api')
		assert.equal(seen[0].model, brainSettings(agent.cfg, 'api').model)
		assert.notEqual(seen[0].model, 'gemini-x-fast')
	} finally { agent.stop() }
})
