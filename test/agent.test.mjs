// 통합 시험: 가짜 HA와 가짜 Codex로 본체(Agent)의 대기열·보류·알림·행동 흐름을 돌려 본다.
// 실제 state/는 건드리지 않는다(HAAGENT_DATA_DIR로 임시 폴더를 쓴다). 진짜 HA나 Codex에는 접속하지 않는다.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'

const DATA = mkdtempSync(join(tmpdir(), 'haagent-test-'))
process.env.HAAGENT_DATA_DIR = DATA
after(() => rmSync(DATA, { recursive: true, force: true }))

const { Agent } = await import('../src/agent.mjs')
const { checkMessage } = await import('../src/ha.mjs')
const { PUBLISH_SERVICE } = await import('../src/agent.mjs')
const { mergeConfig, saveControl } = await import('../src/config.mjs')
const { P, readJson, readJsonl, writeJson, appendJsonl, latestBy } = await import('../src/util.mjs')
const { CHANNELS } = await import('../src/notify.mjs')

const MIN = 60000
const T0 = Date.parse('2026-11-11T15:20:00+09:00') // 활동 시간, 정각 점검 창(매시 0~10분) 밖
const st = (entity_id, state, at = T0, attributes = {}) => ({ entity_id, state, attributes: { friendly_name: entity_id, ...attributes }, last_changed: new Date(at).toISOString(), last_updated: new Date(at).toISOString() })
const rule = over => ({ id: 'door_open_long', description: '현관문 10분 이상 열림', entity_id: 'binary_sensor.door', attribute: null, op: 'eq', value: 'on', for_minutes: 10, cooldown_minutes: 30, priority: 'normal', also: [], hour_from: null, hour_to: null, ...over })
const answer = over => ({ summary: '요약', notifications: [], rule_changes: { upsert: [], delete: [] }, next_wakes: [], memory: { mode: 'keep', text: '' }, info_requests: [], actions: [], ...over })
const note = over => ({ kind: 'alert', level: 'normal', title: '현관문이 열려 있어요', message: '10분 넘게 열려 있어요.', related_rule_ids: ['door_open_long'], ...over })
// 지침에도 "[주간 분석]"이라는 말이 있으니 깨운 이유 줄로 가린다.
const WEEKLY_REASON = /^\s+\d+\. \[주간 분석\]/m
const flush = () => new Promise(r => setImmediate(r))

class FakeHA extends EventEmitter {
	constructor(cfg, list) {
		super()
		this.connected = true
		this.map = new Map(list.map(s => [s.entity_id, s]))
		this.guard = { services: new Set(cfg.weekly.publish ? [PUBLISH_SERVICE] : []), actionEntities: new Set(cfg.actions.enabled ? [...cfg.actions.auto, ...cfg.actions.confirm] : []) }
		this.sent = [] // 휴대폰으로 간 알림
		this.calls = [] // 기기 서비스 호출
		this.posted = [] // HA 알림 목록에 올린 글(주간 보고서)
		this.hist = null // history()가 돌려줄 기록. null이면 엔티티마다 'on' 한 줄
		this.failNotify = false
		this.info = []
		this.logRows = [] // 활동 기록(logbook)으로 돌려줄 줄
	}
	start() {}
	stop() {}
	set(id, state, at) {
		const old = this.map.get(id), n = st(id, state, at)
		this.map.set(id, n)
		this.emit('state', { entity_id: id, old_state: old, new_state: n })
	}
	async call(msg) {
		if (msg.type === 'get_states') return [...this.map.values()]
		if (msg.type === 'repairs/list_issues') return { issues: [] }
		if (/registry\/list$|system_log/.test(msg.type)) return []
		throw new Error(`가짜 HA가 모르는 명령: ${msg.type}`)
	}
	async callService(domain, service, { data = {}, target } = {}) {
		if (domain === 'notify') {
			if (this.failNotify) throw new Error('HA 연결 없음')
			this.sent.push(data)
			return
		}
		if (domain === 'weather' || domain === 'calendar') return { response: {} }
		// 기기 서비스는 진짜 연결과 같은 검사를 거친다.
		const bad = checkMessage({ type: 'call_service', domain, service, service_data: data, target }, this.guard)
		if (bad) throw new Error(bad)
		if (`${domain}.${service}` === PUBLISH_SERVICE) return void this.posted.push(data)
		this.calls.push(`${target.entity_id} ${service}`)
		this.set(target.entity_id, service === 'turn_on' ? 'on' : 'off', Date.now())
	}
	async heartbeat() {}
	async history(ids, hours) { this.info.push(['history', ids, hours]); return this.hist ?? Object.fromEntries(ids.map(id => [id, [{ lu: T0 / 1000, s: 'on' }]])) }
	async statistics(ids, hours) { this.info.push(['statistics', ids, hours]); return {} }
	async logbook(ids, hours) { this.info.push(['logbook', ids, hours]); return this.logRows.filter(r => ids.includes(r.entity_id)) }
}

// 시험마다 임시 폴더를 비우고 새 Agent를 만든다. 시계는 t.now를 고쳐 움직인다.
// canUse: 다른 판단 방식으로 넘어갈 수 있는지. 기본은 못 넘어감(이 컴퓨터에 API 키가 있든 없든 시험이 같게 돈다).
function setup({ rules = [rule()], states, cfg = {}, brain, clean = true, files = {}, canUse = () => false } = {}) {
	if (clean) {
		rmSync(DATA, { recursive: true, force: true })
		mkdirSync(P.state, { recursive: true })
		saveControl({ paused: false, send: true })
		if (rules) writeJson(P.rules, { updated: new Date(T0).toISOString(), rules })
		for (const [path, data] of Object.entries(files)) writeJson(path, data)
	}
	const t = { now: T0, prompts: [], oob: [] }
	const full = mergeConfig({ heartbeat: { enabled: false }, ...cfg, actions: { verify_seconds: 1, ...cfg.actions } })
	const ha = new FakeHA(full, states ?? [st('binary_sensor.door', 'off', T0 - 60 * MIN), st('light.a', 'on', T0 - 60 * MIN), st('switch.b', 'on', T0 - 60 * MIN), st('lock.door', 'locked', T0 - 60 * MIN)])
	t.brain = brain ?? (async () => ({ result: answer(), ms: 1, tokens: 10 }))
	const agent = new Agent({ cfg: full, ha, clock: () => t.now, brain: async a => { t.prompts.push(a.prompt); return t.brain(a) }, oob: async (_cfg, title) => { t.oob.push(title); return true }, canUse })
	agent.attach()
	ha.emit('ready', [...ha.map.values()])
	return { agent, ha, t }
}
// 문을 열고 11분 뒤 규칙이 발동해 대기열에 들어가게 한다. 그 뒤 61초를 더 보내면 판단할 차례가 된다.
async function openDoor({ agent, ha, t }) {
	ha.set('binary_sensor.door', 'on', t.now)
	t.now += 11 * MIN
	await agent.tick()
	t.now += 61000
}

test('규칙 발동 → 1분 모은 뒤 판단 → 알림 발송, 원문 보관', async () => {
	const x = setup({ brain: async () => ({ result: answer({ notifications: [note()] }), ms: 1, tokens: 10 }) })
	await openDoor(x)
	assert.equal(x.t.prompts.length, 0, '모으는 1분 동안은 부르지 않음')
	assert.equal(readJson(P.queue, {}).queue.length, 1, '대기열이 파일에 남음')
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 1)
	assert.match(x.t.prompts[0], /\[규칙 발동\] door_open_long/)
	assert.equal(x.ha.sent.length, 1)
	assert.equal(x.ha.sent[0].data.tag, 'haagent-door_open_long')
	assert.deepEqual(readJson(P.queue, {}), { queue: [], inflight: [] })
	assert.equal(readJsonl(P.decisions).length, 1)
	const run = readdirSync(P.runs)
	assert.equal(run.length, 1)
	for (const f of ['input.json', 'prompt-1.md', 'answer-1.json', 'files/states.json']) assert.ok(existsSync(join(P.runs, run[0], f)), f)
	assert.equal(readJson(join(P.run, 'states.json'), []).length, 4)
})

test('판단 실패: normal 규칙 발동도 다시 시도하고, 끝내 안 되면 규칙 내용을 그대로 알린다', async () => {
	const x = setup({ brain: async () => { throw new Error('codex 종료 코드 1') } })
	await openDoor(x)
	await x.agent.tick()
	let q = readJson(P.queue, {}).queue
	assert.equal(q.length, 1, '실패해도 대기열에 남음')
	assert.equal(q[0].attempts, 1)
	assert.equal(x.ha.sent.length, 0)
	for (let i = 0; i < 2; i++) { x.t.now += 30 * MIN; await x.agent.tick() }
	assert.equal(x.t.prompts.length, 3, '모두 3번 시도')
	assert.equal(readJson(P.queue, {}).queue.length, 0)
	assert.equal(x.ha.sent.filter(p => p.data.tag === 'haagent-door_open_long').length, 1, '마지막에 규칙 내용을 그대로 보냄')
	assert.match(x.ha.sent[0].message, /판단이 실패해/)
	assert.equal(x.ha.sent.length, 2, '3번 연속 실패 안내 1개')
	assert.match(x.ha.sent[1].message, /codex 종료 코드 1/)
})

test('밤사이 보류분: 판단이 실패하면 남고, 성공한 뒤에만 지워진다', async () => {
	const heldItem = { type: 'rule', rule_id: 'door_open_long', description: '현관문 10분 이상 열림', entity_id: 'binary_sensor.door', value: 'on', since: T0 - 600 * MIN, at: T0 - 600 * MIN }
	const x = setup({ files: { [P.held]: [heldItem] }, brain: async () => { throw new Error('일시 오류') } })
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 1)
	assert.match(x.t.prompts[0], /밤사이 보류된 것/)
	assert.equal(readJson(P.held, []).length, 1, '실패 뒤에도 보류분이 남음')
	x.t.brain = async () => ({ result: answer({ notifications: [note()] }), ms: 1, tokens: 10 })
	x.t.now += MIN
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 1, '실패 뒤에는 간격을 늘려 기다림')
	x.t.now += 7 * MIN
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 2)
	assert.match(x.t.prompts[1], /밤사이 보류된 것/)
	assert.deepEqual(readJson(P.held, []), [])
	assert.equal(x.ha.sent.length, 1)
})

test('재시작: 대기 중이던 깨움과 돌던 판단이 이어진다', async () => {
	const x = setup()
	await openDoor(x) // 대기열에 규칙 발동 1건, 아직 판단 전
	const y = setup({ clean: false })
	assert.equal(y.agent.queue.length, 1)
	assert.equal(y.agent.queue[0].rule_id, 'door_open_long')
	// 판단 도중 꺼진 경우(inflight): 시도 횟수를 올려 다시 넣고, 한도를 넘긴 것은 버린다.
	writeJson(P.queue, { queue: [], inflight: [{ type: 'rule', rule_id: 'a', attempts: 0 }, { type: 'manual', reason: 'x', attempts: 1 }, { type: 'rule', rule_id: 'b', attempts: 2 }] })
	const z = setup({ clean: false })
	assert.deepEqual(z.agent.queue.map(r => [r.rule_id ?? r.type, r.attempts]), [['a', 1]])
})

test('urgent 규칙: Codex를 기다리지 않고 바로 알리고, 판단이 실패해도 같은 알림을 또 보내지 않는다', async () => {
	let release
	const gate = new Promise(r => { release = r })
	const x = setup({ rules: [rule({ priority: 'urgent', for_minutes: 0 })], cfg: { escalation: { enabled: false } }, brain: async () => { await gate; throw new Error('실패') } })
	x.ha.set('binary_sensor.door', 'on', x.t.now)
	await flush()
	assert.equal(x.ha.sent.length, 1, '발동 즉시 알림')
	assert.equal(x.ha.sent[0].data.channel, '집 비서 긴급')
	assert.equal(x.ha.sent[0].data.tag, 'haagent-door_open_long')
	const run = x.agent.tick()
	await flush()
	assert.match(x.t.prompts[0], /이미 긴급 알림으로 나갔다/)
	release()
	await run
	for (let i = 0; i < 2; i++) { x.t.now += 30 * MIN; await x.agent.tick() }
	assert.equal(x.t.prompts.length, 3)
	assert.equal(x.ha.sent.filter(p => p.data.tag === 'haagent-door_open_long').length, 1, '규칙 알림은 한 번만')
})

test('알림 발송 실패: 다시 보낼 목록에 남고 연결이 돌아오면 보낸다. urgent는 비상 길로도 보낸다', async () => {
	const x = setup({ brain: async () => ({ result: answer({ notifications: [note(), note({ level: 'urgent', title: '물이 새요', related_rule_ids: [] }), note({ kind: 'hourly_summary', level: 'quiet', title: '요약', related_rule_ids: [] })] }), ms: 1, tokens: 1 }) })
	x.ha.failNotify = true
	await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	await flush()
	assert.equal(x.ha.sent.length, 0)
	assert.equal(readJson(P.outbox, []).length, 3, '요약도 다시 보낼 목록에 남음')
	assert.deepEqual(x.t.oob, ['물이 새요'])
	assert.deepEqual(latestBy(readJsonl(P.notifications), 'nid').map(n => n.status), ['queued', 'queued', 'queued'])
	x.ha.failNotify = false
	x.t.now += 2 * MIN
	await x.agent.tick()
	assert.equal(x.ha.sent.length, 3)
	assert.deepEqual(readJson(P.outbox, []), [])
	assert.deepEqual(latestBy(readJsonl(P.notifications), 'nid').map(n => n.status), ['sent', 'sent', 'sent'])
	const c = readJson(P.counters, {})
	assert.deepEqual([c.alerts, c.summaries], [2, 1], '다시 보낸 요약은 요약 횟수로 센다')
})

test('정각 요약 발송 실패: 1시간까지 다시 보내고, 새 요약이 나오면 낡은 것은 버린다', async () => {
	let title = '🌙 하루 마감'
	const x = setup({ brain: async () => ({ result: answer({ notifications: [note({ kind: 'hourly_summary', level: 'quiet', title, related_rule_ids: [] })] }), ms: 1, tokens: 1 }) })
	const statuses = () => latestBy(readJsonl(P.notifications), 'nid').map(n => `${n.title}:${n.status}`)
	x.ha.failNotify = true
	await x.agent.cycle([{ type: 'manual', reason: '1' }])
	title = '☔ 새 요약'
	await x.agent.cycle([{ type: 'manual', reason: '2' }])
	assert.deepEqual(readJson(P.outbox, []).map(o => o.n.title), ['☔ 새 요약'], '못 보낸 요약끼리는 새것만 남음')
	x.ha.failNotify = false
	x.t.now += 2 * MIN
	await x.agent.tick()
	assert.deepEqual(x.ha.sent.map(p => p.title), ['☔ 새 요약'])
	assert.deepEqual(statuses(), ['🌙 하루 마감:replaced', '☔ 새 요약:sent'])
	// 다시 보내려던 요약이 있어도 새 요약이 바로 나가면 낡은 것은 버린다(같은 자리를 덮어써 새것을 가리지 않게).
	x.ha.failNotify = true
	title = '낡은 요약'
	await x.agent.cycle([{ type: 'manual', reason: '3' }])
	x.ha.failNotify = false
	title = '더 새 요약'
	await x.agent.cycle([{ type: 'manual', reason: '4' }])
	assert.deepEqual(readJson(P.outbox, []), [])
	x.t.now += 2 * MIN
	await x.agent.tick()
	assert.deepEqual(x.ha.sent.map(p => p.title), ['☔ 새 요약', '더 새 요약'])
	// 1시간 넘게 못 보냈으면 낡은 내용이니 버린다.
	x.ha.failNotify = true
	title = '늦은 요약'
	await x.agent.cycle([{ type: 'manual', reason: '5' }])
	x.ha.failNotify = false
	x.t.now += 61 * MIN
	await x.agent.tick()
	assert.ok(!x.ha.sent.some(p => p.title === '늦은 요약'))
	assert.deepEqual(readJson(P.outbox, []), [])
	assert.equal(statuses().at(-1), '늦은 요약:expired')
})

test('판단 중 HA 연결이 끊기면: 받다 만 자료로 판단하지 않고 다시 연결된 뒤 판단한다(시도 횟수·보류분 그대로)', async () => {
	const held = [{ type: 'rule', rule_id: 'door_open_long', description: '현관문 10분 이상 열림', entity_id: 'binary_sensor.door', value: 'on', since: T0 - 30 * MIN, at: T0 - 30 * MIN }]
	const x = setup({ files: { [P.held]: held } })
	const real = x.ha.callService.bind(x.ha)
	let drop = true
	// 날씨를 받는 사이 연결이 끊긴다(2026-11-14 23시와 같은 모양: 대기 중이던 호출이 '응답 없음'으로 거절됨).
	x.ha.callService = async (d, s, o) => { if (d === 'weather' && drop) { x.ha.connected = false; throw new Error('응답 없음') } return real(d, s, o) }
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 0, 'Codex를 부르지 않음')
	let q = readJson(P.queue, {}).queue
	assert.deepEqual(q.map(r => [r.type, r.defers, r.attempts]), [['held', 1, undefined]], '실패가 아니라 미룸: 시도 횟수는 그대로')
	assert.equal(readJson(P.held, []).length, 1, '보류분은 지우지 않음')
	assert.equal(readJsonl(P.decisions).at(-1).deferred, true)
	assert.equal(readJson(P.counters, {}).runs, 0, '판단 횟수로 세지 않음')
	x.t.now += 4 * MIN
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 0, '끊긴 동안은 판단하지 않음')
	drop = false
	x.ha.connected = true
	x.t.now += MIN
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 1, '다시 연결되면 판단')
	assert.match(x.t.prompts[0], /밤사이 보류된 것/)
	assert.doesNotMatch(x.t.prompts[0], /날씨를 가져오지 못함/)
	assert.deepEqual(readJson(P.held, []), [], '판단이 끝난 뒤에 보류분을 지움')
	// 연결이 계속 흔들려도 끝없이 미루지는 않는다: 세 번 미룬 뒤에는 받은 자료로 판단한다.
	const y = setup({ clean: false })
	const realY = y.ha.callService.bind(y.ha)
	y.ha.callService = async (d, s, o) => { if (d === 'weather') { y.ha.connected = false; throw new Error('응답 없음') } return realY(d, s, o) }
	mkdirSync(P.inbox, { recursive: true })
	writeFileSync(join(P.inbox, '1.json'), JSON.stringify({ cmd: 'wake', reason: '시험' }))
	for (let i = 0; i < 4; i++) {
		y.ha.connected = true
		y.t.now += 4 * MIN
		await y.agent.tick()
	}
	assert.equal(y.t.prompts.length, 1, '세 번 미룬 뒤 네 번째에 판단')
	assert.match(y.t.prompts[0], /날씨를 가져오지 못함/)
	assert.deepEqual(readJsonl(P.decisions).slice(-4).map(d => !!d.deferred), [true, true, true, false])
})

test('heartbeat: 10분 넘게 끊겼다 돌아오면 HA 경고와 같은 tag로 다시 연결됐다고 알린다(재시작해도)', async () => {
	const x = setup({ cfg: { heartbeat: { enabled: true } } })
	const recovered = list => list.filter(p => p.data.tag === 'haagent-heartbeat')
	await x.agent.tick()
	await flush()
	assert.equal(readJson(P.runtime, {}).last_beat_ok, T0, '신호가 닿은 시각을 남김')
	x.t.now += 5 * MIN
	await x.agent.tick()
	await flush()
	assert.equal(recovered(x.ha.sent).length, 0, '짧은 사이에는 알리지 않음')
	x.ha.connected = false
	x.t.now += 15 * MIN
	await x.agent.tick()
	x.ha.connected = true
	x.t.now += MIN
	await x.agent.tick()
	await flush()
	const s = recovered(x.ha.sent)
	assert.equal(s.length, 1)
	assert.match(s[0].message, /16분 동안/)
	assert.equal(s[0].data.channel, CHANNELS.quiet.channel, '소리 없이')
	assert.equal(s[0].data.alert_once, true)
	assert.equal(latestBy(readJsonl(P.notifications), 'nid').at(-1).kind, 'system', '다음 판단이 끊김을 알 수 있게 기록')
	x.agent.stop()
	// 서버가 꺼졌다 켜진 경우: 재시작한 뒤 첫 신호에서 알린다.
	const y = setup({ clean: false, cfg: { heartbeat: { enabled: true } } })
	y.t.now = x.t.now + 30 * MIN
	await y.agent.tick()
	await flush()
	assert.equal(recovered(y.ha.sent).length, 1)
	assert.match(recovered(y.ha.sent)[0].message, /30분 동안/)
	// 알림 발송을 꺼 둔 시험 모드에서는 보내지 않는다.
	saveControl({ paused: false, send: false })
	y.t.now += 30 * MIN
	await y.agent.tick()
	await flush()
	assert.equal(recovered(y.ha.sent).length, 1)
})

test('정각 요약의 [줄여 줘]: 피드백으로 남고 같은 자리에 결과 문구가 뜨며, 다음 판단과 지표에 보인다', async () => {
	const x = setup({ brain: async () => ({ result: answer({ notifications: [note({ kind: 'hourly_summary', level: 'quiet', title: '☔ 12시 비 예보', message: '비는 오후 1시까지 오겠어요.', related_rule_ids: [] })] }), ms: 1, tokens: 1 }) })
	await x.agent.cycle([{ type: 'hourly', hour: 15 }])
	const less = x.ha.sent[0].data.actions.find(a => a.title === '줄여 줘')
	assert.ok(less, '요약에 [줄여 줘] 버튼')
	x.ha.emit('action', { action: less.action })
	await flush()
	await flush()
	const fb = readJsonl(P.feedback)
	assert.deepEqual(fb.map(f => [f.kind, f.title, f.message]), [['less', '☔ 12시 비 예보', '비는 오후 1시까지 오겠어요.']])
	assert.equal(x.ha.sent[1].data.tag, 'haagent-summary', '같은 자리를 결과 문구로 바꿈')
	assert.match(x.ha.sent[1].message, /줄일게요/)
	x.ha.emit('action', { action: less.action })
	await flush()
	assert.equal(readJsonl(P.feedback).length, 1, '두 번 눌러도 한 번만 기록')
	x.t.now += 10 * MIN
	await x.agent.cycle([{ type: 'reflection', hour: 23 }])
	const p = x.t.prompts.at(-1)
	assert.match(p, /🔽 줄여 줘 ← 알림 "☔ 12시 비 예보" \(그 요약: 비는 오후 1시까지 오겠어요\.\)/)
	assert.match(p, /summary_less=1/)
})

test('00시 하루 돌아보기: 전날 알림이 보이고, 24시 요약은 조용한 시간이어도 나간다', async () => {
	const x = setup({ brain: async () => ({ result: answer({ notifications: [note({ kind: 'hourly_summary', level: 'quiet', title: '하루 마감', related_rule_ids: [] }), note({ title: '보류될 알림', related_rule_ids: [] })] }), ms: 1, tokens: 1 }) })
	const midnight = Date.parse('2026-11-12T00:00:20+09:00')
	appendJsonl(P.notifications, { nid: 'old1', ts: new Date(midnight - 30 * MIN).toISOString(), kind: 'alert', level: 'normal', title: '어젯밤 보낸 알림', message: 'm', related_rule_ids: [], tag: 'haagent-old1', status: 'sent' })
	await x.agent.tick() // 11일 낮에 한 번 돌아 그날의 횟수 기록이 생긴 상태
	x.t.now = midnight
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 1)
	assert.match(x.t.prompts[0], /\[하루 돌아보기 \+ 정각 점검\] 24시/)
	assert.match(x.t.prompts[0], /어젯밤 보낸 알림/)
	assert.match(x.t.prompts[0], /지난 7일 지표/)
	assert.deepEqual(x.ha.sent.map(p => p.title), ['하루 마감'])
	assert.equal(readJson(P.held, []).length, 1, '요약이 아닌 알림은 아침까지 보류')
	assert.ok(existsSync(join(P.daily, '2026-11-11.json')), '날짜가 바뀌면 전날 하루 요약을 남김')
})

test('정각 점검: 달라진 것이 없으면 Codex를 부르지 않는다', async () => {
	const x = setup()
	await x.agent.cycle([{ type: 'hourly', hour: 16 }])
	x.t.now += 60 * MIN
	const skipped = await x.agent.cycle([{ type: 'hourly', hour: 17 }])
	assert.equal(skipped.skipped, true)
	assert.equal(x.t.prompts.length, 1)
	x.t.now += 60 * MIN
	x.ha.set('light.a', 'off', x.t.now - MIN)
	await x.agent.cycle([{ type: 'hourly', hour: 18 }])
	assert.equal(x.t.prompts.length, 2, '집 상태가 바뀌면 부른다')
	x.t.now += 60 * MIN
	assert.equal((await x.agent.cycle([{ type: 'hourly', hour: 24 }])).skipped, undefined, '24시 요약은 항상')
})

test('추가 자료 요청: 종류별로 받아 다시 묻고, 정해진 횟수에서 멈춘다', async () => {
	const x = setup({ brain: async () => ({ result: answer({ info_requests: [{ kind: 'logbook', entity_ids: ['light.a', 'light.none'], hours: 24 }, { kind: 'statistics', entity_ids: ['switch.b'], hours: 720 }] }), ms: 1, tokens: 5 }) })
	const e = await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.equal(e.rounds, 3, 'max_rounds에서 멈춤')
	assert.equal(e.tokens, 15)
	assert.deepEqual(x.ha.info.slice(0, 2), [['logbook', ['light.a'], 24], ['statistics', ['switch.b'], 720]])
	assert.match(x.t.prompts[1], /run\/info-1-logbook\.json/)
	assert.match(x.t.prompts[2], /더는 요청할 수 없으니/)
	assert.ok(existsSync(join(P.run, 'info-2-statistics.json')))
})

test('주간 분석: 정한 요일·시각에 혼자 돌고, 7일 자료를 써 주고, 보고서를 남기고 알린다', async () => {
	const REPORT = '# 주간 분석 2026-11-15\n\n## 한눈에\n- 귀가 조명이 켠 불을 곧 끄셨어요.'
	const x = setup({
		states: [st('automation.gwiga', 'on', T0, { friendly_name: '귀가 조명' }), st('automation.never', 'on', T0, { friendly_name: '안 도는 자동화' }), st('light.a', 'off', T0), st('binary_sensor.door', 'off', T0)],
		brain: async a => ({ result: answer(WEEKLY_REASON.test(a.prompt) ? { summary: '귀가 조명 조건을 손볼 만해요.', report: REPORT } : { report: '엉뚱한 때의 보고서' }), ms: 1, tokens: 1 }),
	})
	const sun = Date.parse('2026-11-15T21:00:20+09:00'), sec = t => t / 1000
	x.ha.logRows = [
		{ entity_id: 'automation.gwiga', name: '귀가 조명', message: "triggered by state of person.x", source: 'state of person.x', when: sec(sun - 50 * 60 * MIN) },
		{ entity_id: 'automation.gwiga', name: '귀가 조명', message: "triggered by state of person.x", source: 'state of person.x', when: sec(sun - 26 * 60 * MIN) },
		{ entity_id: 'automation.gwiga', state: 'off', when: sec(sun - 25 * 60 * MIN) },
		{ entity_id: 'light.a', state: 'off', when: sec(sun - 60 * 60 * MIN) },
		{ entity_id: 'light.a', state: 'on', when: sec(sun - 26 * 60 * MIN), context_event_type: 'automation_triggered', context_domain: 'automation', context_name: '귀가 조명', context_entity_id: 'automation.gwiga', context_source: 'state of person.x' },
		{ entity_id: 'light.a', state: 'off', when: sec(sun - 26 * 60 * MIN + 3 * MIN) },
	]
	x.t.now = sun
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 1, '같은 시각의 정각 점검부터 한다')
	assert.match(x.t.prompts[0], /\[정각 점검\] 21시/)
	assert.doesNotMatch(x.t.prompts[0], WEEKLY_REASON)
	assert.equal(existsSync(P.weekly), false, '주간 분석이 아닌 깨움의 보고서는 받지 않는다')
	assert.match(JSON.stringify(readJson(P.rejected, [])), /weekly/)
	assert.deepEqual(readJson(P.queue, {}).queue.map(r => r.type), ['weekly'], '주간 분석은 대기열에 남아 다음 차례를 기다린다')
	x.t.now += 4 * MIN
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 2)
	assert.match(x.t.prompts[1], WEEKLY_REASON)
	assert.doesNotMatch(x.t.prompts[1], /\[정각 점검\] 21시/)
	for (const s of ['run/weekly-automations.json', 'run/weekly-devices.json', '지난 7일 지표']) assert.ok(x.t.prompts[1].includes(s), s)
	assert.deepEqual(x.ha.info.slice(-2).map(i => [i[0], i[2]]), [['logbook', 168], ['logbook', 168]])
	const autos = readJson(join(P.run, 'weekly-automations.json'), null)
	assert.deepEqual(autos.automations.map(a => [a.id, a.runs]), [['automation.gwiga', 2], ['automation.never', 0]])
	assert.deepEqual(autos.automations[0].triggers, { 'state of person.x': 2 })
	const light = readJson(join(P.run, 'weekly-devices.json'), null).devices.find(d => d.id === 'light.a')
	assert.equal(light.reverted.length, 1)
	assert.equal(light.reverted[0].undone_after_min, 3)
	assert.equal(readFileSync(join(P.weekly, '2026-11-15.md'), 'utf8'), REPORT + '\n')
	assert.equal(x.ha.sent.at(-1).title.includes('주간 자동화 분석'), true, '알림을 안 냈으면 기본 알림을 보낸다')
	assert.match(x.ha.sent.at(-1).message, /귀가 조명 조건을 손볼 만해요/)
	assert.equal(readJsonl(P.decisions).at(-1).applied.report, '2026-11-15.md')
	assert.deepEqual(x.ha.posted.map(d => [d.notification_id, d.message]), [['haagent_weekly', REPORT]], '전문을 HA 알림 목록에 올린다')
	assert.match(x.ha.sent.at(-1).message, /HA 앱의 알림/)
	assert.equal(readJsonl(P.decisions).at(-1).applied.published, true)
	const run = readdirSync(P.runs).at(-1)
	assert.ok(existsSync(join(P.runs, run, 'files/weekly-automations.json')), '다시 돌려볼 수 있게 자료도 보관')
	// 같은 날에는 다시 돌지 않고, 다음 판단부터는 지난 보고서를 볼 수 있다.
	x.t.now += 30 * MIN
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 2)
	await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.match(x.t.prompts[2], /run\/weekly-last-report\.md: 지난 주간 분석 보고서 \(2026-11-15\)/)
	assert.equal(readFileSync(join(P.run, 'weekly-last-report.md'), 'utf8'), REPORT + '\n')
})

test('주간 분석: 보고서 없이 끝나면 실패로 보고 다시 시도한다. 명령으로도 깨울 수 있다', async () => {
	const x = setup()
	mkdirSync(P.inbox, { recursive: true })
	writeFileSync(join(P.inbox, '1.json'), JSON.stringify({ cmd: 'weekly' }))
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 1)
	assert.match(x.t.prompts[0], WEEKLY_REASON)
	assert.match(readJsonl(P.decisions).at(-1).error, /report가 비어 있음/)
	const q = readJson(P.queue, {}).queue
	assert.deepEqual(q.map(r => [r.type, r.attempts]), [['weekly', 1]])
	assert.equal(x.ha.sent.length, 0)
})

test('규칙·메모가 바뀌면 직전 판이 남고, 되돌릴 수 있다', async () => {
	const x = setup({ brain: async () => ({ result: answer({ rule_changes: { upsert: [], delete: ['door_open_long'] }, memory: { mode: 'replace', text: '새 메모' } }), ms: 1, tokens: 1 }) })
	writeFileSync(P.memory, '예전 메모\n')
	const e = await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.deepEqual(e.applied.deleted, ['door_open_long'])
	const snaps = readdirSync(P.history)
	assert.equal(snaps.filter(n => n.startsWith('rules-')).length, 1)
	assert.equal(snaps.filter(n => n.startsWith('memory-')).length, 1)
	mkdirSync(P.inbox, { recursive: true })
	writeJson(join(P.inbox, '1.json'), { cmd: 'restore', file: snaps.find(n => n.startsWith('rules-')) })
	x.t.now += MIN
	await x.agent.tick()
	assert.deepEqual(readJson(P.rules, {}).rules.map(r => r.id), ['door_open_long'])
	assert.equal(x.agent.engine.rules.length, 1)
})

test('행동: 권한이 꺼져 있으면 아무것도 움직이지 않는다', async () => {
	const x = setup({ brain: async () => ({ result: answer({ actions: [{ entity_id: 'light.a', action: 'turn_off', reason: '빈 집' }] }), ms: 1, tokens: 1 }) })
	const e = await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.deepEqual(x.ha.calls, [])
	assert.match(e.applied.rejected[0].error, /행동 권한이 꺼져/)
	assert.match(x.t.prompts[0], /없음\. actions는 빈 배열/)
})

test('행동: 스스로 실행(확인·되돌리기), 승인 뒤 실행, 목록 밖은 거절', async () => {
	const acts = [{ entity_id: 'light.a', action: 'turn_off', reason: '아무도 없는데 켜져 있어요.' }, { entity_id: 'lock.door', action: 'turn_off', reason: 'x' }, { entity_id: 'switch.b', action: 'turn_off', reason: '세 시간째 켜져 있어요.' }]
	const x = setup({ cfg: { actions: { enabled: true, auto: ['light.a'], confirm: ['switch.b'] } }, brain: async () => ({ result: answer({ actions: acts }), ms: 1, tokens: 1 }) })
	const e = await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.match(x.t.prompts[0], /light\.a .* 스스로 실행/)
	assert.deepEqual(x.ha.calls, ['light.a turn_off'], '승인이 필요한 것은 아직 실행하지 않음')
	assert.deepEqual(e.applied.actions, ['done: light.a turn_off', 'pending: switch.b turn_off'])
	assert.match(e.applied.rejected[0].error, /허용 목록에 없는/)
	const [done, ask] = x.ha.sent
	assert.match(done.title, /껐어요/)
	assert.match(done.data.actions[0].action, /^HAAGENT_UNDO_/)
	assert.deepEqual(ask.data.actions.map(a => a.title), ['실행', '아니요'])
	// [실행]을 누르면 그때 실행한다
	x.ha.emit('action', { action: ask.data.actions[0].action })
	await flush(); await flush()
	assert.deepEqual(x.ha.calls, ['light.a turn_off', 'switch.b turn_off'])
	assert.equal(x.ha.sent.at(-1).data.tag, ask.data.tag, '승인 알림이 결과로 바뀜')
	// [되돌리기]를 누르면 반대로 실행한다
	x.ha.emit('action', { action: done.data.actions[0].action })
	await flush(); await flush()
	assert.equal(x.ha.calls.at(-1), 'light.a turn_on')
	const log = latestBy(readJsonl(P.actions), 'aid')
	assert.deepEqual(log.map(a => a.status), ['undone', 'done', 'done'])
	assert.equal(readJson(P.counters, {}).actions, 3)
	// 다음 판단에서 되돌린 사실이 보인다
	x.t.brain = async () => ({ result: answer(), ms: 1, tokens: 1 })
	await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.match(x.t.prompts.at(-1), /사용자가 되돌림/)
})

test('행동: 거절과 시간 초과', async () => {
	const x = setup({ cfg: { actions: { enabled: true, confirm: ['switch.b', 'light.a'] } }, brain: async () => ({ result: answer({ actions: [{ entity_id: 'switch.b', action: 'turn_off', reason: 'r1' }, { entity_id: 'light.a', action: 'turn_off', reason: 'r2' }] }), ms: 1, tokens: 1 }) })
	await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	x.ha.emit('action', { action: x.ha.sent[0].data.actions[1].action }) // 아니요
	await flush(); await flush()
	x.t.now += 31 * MIN
	await x.agent.tick()
	const late = x.ha.sent[1].data.actions[0].action
	x.ha.emit('action', { action: late }) // 시간이 지난 뒤 [실행]
	await flush(); await flush()
	assert.deepEqual(x.ha.calls, [])
	assert.deepEqual(latestBy(readJsonl(P.actions), 'aid').map(a => a.status), ['declined', 'expired'])
})

test('답장: 우리 알림에 단 답장만 사용자 말로 받아 바로 판단한다', async () => {
	const x = setup()
	appendJsonl(P.notifications, { nid: 'n1', ts: new Date(T0).toISOString(), kind: 'info', level: 'normal', title: '빨래가 끝났어요', message: 'm', related_rule_ids: [], tag: 'haagent-n1', status: 'sent' })
	x.ha.emit('action', { action: 'REPLY', reply_text: '다른 앱 답장', tag: 'other-automation' })
	x.ha.emit('action', { action: 'REPLY', reply_text: '앞으로 빨래 알림은 저녁에만 줘', tag: 'haagent-n1' })
	await flush()
	assert.deepEqual(x.agent.queue.map(r => [r.type, r.text, r.about]), [['user', '앞으로 빨래 알림은 저녁에만 줘', '빨래가 끝났어요']])
	assert.equal(readJsonl(P.feedback)[0].kind, 'reply')
	await x.agent.tick()
	assert.match(x.t.prompts[0], /\[사용자 말\].*앞으로 빨래 알림은 저녁에만 줘/)
})

test('HA가 오래 끊기면 비상 길로 알리고, 돌아오면 다시 알린다', async () => {
	const x = setup()
	x.ha.connected = false
	await x.agent.tick()
	x.t.now += 14 * MIN
	await x.agent.tick()
	await flush()
	assert.deepEqual(x.t.oob, [])
	x.t.now += 2 * MIN
	await x.agent.tick()
	x.t.now += 5 * MIN
	await x.agent.tick()
	await flush()
	assert.equal(x.t.oob.length, 1, '한 번만')
	assert.match(x.t.oob[0], /연결하지 못해요/)
	x.ha.connected = true
	await x.agent.tick()
	await flush()
	assert.match(x.t.oob[1], /다시 연결됨/)
})

test('멈춤 감시: 주 루프가 막히면 프로세스를 끝낸다', () => {
	const mod = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'watchdog.mjs')
	const code = `import { startWatchdog } from ${JSON.stringify(mod)}; startWatchdog(300, 100); const end = Date.now() + 8000; while (Date.now() < end) {}`
	const started = Date.now()
	const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
	assert.equal(r.signal, 'SIGKILL')
	assert.ok(Date.now() - started < 5000)
	assert.match(r.stderr, /watchdog/)
})

test('판단 방식: 실행 중에 control.json의 brain을 바꾸면 다음 판단부터 그 방식·설정으로 묻는다', async () => {
	const seen = []
	const x = setup({ cfg: { codex: { model: 'm-codex', effort: 'high' }, api: { model: 'm-api' } }, brain: async a => { seen.push([a.mode, a.model, a.effort]); return { result: answer(), ms: 1, tokens: 1 } } })
	await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	saveControl({ paused: false, send: true, brain: 'api' })
	await x.agent.tick()
	await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.deepEqual(seen, [['codex', 'm-codex', 'high'], ['api', 'm-api', 'high']])
	assert.deepEqual(readJsonl(P.decisions).map(d => d.brain), ['codex', 'api'])
})

test('하루 돌아보기: 활동 시간이 7~23시여도 정한 시각(23시)에 돌고, 그때의 요약은 조용한 시간이어도 나간다', async () => {
	const x = setup({ cfg: { active_hours: { start: 7, end: 23 }, reflection_hour: 23 }, brain: async () => ({ result: answer({ notifications: [note({ kind: 'hourly_summary', level: 'quiet', title: '하루 마감', related_rule_ids: [] }), note({ title: '보류될 알림', related_rule_ids: [] })] }), ms: 1, tokens: 1 }) })
	x.t.now = Date.parse('2026-11-11T22:00:20+09:00')
	await x.agent.tick()
	assert.match(x.t.prompts[0], /\[정각 점검\] 22시/)
	assert.match(x.t.prompts[0], /활동 시간 7~23시\(그 밖은 조용한 시간\), 정각 점검 7~22시, 하루 돌아보기 23시/)
	x.t.now = Date.parse('2026-11-11T23:00:20+09:00')
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 2)
	assert.match(x.t.prompts[1], /\[하루 돌아보기 \+ 정각 점검\] 23시/)
	assert.match(x.t.prompts[1], /지난 7일 지표/)
	assert.deepEqual(x.ha.sent.map(p => p.title), ['하루 마감', '보류될 알림', '하루 마감'], '22시 것 둘 + 23시 요약(다른 알림은 아침까지 보류)')
	assert.equal(readJson(P.held, []).length, 1)
	x.t.now = Date.parse('2026-11-12T00:00:20+09:00')
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 2, '0시에는 돌지 않는다')
})

test('정각 점검 건너뛰기: 소음 엔티티와 재생 상태 출렁임만 있었으면 달라진 것이 없는 것으로 본다', async () => {
	const x = setup({ cfg: { noise_entities: ['binary_sensor.*_screensaver'] }, states: [st('binary_sensor.door', 'off', T0 - 60 * MIN), st('light.a', 'on', T0 - 60 * MIN), st('binary_sensor.ipad_screensaver', 'on', T0 - 60 * MIN), st('media_player.stb', 'playing', T0 - 60 * MIN)] })
	await x.agent.cycle([{ type: 'hourly', hour: 16 }])
	x.t.now += 60 * MIN
	x.ha.set('binary_sensor.ipad_screensaver', 'off', x.t.now - 5 * MIN)
	x.ha.set('media_player.stb', 'paused', x.t.now - 4 * MIN)
	x.ha.set('media_player.stb', 'playing', x.t.now - 3 * MIN)
	assert.equal((await x.agent.cycle([{ type: 'hourly', hour: 17 }])).skipped, true)
	x.t.now += 60 * MIN
	x.ha.set('media_player.stb', 'off', x.t.now - MIN)
	assert.equal((await x.agent.cycle([{ type: 'hourly', hour: 18 }])).skipped, undefined, 'TV가 꺼진 것은 달라진 것')
	assert.match(x.t.prompts.at(-1), /소음으로 분류해 줄임.*screensaver 1번/)
	assert.match(x.t.prompts.at(-1), /media_player\.stb\) playing → off/)
})

test('판단 방식 자동 전환: 두 번 연속 실패하면 다른 방식으로 넘어가 한동안 머물고, 그 뒤 원래 방식을 다시 본다', async () => {
	const seen = []
	let codexOk = false
	const brain = async a => { seen.push(a.mode); if (a.mode === 'codex' && !codexOk) throw new Error('codex 로그인 만료'); return { result: answer(), ms: 1, tokens: 1 } }
	const x = setup({ cfg: { codex: { model: 'm-codex' }, api: { model: 'm-api' } }, canUse: () => true, brain })
	const run = () => x.agent.cycle([{ type: 'manual', reason: '시험' }])
	await run(); await run()
	assert.deepEqual(seen, ['codex', 'codex'])
	const e = await run()
	assert.deepEqual([e.brain, e.failover, e.error], ['api', true, undefined], '세 번째는 API로 성공')
	assert.equal(x.ha.sent.length, 1)
	assert.match(x.ha.sent[0].title, /판단 방식을 잠시 바꿨어요/)
	assert.match(x.ha.sent[0].message, /Codex 판단이 2번 연속 실패.*요금.*codex 로그인 만료/)
	await run()
	assert.equal(seen.at(-1), 'api', '머무는 동안은 API')
	assert.equal(x.ha.sent.length, 1, '안내는 하루 한 번')
	x.t.now += 121 * MIN
	await run()
	assert.equal(seen.at(-1), 'codex', '시간이 지나면 원래 방식을 다시 써 본다')
	await run()
	assert.equal(seen.at(-1), 'api', '또 실패하면 한 번 만에 다시 넘어간다')
	x.t.now += 121 * MIN
	codexOk = true
	await run(); await run()
	assert.deepEqual(seen.slice(-2), ['codex', 'codex'], '돌아왔으면 원래 방식에 머문다')
	assert.equal(x.agent.failover, null)
	// 넘어갈 쪽을 쓸 수 없으면(키 없음) 넘어가지 않는다
	seen.length = 0
	codexOk = false
	const y = setup({ canUse: () => false, brain })
	for (let i = 0; i < 3; i++) await y.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.deepEqual(seen, ['codex', 'codex', 'codex'])
	// 둘 다 실패하면 번갈아 시도한다
	seen.length = 0
	const z = setup({ canUse: () => true, brain: async a => { seen.push(a.mode); throw new Error('둘 다 실패') } })
	for (let i = 0; i < 6; i++) await z.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.deepEqual(seen, ['codex', 'codex', 'api', 'codex', 'api', 'codex'])
})

test('하루 한도: 사용자 말에는 한도 뒤에도 조금 더 답하고, 그마저 넘으면 답하지 못한다고 알린다', async () => {
	const x = setup({ cfg: { limits: { brain_runs_per_day: 2, user_reserve_runs: 1 } } })
	const say = async text => { x.agent.queue.push({ type: 'user', text, about: null, urgent: true, at: x.t.now }); await x.agent.tick() }
	await x.agent.tick()
	x.agent.counters.runs = 2
	x.agent.queue.push({ type: 'scheduled', reason: '예약', at: x.t.now, urgent: true })
	await x.agent.tick()
	assert.equal(x.t.prompts.length, 0, '그 밖의 깨움은 한도에서 멈춘다')
	await say('거실 불 켜져 있어?')
	assert.equal(x.t.prompts.length, 1, '사용자 말은 한도 뒤에도 답한다')
	await say('하나만 더 물어볼게')
	assert.equal(x.t.prompts.length, 1)
	assert.match(x.ha.sent.at(-1).title, /오늘은 더 답하지 못해요/)
	assert.match(x.ha.sent.at(-1).message, /하나만 더 물어볼게/)
})

test('행동: 사용자가 직접 시킨 것은 승인을 다시 묻지 않고(조용한 시간에도) 바로 실행한다', async () => {
	const acts = [{ entity_id: 'switch.b', action: 'turn_off', reason: '요청하신 대로 꺼요.', requested: true }, { entity_id: 'light.a', action: 'turn_off', reason: '함께 끄면 좋겠어요.', requested: false }]
	const cfg = { actions: { enabled: true, confirm: ['switch.b', 'light.a'] } }
	const x = setup({ cfg, brain: async () => ({ result: answer({ actions: acts }), ms: 1, tokens: 1 }) })
	const e = await x.agent.cycle([{ type: 'user', text: '작은방 불 꺼줘' }])
	assert.match(x.t.prompts[0], /requested=true로 낸다/)
	assert.deepEqual(x.ha.calls, ['switch.b turn_off'])
	assert.deepEqual(e.applied.actions, ['done: switch.b turn_off', 'pending: light.a turn_off'], '시키지 않은 것은 여전히 승인을 묻는다')
	assert.match(x.ha.sent[0].data.actions[0].action, /^HAAGENT_UNDO_/, '되돌리기 버튼이 붙는다')
	assert.equal(latestBy(readJsonl(P.actions), 'aid')[0].requested, true)
	// 사용자 말로 깨어난 판단이 아니면 requested를 믿지 않는다
	const y = setup({ cfg, brain: async () => ({ result: answer({ actions: acts.slice(0, 1) }), ms: 1, tokens: 1 }) })
	const e2 = await y.agent.cycle([{ type: 'rule', rule_id: 'door_open_long', description: 'd', entity_id: 'binary_sensor.door', value: 'on', since: T0 }])
	assert.deepEqual(y.ha.calls, [])
	assert.deepEqual(e2.applied.actions, ['pending: switch.b turn_off'])
	// 조용한 시간에도 직접 시킨 것은 한다. 꺼 두면(on_request: false) 예전처럼 묻는다.
	const z = setup({ cfg, brain: async () => ({ result: answer({ actions: acts.slice(0, 1) }), ms: 1, tokens: 1 }) })
	z.t.now = Date.parse('2026-11-12T02:00:00+09:00')
	await z.agent.cycle([{ type: 'user', text: '작은방 불 꺼줘' }])
	assert.deepEqual(z.ha.calls, ['switch.b turn_off'])
	const w = setup({ cfg: { actions: { ...cfg.actions, on_request: false } }, brain: async () => ({ result: answer({ actions: acts.slice(0, 1) }), ms: 1, tokens: 1 }) })
	const e4 = await w.agent.cycle([{ type: 'user', text: '작은방 불 꺼줘' }])
	assert.deepEqual(w.ha.calls, [])
	assert.deepEqual(e4.applied.actions, ['pending: switch.b turn_off'])
})

test('urgent 다시 알림: 상황이 그대로이고 반응이 없으면 정한 횟수까지 다시 알리고, 둘째부터는 비상 길로도 보낸다', async () => {
	const x = setup({ rules: [rule({ priority: 'urgent', for_minutes: 0 })] })
	x.ha.set('binary_sensor.door', 'on', x.t.now)
	await flush()
	await x.agent.tick() // 판단(가짜 AI는 아무것도 하지 않음)
	const mine = () => x.ha.sent.filter(p => p.data.tag === 'haagent-door_open_long')
	assert.equal(mine().length, 1, '발동 즉시 알림 1개')
	x.t.now += 10 * MIN
	await x.agent.tick()
	assert.equal(mine().length, 1, '15분 전에는 다시 알리지 않는다')
	x.t.now += 6 * MIN
	await x.agent.tick()
	await flush()
	assert.equal(mine().length, 2)
	assert.match(mine()[1].message, /16분째 그대로예요\(다시 알림 1\/3\)/)
	assert.equal(mine()[1].data.channel, '집 비서 긴급')
	assert.deepEqual(x.t.oob, [], '첫 번째는 휴대폰 알림만')
	x.t.now += 16 * MIN
	await x.agent.tick()
	await flush()
	assert.equal(mine().length, 3)
	assert.equal(x.t.oob.length, 1, '두 번째부터 비상 길로도')
	// [도움됐어요]를 누르면 그만 알린다
	x.ha.emit('action', { action: mine()[2].data.actions[0].action })
	await flush(); await flush()
	const before = x.ha.sent.length
	x.t.now += 16 * MIN
	await x.agent.tick()
	x.t.now += 16 * MIN
	await x.agent.tick()
	assert.equal(x.ha.sent.length, before)
	// 반응이 없어도 정한 횟수에서 멈추고, 상황이 풀리면 바로 멈춘다
	const y = setup({ rules: [rule({ priority: 'urgent', for_minutes: 0 })], cfg: { escalation: { max_reminders: 2 } } })
	y.ha.set('binary_sensor.door', 'on', y.t.now)
	await flush()
	for (let i = 0; i < 5; i++) { y.t.now += 16 * MIN; await y.agent.tick() }
	assert.equal(y.ha.sent.filter(p => p.data.tag === 'haagent-door_open_long').length, 3, '처음 1 + 다시 알림 2')
	const z = setup({ rules: [rule({ priority: 'urgent', for_minutes: 0 })] })
	z.ha.set('binary_sensor.door', 'on', z.t.now)
	await flush()
	z.ha.set('binary_sensor.door', 'off', z.t.now + MIN)
	for (let i = 0; i < 3; i++) { z.t.now += 16 * MIN; await z.agent.tick() }
	assert.equal(z.ha.sent.filter(p => p.data.tag === 'haagent-door_open_long').length, 1)
})

test('규칙 백테스트: 새 규칙을 받으면 지난 기록에 돌려 보고 결과를 다음 판단에 보여준다', async () => {
	const noisy = rule({ id: 'light_on', description: '조명 켜짐', entity_id: 'light.a', for_minutes: 0, cooldown_minutes: 0 })
	const stale = rule({ id: 'door_stale', description: '보고 끊김', op: 'stale', value: null, for_minutes: 60 })
	const x = setup({ brain: async () => ({ result: answer({ rule_changes: { upsert: [noisy, stale], delete: [] } }), ms: 1, tokens: 1 }) })
	const from = (T0 - 7 * 24 * 60 * MIN) / 1000
	x.ha.hist = { 'light.a': [{ s: 'off', lu: from }, ...Array.from({ length: 40 }, (_, i) => ({ s: i % 2 ? 'off' : 'on', lu: from + 3600 * (i + 1) }))] }
	const e = await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.deepEqual(e.applied.added, ['light_on', 'door_stale'])
	assert.deepEqual(e.applied.backtest, ['light_on: 지난 7일 기록으로 20회'], 'stale은 돌려 볼 수 없어 뺀다')
	assert.equal(readJson(P.runtime, {}).rules.light_on.backtest.fires, 20)
	x.t.brain = async () => ({ result: answer(), ms: 1, tokens: 1 })
	await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.match(x.t.prompts.at(-1), /light_on \|.*백테스트: 만들 때 지난 7일 기록으로는 20회 발동했을 것/)
	// 기록을 받지 못해도 규칙 적용은 그대로 된다
	const y = setup({ brain: async () => ({ result: answer({ rule_changes: { upsert: [noisy], delete: [] } }), ms: 1, tokens: 1 }) })
	y.ha.history = async () => { throw new Error('시간 초과') }
	const e2 = await y.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.deepEqual([e2.applied.added, e2.applied.backtest, e2.error], [['light_on'], undefined, undefined])
})

test('행동 안전: TV 되돌리기 미부착, UNDO 실패 시 상태 유지, 중복 탭·일시정지 가드', async () => {
	const states = [st('media_player.tv', 'playing', T0 - 60 * MIN), st('light.a', 'on', T0 - 60 * MIN), st('switch.b', 'on', T0 - 60 * MIN)]
	const x = setup({
		states,
		cfg: { actions: { enabled: true, auto: ['media_player.tv', 'light.a'], confirm: ['switch.b'] } },
		brain: async () => ({ result: answer({ actions: [{ entity_id: 'media_player.tv', action: 'turn_off', reason: '절전' }, { entity_id: 'light.a', action: 'turn_off', reason: '빈 방' }] }), ms: 1, tokens: 1 }),
	})
	await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	const [tvNote, lightNote] = x.ha.sent
	assert.equal(tvNote.data.actions, undefined, 'media_player는 turn_on 불가라 되돌리기 버튼을 달지 않는다')
	assert.match(lightNote.data.actions[0].action, /^HAAGENT_UNDO_/)
	// UNDO 실행이 실패하면 원 행동이 undone으로 바뀌지 않는다
	const origCall = x.ha.callService.bind(x.ha)
	x.ha.callService = async (d, s, o) => { if (d === 'light' && s === 'turn_on') throw new Error('기기 오류'); return origCall(d, s, o) }
	x.ha.emit('action', { action: lightNote.data.actions[0].action })
	await flush(); await flush()
	const lightRec = latestBy(readJsonl(P.actions), 'aid').find(a => a.entity_id === 'light.a' && a.action === 'turn_off')
	assert.equal(lightRec.status, 'done', '되돌리기 실패 시 원 기록은 done 유지')

	// [실행] 중복 탭 방지: 처리 중 두 번 눌러도 1번만 실행
	let release
	const slowGate = new Promise(r => { release = r })
	x.ha.callService = async (d, s, o) => { if (d === 'switch') await slowGate; return origCall(d, s, o) }
	x.t.brain = async () => ({ result: answer({ actions: [{ entity_id: 'switch.b', action: 'turn_off', reason: '끄기' }] }), ms: 1, tokens: 1 })
	await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	const doBtn = x.ha.sent.at(-1).data.actions[0].action
	x.ha.emit('action', { action: doBtn })
	x.ha.emit('action', { action: doBtn })
	await flush()
	release()
	await flush(); await flush()
	assert.equal(x.ha.calls.filter(c => c === 'switch.b turn_off').length, 1, '중복 탭해도 1회만 실행')

	// paused 상태에서는 DO와 REPLY가 차단된다
	saveControl({ paused: true, send: true })
	x.t.brain = async () => ({ result: answer({ actions: [{ entity_id: 'switch.b', action: 'turn_on', reason: '켜기' }] }), ms: 1, tokens: 1 })
	x.agent.control.paused = false
	await x.agent.cycle([{ type: 'manual', reason: '시험' }])
	const doPaused = x.ha.sent.at(-1).data.actions[0].action
	x.ha.emit('action', { action: doPaused })
	await flush(); await flush()
	assert.equal(x.ha.calls.filter(c => c === 'switch.b turn_on').length, 0, '일시정지 중에는 행동 버튼 미실행')
	x.ha.emit('action', { action: 'REPLY', reply_text: '지금 실행해', tag: 'haagent-summary' })
	await flush()
	assert.equal(x.agent.queue.some(q => q.type === 'user'), false, '일시정지 중에는 답장을 큐에 넣지 않음')
})

test('reflection 지연 복구·보류 예외, fallback_model 우선순위, 날씨 폴백, effort_hourly', async () => {
	const efforts = []
	const x = setup({
		cfg: { active_hours: { start: 7, end: 23 }, reflection_hour: 23, weather_entity: 'weather.bad', weather_fallback_entity: 'weather.good', codex: { effort: 'high', effort_hourly: 'low', effort_deep: 'max' }, away_override_entity: 'input_boolean.override' },
		states: [st('binary_sensor.door', 'off', T0 - 60 * MIN), st('weather.bad', 'sunny', T0), st('weather.good', 'cloudy', T0, { temperature: 12, humidity: 40, wind_speed: 2 }), st('input_boolean.override', 'on', T0)],
		brain: async a => { efforts.push(a.effort); return { result: answer({ notifications: [note({ kind: 'hourly_summary', level: 'quiet', title: '마감', related_rule_ids: [] })] }), ms: 1, tokens: 1 } },
	})
	const realSvc = x.ha.callService.bind(x.ha)
	x.ha.callService = async (d, s, o) => {
		if (d === 'weather' && o?.target?.entity_id === 'weather.bad') throw new Error('기상청 일시 오류')
		if (d === 'weather' && o?.target?.entity_id === 'weather.good') return { response: { 'weather.good': { forecast: [{ datetime: new Date(T0 + 3600000).toISOString(), condition: 'cloudy', temperature: 11, precipitation: 0 }] } } }
		return realSvc(d, s, o)
	}
	await x.agent.cycle([{ type: 'hourly', hour: 15 }])
	await x.agent.cycle([{ type: 'manual', reason: '확인' }])
	assert.match(x.t.prompts[0], /날씨 \(weather\.good\)/, '보조 날씨로 폴백')
	assert.match(x.t.prompts[0], /재실·방해금지 도우미:.*= on/)
	// 23:40에 깨어나도(k.mi >= 10, k.mi >= 30) reflection 실행 및 요약 즉시 발송
	x.t.now = Date.parse('2026-11-11T23:40:00+09:00')
	await x.agent.tick()
	assert.deepEqual(efforts, ['low', 'high', 'max'])
	assert.equal(x.ha.sent.at(-1).title, '마감', '23:30 이후에도 reflection 요약은 보류되지 않음')

	// fallback_model이 설정되면 after_failures(2)째 실패에 대체 모델을 먼저 쓰고, 그다음 failover
	const calls = []
	const y = setup({
		cfg: { codex: { model: 'm-main', fallback_model: 'm-fb' }, api: { model: 'm-api' }, failover: { after_failures: 2 } },
		canUse: () => true,
		brain: async a => { calls.push([a.mode, a.model]); throw new Error('실패') },
	})
	for (let i = 0; i < 4; i++) await y.agent.cycle([{ type: 'manual', reason: '시험' }])
	assert.deepEqual(calls, [['codex', 'm-main'], ['codex', 'm-main'], ['codex', 'm-fb'], ['api', 'm-api']])
})

test('system-log 델타 추적과 정각 건너뛰기, noiseRing 분리, stale 갱신 순서', async () => {
	const x = setup({ cfg: { noise_entities: ['sensor.noise_*'] }, states: [st('binary_sensor.door', 'off', T0 - 60 * MIN), st('sensor.noise_1', '0', T0 - 60 * MIN), st('sensor.temp', '20', T0 - 10 * MIN)] })
	let logs = [{ level: 'WARNING', name: 'comp.a', message: 'warn1', count: 1, timestamp: T0 / 1000 }]
	const realCall = x.ha.call.bind(x.ha)
	x.ha.call = async msg => (msg.type === 'system_log/list' ? logs : realCall(msg))

	await x.agent.cycle([{ type: 'hourly', hour: 16 }])
	assert.equal(x.t.prompts.length, 1)
	assert.match(x.t.prompts[0], /HA 시스템 오류·수리 변화/)
	// 같은 경고 그대로면 17시는 건너뜀
	x.t.now += 60 * MIN
	assert.equal((await x.agent.cycle([{ type: 'hourly', hour: 17 }])).skipped, true)
	// 새 ERROR가 생기면 건너뛰지 않고 프롬프트에 표시
	logs = [...logs, { level: 'ERROR', name: 'comp.b', message: 'boom', count: 1, timestamp: x.t.now / 1000 }]
	x.t.now += 60 * MIN
	const res18 = await x.agent.cycle([{ type: 'hourly', hour: 18 }])
	assert.equal(res18.skipped, undefined)
	assert.match(x.t.prompts.at(-1), /\[신규 ERROR\] comp\.b: boom/)
	assert.equal(readJson(join(P.run, 'system-log.json'), []).find(e => e.name === 'comp.b')?.status, 'new')

	// 소음 350건이 와도 실제 변화(binary_sensor.door)가 ring에서 밀려나지 않음
	x.ha.set('binary_sensor.door', 'on', x.t.now + MIN)
	for (let i = 1; i <= 350; i++) x.ha.set('sensor.noise_1', String(i), x.t.now + MIN + i)
	x.t.now += 60 * MIN
	assert.equal((await x.agent.cycle([{ type: 'hourly', hour: 19 }])).skipped, undefined, '소음이 많아도 실제 변화 감지 유지')

	// tick()이 engine.tick() 전에 stale 센서의 최신 last_reported를 읽어 오탐을 막는다
	const y = setup({
		rules: [rule({ id: 'temp_stale', entity_id: 'sensor.temp', op: 'stale', value: null, for_minutes: 10 })],
		states: [st('sensor.temp', '20', T0)],
	})
	y.t.now += 15 * MIN
	y.ha.map.set('sensor.temp', { ...st('sensor.temp', '20', T0), last_reported: new Date(y.t.now - MIN).toISOString(), last_updated: new Date(y.t.now - MIN).toISOString() })
	await y.agent.tick()
	assert.equal(y.agent.queue.some(q => q.rule_id === 'temp_stale'), false, '갱신 후 판정하므로 stale 오탐 없음')
})
