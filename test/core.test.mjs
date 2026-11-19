// 단위 시험: 규칙 판정, 답 검사, 알림 모양, Codex 격리 인자, API 방식(가짜 fetch). HA나 Codex, OpenAI에는 접속하지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuleEngine, validateRule, condition, ruleKey, recentFires } from '../src/rules.mjs'
import { validateResponse, codexArgs, brainMode, brainSettings, selfCheck } from '../src/brain.mjs'
import { runApi, runTool, apiKey, TOOLS } from '../src/api.mjs'
import { buildPayload, feedbackPayload, approvalPayload, actionResultPayload, isReservedMessage, ACTION_RE, CHANNELS } from '../src/notify.mjs'
import { checkMessage, HEARTBEAT_EVENT, HA } from '../src/ha.mjs'
import { createServer } from 'node:net'
import { checkAction, actionTiers } from '../src/actions.mjs'
import { dailyDigest } from '../src/records.mjs'
import { notableChange, compactStates, buildPrompt, changeLines, significantChange, guideFor, calendarText } from '../src/context.mjs'
import { backtestRule, backtestable } from '../src/backtest.mjs'
import { globs, readJsonlAll } from '../src/util.mjs'
import { DEFAULTS, mergeConfig, validateConfig } from '../src/config.mjs'
import { automationRuns, deviceActivity } from '../src/weekly.mjs'

const T0 = Date.parse('2026-11-11T06:00:00Z')
const MIN = 60000
const st = (entity_id, state, changedAt = T0, attributes = {}) => ({ entity_id, state, attributes, last_changed: new Date(changedAt).toISOString(), last_updated: new Date(changedAt).toISOString() })
const states = new Map([
	['binary_sensor.door', st('binary_sensor.door', 'off')],
	['sensor.humidity', st('sensor.humidity', '55')],
	['sensor.washer', st('sensor.washer', 'power_off')],
])
const rule = over => ({ id: 'door_open_long', description: '현관문 10분 이상 열림', entity_id: 'binary_sensor.door', attribute: null, op: 'eq', value: 'on', for_minutes: 10, cooldown_minutes: 30, priority: 'urgent', ...over })

test('규칙 검사: 정상 규칙은 통과, 잘못된 규칙은 이유와 함께 거절', () => {
	assert.equal(validateRule(rule(), states).ok, true)
	const bad = validateRule(rule({ id: 'Bad Id', entity_id: 'light.none', op: 'gt', value: 'x', priority: 'high' }), states)
	assert.equal(bad.ok, false)
	assert.match(bad.error, /id/)
	assert.match(bad.error, /없는 엔티티/)
	assert.match(bad.error, /gt\/lt/)
	assert.match(bad.error, /priority/)
	assert.equal(validateRule(rule({ op: 'stale', value: null, for_minutes: 5 }), states).ok, false)
})

test('조건: ne·gt는 unavailable일 때 걸리지 않고, unavailable 규칙은 걸린다', () => {
	const dead = st('sensor.humidity', 'unavailable')
	assert.equal(condition(rule({ entity_id: 'sensor.humidity', op: 'gt', value: 70 }), dead, T0), false)
	assert.equal(condition(rule({ entity_id: 'sensor.humidity', op: 'ne', value: '55' }), dead, T0), false)
	assert.equal(condition(rule({ entity_id: 'sensor.humidity', op: 'unavailable', value: null }), dead, T0), true)
	assert.equal(condition(rule({ entity_id: 'sensor.humidity', op: 'gt', value: 70 }), st('sensor.humidity', '71.5'), T0), true)
	assert.equal(condition(rule({ op: 'in', value: 'on|open' }), st('binary_sensor.door', 'open'), T0), true)
	assert.equal(condition(rule({ op: 'stale', value: null, for_minutes: 60 }), st('x', '1', T0 - 61 * MIN), T0), true)
})

test('발동: for_minutes가 지나야 한 번, 조건이 풀렸다 다시 참이 되면 또 (쿨다운 지난 뒤)', () => {
	const rt = {}
	const e = new RuleEngine([rule()], rt)
	e.initAll(states, T0) // 문 닫힘 → 무장
	assert.deepEqual(e.onState('binary_sensor.door', st('binary_sensor.door', 'on', T0 + MIN), T0 + MIN), [])
	assert.equal(e.tick(new Map([['binary_sensor.door', st('binary_sensor.door', 'on', T0 + MIN)]]), T0 + 5 * MIN).length, 0)
	const fired = e.tick(new Map([['binary_sensor.door', st('binary_sensor.door', 'on', T0 + MIN)]]), T0 + 11 * MIN)
	assert.equal(fired.length, 1)
	assert.equal(fired[0].value, 'on')
	assert.equal(e.tick(new Map([['binary_sensor.door', st('binary_sensor.door', 'on', T0 + MIN)]]), T0 + 20 * MIN).length, 0, '같은 상황에서 두 번 발동하지 않음')
	e.onState('binary_sensor.door', st('binary_sensor.door', 'off', T0 + 21 * MIN), T0 + 21 * MIN)
	e.onState('binary_sensor.door', st('binary_sensor.door', 'on', T0 + 22 * MIN), T0 + 22 * MIN)
	assert.equal(e.tick(new Map([['binary_sensor.door', st('binary_sensor.door', 'on', T0 + 22 * MIN)]]), T0 + 33 * MIN).length, 0, '쿨다운 30분 안')
	e.onState('binary_sensor.door', st('binary_sensor.door', 'off', T0 + 40 * MIN), T0 + 40 * MIN)
	e.onState('binary_sensor.door', st('binary_sensor.door', 'on', T0 + 45 * MIN), T0 + 45 * MIN)
	assert.equal(e.tick(new Map([['binary_sensor.door', st('binary_sensor.door', 'on', T0 + 45 * MIN)]]), T0 + 56 * MIN).length, 1, '쿨다운 지난 뒤 다시 발동')
})

test('새 규칙: 만들 때 이미 참이면 발동하지 않고 다음 변화부터 본다', () => {
	const e = new RuleEngine([], {})
	const open = new Map([['binary_sensor.door', st('binary_sensor.door', 'on', T0 - 120 * MIN)]])
	e.setRules([rule()], open, T0, ['door_open_long'])
	assert.equal(e.tick(open, T0 + 60 * MIN).length, 0)
})

test('재시작: 꺼진 사이 열린 문은 마지막 변경 시각으로 따져 발동', () => {
	const rt = {}
	const e1 = new RuleEngine([rule()], rt)
	e1.initAll(states, T0) // 닫힘 상태로 무장
	const e2 = new RuleEngine([rule()], rt) // 같은 runtime으로 재시작
	const fired = e2.initAll(new Map([['binary_sensor.door', st('binary_sensor.door', 'on', T0 + MIN)]]), T0 + 30 * MIN)
	assert.equal(fired.length, 1)
})

test('그만(mute): 쉬는 동안은 발동하지 않는다', () => {
	const e = new RuleEngine([rule({ for_minutes: 0 })], {})
	e.initAll(states, T0)
	e.mute('door_open_long', T0 + 7 * 24 * 60 * MIN)
	assert.equal(e.onState('binary_sensor.door', st('binary_sensor.door', 'on', T0 + MIN), T0 + MIN).length, 0)
})

test('답 검사: 이상한 값은 고치거나 버린다', () => {
	const r = validateResponse({ summary: 'x', notifications: [{ kind: 'weird', level: 'loud', title: '제목', message: '본문', related_rule_ids: [1, 'a'] }, { title: '', message: '' }], rule_changes: {}, next_wakes: [{ at: '', reason: 'r' }], memory: { mode: 'drop' }, info_requests: [{ entity_ids: ['a'], hours: 9999 }] })
	assert.equal(r.notifications.length, 1)
	assert.equal(r.notifications[0].kind, 'info')
	assert.equal(r.notifications[0].level, 'normal')
	assert.deepEqual(r.notifications[0].related_rule_ids, ['a'])
	assert.deepEqual(r.rule_changes, { upsert: [], delete: [] })
	assert.equal(r.next_wakes.length, 0)
	assert.equal(r.memory.mode, 'keep')
	assert.equal(r.info_requests[0].hours, 168)
	assert.throws(() => validateResponse(null))
})

test('알림 모양: 요약은 [줄여 줘]·[답장]과 고정 tag, 알림은 규칙 tag와 HAAGENT_ 버튼', () => {
	const s = buildPayload({ kind: 'hourly_summary', level: 'quiet', title: 't', message: 'm', related_rule_ids: [] }, 'abc1')
	assert.equal(s.data.tag, 'haagent-summary')
	assert.deepEqual(s.data.actions.map(x => x.action), ['HAAGENT_LESS_abc1', 'REPLY'], '요약에는 줄여 줘와 답장')
	assert.match(s.data.actions[0].action, ACTION_RE)
	assert.equal(s.data.action_data.nid, 'abc1')
	assert.deepEqual(buildPayload({ kind: 'hourly_summary', level: 'quiet', title: 't', message: 'm', related_rule_ids: [] }, 'abc1', { reply: false }).data.actions.map(x => x.title), ['줄여 줘'])
	assert.equal(s.data.channel, CHANNELS.quiet.channel)
	const a = buildPayload({ kind: 'alert', level: 'urgent', title: 't', message: 'm', related_rule_ids: ['door_open_long'] }, 'abc1')
	assert.equal(a.data.tag, 'haagent-door_open_long')
	assert.deepEqual(a.data.actions.map(x => x.action), ['HAAGENT_UP_abc1', 'HAAGENT_MUTE_abc1', 'REPLY'])
	assert.equal(a.data.action_data.nid, 'abc1')
	for (const x of a.data.actions.slice(0, 2)) assert.match(x.action, ACTION_RE)
	assert.equal(ACTION_RE.test('HOME_ALL_OFF'), false)
	const f = feedbackPayload({ title: 't', tag: a.data.tag, level: 'urgent' }, 'MUTE', ['현관문 10분 이상 열림'])
	assert.equal(f.data.tag, a.data.tag, '같은 tag로 결과 문구를 덮어씀')
	assert.equal(f.data.actions, undefined)
	assert.equal(f.data.alert_once, true)
	assert.match(f.message, /7일/)
})

test('Codex 인자: 사용자 설정 무시, 네트워크 끔, brain만 읽기, 전체 접근 없음', () => {
	const args = codexArgs({ cfg: DEFAULTS, effort: 'low', outFile: '/x/answer.json', vendorDir: '/v' })
	const s = args.join(' ')
	for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'approval_policy="never"', 'web_search="disabled"', 'network={enabled=false}', '":root"="deny"']) assert.ok(s.includes(flag), flag)
	assert.ok(!s.includes('danger-full-access'))
	assert.ok(!s.includes('dangerously'))
	assert.ok(!s.includes('.config/home-assistant'))
	assert.equal(args.at(-1), '-')
})

test('상태 변화 기록: 숫자 센서 출렁임과 속성 변화는 빼고 의미 있는 변화만', () => {
	const ch = (id, from, to, attrs = {}) => notableChange({ entity_id: id, old_state: st(id, from), new_state: st(id, to, T0, attrs) })
	assert.ok(ch('binary_sensor.door', 'off', 'on'))
	assert.equal(ch('sensor.humidity', '55', '56'), null)
	assert.ok(ch('sensor.washer', 'power_off', 'running'))
	assert.equal(ch('binary_sensor.door', 'on', 'on'), null)
	assert.equal(ch('sensor.end', '2026-11-11T07:00:00+00:00', '2026-11-11T07:05:00+00:00', { device_class: 'timestamp' }), null)
})

test('프롬프트: 지침·이유·규칙·날씨가 들어가고 상태 요약에서 자동화·버튼은 빠진다', () => {
	const big = new Map([...states, ['automation.a', st('automation.a', 'on')], ['button.b', st('button.b', 'x')]])
	const cs = compactStates(big)
	assert.ok(!cs.some(x => x.id.startsWith('automation.') || x.id.startsWith('button.')))
	const p = buildPrompt({ guide: '# 지침', now: T0, quiet: false, reasons: [{ type: 'hourly', hour: 15 }], rules: [rule()], runtime: {}, schedule: [], memory: '', recentNotes: [], feedback: [], held: [], rejected: [], ring: [], weather: { entity: 'weather.jib', current: { state: 'sunny', temperature: 15, humidity: 50, wind_speed: 3 }, hourly: [], daily: [] }, calendar: [] })
	for (const s of ['# 지침', '[정각 점검] 15시', 'door_open_long', '맑음', 'run/states.json']) assert.ok(p.includes(s), s)
})

test('규칙 확장: 함께 참이어야 하는 조건(also)과 시간대가 모두 맞아야 발동', () => {
	const home = new Map([
		['light.a', st('light.a', 'on', T0 - 60 * MIN)],
		['person.x', st('person.x', 'home', T0 - 60 * MIN)],
	])
	const r = validateRule({ id: 'light_on_away', description: '아무도 없는데 조명 켜짐', entity_id: 'light.a', attribute: null, op: 'eq', value: 'on', for_minutes: 10, cooldown_minutes: 0, priority: 'normal', also: [{ entity_id: 'person.x', attribute: null, op: 'eq', value: 'not_home' }], hour_from: null, hour_to: null }, home)
	assert.equal(r.ok, true)
	const e = new RuleEngine([r.rule], {})
	e.initAll(home, T0)
	assert.equal(e.tick(home, T0 + 30 * MIN).length, 0, '사람이 있으면 발동하지 않음')
	const away = st('person.x', 'not_home', T0 + 31 * MIN)
	home.set('person.x', away)
	assert.equal(e.onState('person.x', away, T0 + 31 * MIN, home).length, 0, '나간 직후에는 아직')
	assert.equal(e.tick(home, T0 + 42 * MIN).length, 1, '나간 뒤 10분이 지나면 발동')
	assert.equal(validateRule({ ...r.rule, also: [{ entity_id: 'person.none', attribute: null, op: 'eq', value: 'x' }] }, home).ok, false)
	assert.equal(validateRule({ ...r.rule, hour_from: 23, hour_to: null }, home).ok, false)

	// 시간대: T0는 15시 KST. 23~6시 규칙은 낮에는 걸리지 않고 23시가 되면 걸린다.
	const night = validateRule({ ...r.rule, id: 'light_on_night', also: [], for_minutes: 0, hour_from: 23, hour_to: 6 }, home).rule
	const e2 = new RuleEngine([night], {})
	e2.initAll(home, T0)
	assert.equal(e2.tick(home, T0 + 60 * MIN).length, 0)
	assert.equal(e2.tick(home, T0 + 8 * 60 * MIN + MIN).length, 1, '23시 1분')
	// 덧붙은 조건이 없는 규칙은 예전과 같은 key라 다시 무장되지 않는다.
	assert.equal(ruleKey(rule()), JSON.stringify(['binary_sensor.door', null, 'eq', 'on', 10]))
	assert.notEqual(ruleKey(night), ruleKey({ ...night, hour_from: null, hour_to: null }))
})

test('규칙 확장: 변화 횟수(changes_gt)와 변화 폭(rise_gt)', () => {
	const m = new Map([['binary_sensor.door', st('binary_sensor.door', 'off')], ['sensor.humidity', st('sensor.humidity', '50')]])
	const flap = rule({ id: 'door_flap', op: 'changes_gt', value: 3, for_minutes: 10, cooldown_minutes: 0 })
	const jump = rule({ id: 'humid_jump', entity_id: 'sensor.humidity', op: 'rise_gt', value: 15, for_minutes: 15, cooldown_minutes: 0 })
	assert.equal(validateRule(flap, m).ok, true)
	assert.equal(validateRule({ ...flap, for_minutes: 0 }, m).ok, false)
	const e = new RuleEngine([flap, jump], {})
	e.initAll(m, T0)
	let fired = []
	for (let i = 1; i <= 4; i++) fired = e.onState('binary_sensor.door', st('binary_sensor.door', i % 2 ? 'on' : 'off', T0 + i * MIN), T0 + i * MIN, m)
	assert.equal(fired.length, 1, '10분 안에 4번 바뀌면 발동')
	assert.equal(e.tick(m, T0 + 20 * MIN).length, 0)
	assert.equal(e.rt.door_flap.fired, false, '구간이 지나면 풀림')
	assert.equal(e.onState('sensor.humidity', st('sensor.humidity', '60', T0 + 5 * MIN), T0 + 5 * MIN, m).length, 0)
	assert.equal(e.onState('sensor.humidity', st('sensor.humidity', '68', T0 + 9 * MIN), T0 + 9 * MIN, m).length, 1, '15분 안에 50→68')
	// 천천히 오른 것은 걸리지 않는다
	const e2 = new RuleEngine([jump], {})
	e2.initAll(m, T0)
	assert.equal(e2.onState('sensor.humidity', st('sensor.humidity', '60', T0 + 20 * MIN), T0 + 20 * MIN, m).length, 0)
	assert.equal(e2.onState('sensor.humidity', st('sensor.humidity', '68', T0 + 40 * MIN), T0 + 40 * MIN, m).length, 0)
})

test('stale은 값이 그대로여도 보고가 오면(last_reported) 걸리지 않는다', () => {
	const s = { ...st('sensor.humidity', '55', T0 - 120 * MIN), last_reported: new Date(T0 - 5 * MIN).toISOString() }
	assert.equal(condition(rule({ op: 'stale', value: null, for_minutes: 60 }), s, T0), false)
	assert.equal(condition(rule({ op: 'stale', value: null, for_minutes: 60 }), { ...s, last_reported: undefined }, T0), true)
})

test('발동 뒤 풀린 시각을 남긴다(알림 뒤 해결됐는지 보는 자료)', () => {
	const e = new RuleEngine([rule({ for_minutes: 0 })], {})
	e.initAll(states, T0)
	assert.equal(e.onState('binary_sensor.door', st('binary_sensor.door', 'on', T0 + MIN), T0 + MIN).length, 1)
	e.onState('binary_sensor.door', st('binary_sensor.door', 'off', T0 + 8 * MIN), T0 + 8 * MIN)
	assert.deepEqual(e.rt.door_open_long.clear_log, [[T0 + MIN, T0 + 8 * MIN]])
})

test('답 검사: 휴대폰 명령으로 읽히는 문구는 알림에서 빼고, 행동과 자료 요청을 다듬는다', () => {
	for (const m of ['remove_channel', 'clear_notification', 'command_dnd', ' TTS ', 'request_location_update']) assert.equal(isReservedMessage(m), true, m)
	assert.equal(isReservedMessage('환풍기가 켜져 있어요'), false)
	const r = validateResponse({
		notifications: [{ kind: 'info', level: 'normal', title: 't', message: 'remove_channel', related_rule_ids: [] }, { kind: 'info', level: 'normal', title: 't', message: '정상 문구', related_rule_ids: [] }],
		actions: [{ entity_id: 'light.a', action: 'turn_off', reason: '이유' }, { entity_id: 'lock.door', action: 'unlock', reason: 'x' }, { entity_id: 'light.a', action: 'turn_on', reason: '' }],
		info_requests: [{ kind: 'statistics', entity_ids: ['a'], hours: 99999 }, { kind: 'weird', entity_ids: ['a'], hours: 500 }, { kind: 'logbook', entity_ids: ['a'], hours: 500 }],
	})
	assert.deepEqual(r.notifications.map(n => n.message), ['정상 문구'])
	assert.deepEqual(r.actions, [{ entity_id: 'light.a', action: 'turn_off', reason: '이유', requested: false }])
	assert.equal(validateResponse({ actions: [{ entity_id: 'light.a', action: 'turn_off', reason: '이유', requested: true }] }).actions[0].requested, true)
	assert.equal(validateResponse({ actions: [{ entity_id: 'light.a', action: 'turn_off', reason: '이유', requested: 'yes' }] }).actions[0].requested, false, '참(true)일 때만')
	assert.deepEqual(r.info_requests.map(q => [q.kind, q.hours]), [['statistics', 2160], ['history', 168], ['logbook', 72]])
})

test('HA 명령 검사: 읽기·알림·heartbeat·허용한 엔티티의 켜기/끄기만 통과', () => {
	const guard = { services: new Set(['notify.mobile_app_x', 'weather.get_forecasts']), actionEntities: new Set(['light.a', 'lock.door', 'media_player.tv']) }
	const svc = (domain, service, target, service_data = {}) => checkMessage({ type: 'call_service', domain, service, target, service_data }, guard)
	assert.equal(svc('notify', 'mobile_app_x'), null)
	assert.match(svc('notify', 'mobile_app_other'), /허용되지 않은/)
	assert.equal(svc('light', 'turn_off', { entity_id: 'light.a' }), null)
	assert.match(svc('light', 'turn_off', { entity_id: 'light.b' }), /허용되지 않은/, '목록에 없는 엔티티')
	assert.match(svc('light', 'turn_off', { entity_id: ['light.a', 'light.b'] }), /허용되지 않은/, '여러 엔티티')
	assert.match(svc('light', 'turn_off', { entity_id: 'light.a', area_id: 'geosil' }), /허용되지 않은/, '영역 지정')
	assert.match(svc('light', 'turn_on', { entity_id: 'light.a' }, { brightness: 255 }), /허용되지 않은/, '추가 데이터')
	assert.match(svc('lock', 'unlock', { entity_id: 'lock.door' }), /허용되지 않은/, '설정에 적어도 도어락은 안 됨')
	assert.match(svc('media_player', 'turn_on', { entity_id: 'media_player.tv' }), /허용되지 않은/)
	assert.match(svc('homeassistant', 'turn_off', { entity_id: 'light.a' }), /허용되지 않은/)
	assert.equal(checkMessage({ type: 'fire_event', event_type: HEARTBEAT_EVENT }, guard), null)
	assert.match(checkMessage({ type: 'fire_event', event_type: 'call_service' }, guard), /허용되지 않은 이벤트/)
	assert.match(checkMessage({ type: 'config/automation/config/x' }, guard), /허용되지 않은 명령/)
})

// 2026-11-14 23:00: 재연결 한 번이 실패하자 Node WebSocket이 error만 보내고 close를 보내지 않아 집 비서가 HA에 영영 다시 붙지 않았다.
async function countReconnects(onConn, opts = {}) {
	let n = 0
	const socks = []
	const srv = createServer(c => { n++; socks.push(c); onConn(c) })
	await new Promise(r => srv.listen(0, '127.0.0.1', r))
	const ha = new HA({ url: `ws://127.0.0.1:${srv.address().port}/api/websocket`, tokenFile: '/dev/null', notifyTargets: [], ...opts })
	ha.backoff = 20
	const quiet = console.log
	console.log = () => {}
	try {
		ha.start()
		await new Promise(r => setTimeout(r, 700))
	} finally {
		console.log = quiet
		ha.stop()
		for (const c of socks) c.destroy()
		srv.close()
	}
	return n
}

test('HA 연결: 접속이 실패해도(error만 옴) 계속 다시 연결한다', async () => {
	assert.ok(await countReconnects(c => c.once('data', () => c.destroy())) >= 3, '업그레이드 도중 끊김')
	assert.ok(await countReconnects(c => c.once('data', () => c.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'))) >= 3, '502 응답')
})

test('HA 연결: 접속이 응답 없이 걸려 있으면 시간 초과로 끊고 다시 연결한다', async () => {
	assert.ok(await countReconnects(() => {}, { openTimeoutMs: 100 }) >= 2)
})

test('행동 검사: 등급, 이미 그 상태, 한도, 조용한 시간', () => {
	const cfg = mergeConfig({ actions: { enabled: true, auto: ['light.a', 'switch.c', 'lock.door'], confirm: ['switch.b', 'switch.c'] } })
	const tiers = actionTiers(cfg)
	assert.equal(tiers.get('switch.c'), 'confirm', '양쪽에 있으면 confirm')
	assert.equal(tiers.has('lock.door'), false, '쓸 수 없는 도메인은 등급에 들어가지 않음')
	assert.equal(actionTiers(mergeConfig({ actions: { auto: ['light.a'] } })).size, 0, 'enabled가 꺼져 있으면 없음')
	const sm = new Map([['light.a', st('light.a', 'on')], ['switch.b', st('switch.b', 'on')], ['switch.c', st('switch.c', 'unavailable')]])
	const base = { tiers, states: sm, quiet: false, usedToday: 0, perDay: 20, pending: [] }
	assert.deepEqual(checkAction({ entity_id: 'light.a', action: 'turn_off' }, base), { ok: true, tier: 'auto' })
	assert.deepEqual(checkAction({ entity_id: 'light.a', action: 'turn_on' }, base), { ok: true, noop: true })
	assert.equal(checkAction({ entity_id: 'light.z', action: 'turn_off' }, base).ok, false)
	assert.equal(checkAction({ entity_id: 'switch.c', action: 'turn_off' }, base).ok, false, 'unavailable')
	assert.equal(checkAction({ entity_id: 'light.a', action: 'turn_off' }, { ...base, usedToday: 20 }).ok, false)
	assert.equal(checkAction({ entity_id: 'switch.b', action: 'turn_off' }, { ...base, pending: [{ entity_id: 'switch.b' }] }).ok, false)
	assert.equal(checkAction({ entity_id: 'light.a', action: 'turn_off' }, { ...base, quiet: true }).ok, true, '밤에도 스스로 끄기는 됨')
	assert.equal(checkAction({ entity_id: 'switch.b', action: 'turn_off' }, { ...base, quiet: true }).ok, false, '밤에는 승인 요청을 보내지 않음')
	const ap = approvalPayload({ aid: 'x1', name: '거실 조명', action: 'turn_off', reason: '아무도 없어요.' }, 30)
	assert.deepEqual(ap.data.actions.map(x => x.action), ['HAAGENT_DO_x1', 'HAAGENT_NO_x1'])
	for (const x of ap.data.actions) assert.match(x.action, ACTION_RE)
	const done = actionResultPayload({ aid: 'x1', name: '거실 조명', action: 'turn_off', reason: '아무도 없어요.', status: 'done' }, { undo: true })
	assert.equal(done.data.tag, ap.data.tag, '승인 알림을 결과로 덮어씀')
	assert.equal(done.data.actions[0].action, 'HAAGENT_UNDO_x1')
})

test('하루 요약: 변화 횟수와 켜져 있던 시간', () => {
	const d0 = Date.parse('2026-11-10T00:00:00+09:00')
	const ev = (id, h, from, to) => ({ t: d0 + h * 60 * MIN, id, name: id, from, to })
	const d = dailyDigest('2026-11-10', [ev('light.a', 7, 'off', 'on'), ev('light.a', 8, 'on', 'off'), ev('light.a', 20, 'off', 'on'), ev('light.b', 30, 'off', 'on')])
	assert.deepEqual(d['light.a'], { name: 'light.a', changes: 3, first: '07:00', last: '20:00', active_min: 60 + 240 })
	assert.equal(d['light.b'], undefined, '다음 날 것은 빠짐')
})

test('프롬프트: 복합 규칙, 행동 권한, 사용자 말, 추가 자료가 드러난다', () => {
	const r = { ...rule(), also: [{ entity_id: 'person.x', attribute: null, op: 'eq', value: 'not_home' }], hour_from: 23, hour_to: 6 }
	const p = buildPrompt({
		guide: '# 지침', now: T0, quiet: false, reasons: [{ type: 'user', text: '거실 불 꺼줘', about: '요약' }, { type: 'rule', rule_id: 'x', description: 'd', entity_id: 'e', value: 1, since: T0, pre_notified: true, attempts: 1 }],
		rules: [r], runtime: { door_open_long: { clear_log: [[T0, T0 + 7 * MIN]] } }, schedule: [], memory: '', recentNotes: [{ nid: 'n1', ts: new Date(T0 - 20 * 60 * MIN).toISOString(), kind: 'alert', level: 'normal', status: 'queued', title: '어제 알림', message: 'm' }],
		feedback: [{ ts: new Date(T0).toISOString(), nid: 'n1', kind: 'reply', title: '어제 알림', text: '고마워' }], held: [], rejected: [], ring: [], weather: null, calendar: [],
		actions: { today: 1, perDay: 20, tiers: [{ id: 'light.a', name: '거실', tier: 'auto', state: 'on' }], recent: [{ ts: new Date(T0).toISOString(), name: '거실', action: 'turn_off', status: 'undone', reason: '빈 집' }] },
		metrics: { runs: 3 }, infoFiles: [{ file: 'run/info-1-logbook.json', kind: 'logbook', entity_ids: ['light.a'], hours: 24 }], lastRound: true,
	})
	for (const s of ['[사용자 말]', '거실 불 꺼줘', '이미 긴급 알림으로', '2번째 시도', '그리고 person.x eq "not_home"', '(23~6시만)', '풀리기까지 7분', '어제 알림', '다시 보내는 중', '💬 답장', '스스로 실행', '사용자가 되돌림', '지난 7일 지표', 'runs=3', 'run/info-1-logbook.json', '더는 요청할 수 없으니']) assert.ok(p.includes(s), s)
	assert.ok(buildPrompt({ guide: 'g', now: T0, quiet: false, reasons: [], rules: [], runtime: {}, schedule: [], memory: '', ring: [], weather: null, calendar: [] }).includes('없음. actions는 빈 배열'))
})

test('주간 자료: 자동화 실행 횟수·시간대·트리거, 기기 조작의 출처와 서로 되돌린 일', () => {
	const d0 = Date.parse('2026-11-10T00:00:00+09:00'), at = (h, m = 0) => (d0 + h * 60 * MIN + m * MIN) / 1000
	const period = { from: d0 - 6 * 24 * 60 * MIN, to: d0 + 24 * 60 * MIN }
	const run = (id, h, source) => ({ entity_id: id, name: id, message: source ? `triggered by ${source}` : 'triggered', source, when: at(h) })
	const a = automationRuns([run('automation.a', 23, 'time pattern'), run('automation.a', 7, 'state of sensor.x'), run('automation.a', 7.5, 'state of sensor.x'), run('automation.b', 9), { entity_id: 'automation.a', state: 'off', when: at(10) }],
		[{ id: 'automation.b', name: 'B', state: 'on', last_triggered: '2026-11-10 09:00' }, { id: 'automation.a', name: 'A', state: 'on', last_triggered: '2026-11-10 23:00' }, { id: 'automation.c', name: 'C', state: 'off', last_triggered: null }], period)
	assert.deepEqual(a.period, { from: '2026-11-04 00:00', to: '2026-11-11 00:00', oldest_record: '2026-11-10 07:00' })
	assert.deepEqual(a.automations.map(x => [x.id, x.runs]), [['automation.a', 3], ['automation.b', 1], ['automation.c', 0]])
	assert.deepEqual(a.automations[0].by_hour, { '07시': 2, '23시': 1 })
	assert.deepEqual(a.automations[0].by_day, { '11-10(화)': 3 })
	assert.deepEqual(a.automations[0].triggers, { 'state of sensor.x': 2, 'time pattern': 1 })
	assert.deepEqual(a.automations[1].triggers, { '출처 없음': 1 })
	assert.deepEqual(a.automations[2], { id: 'automation.c', name: 'C', state: 'off', runs: 0, last_triggered: null })

	const auto = { context_event_type: 'automation_triggered', context_domain: 'automation', context_name: '심야 소등', context_entity_id: 'automation.night', context_source: 'time' }
	const svc = { context_event_type: 'call_service', context_domain: 'light', context_service: 'turn_on', context_user_id: 'u' }
	const row = (id, h, m, state, ctx = {}) => ({ entity_id: id, state, when: at(h, m), ...ctx })
	const d = deviceActivity([
		row('light.a', 7, 0, 'on'), // 물리 버튼
		row('light.a', 23, 0, 'off', auto), // 자동화가 끔
		row('light.a', 23, 4, 'on', svc), // 4분 뒤 사람이 다시 켬 → reverted
		row('light.a', 23, 30, 'off', svc), // 사람이 끔
		row('light.a', 23, 33, 'on', auto), // 3분 뒤 자동화가 다시 켬 → overridden
		row('light.a', 23, 50, 'unavailable'),
		row('light.a', 23, 55, 'on'), // 연결이 돌아오며 찍힌 상태는 조작이 아님
		{ entity_id: 'light.a', name: '불', message: '끔: 심야', when: at(23, 0), ...auto },
		row('switch.idle', 5, 0, 'unknown'),
	], new Map([['light.a', st('light.a', 'on', T0, { friendly_name: '거실 불' })]]), new Map([['light.a', '거실']]), period)
	const l = d.devices.find(x => x.id === 'light.a')
	assert.equal(l.name, '거실 불')
	assert.equal(l.area, '거실')
	assert.equal(l.changes, 5)
	assert.equal(l.manual_count, 3)
	assert.equal(l.unavailable_count, 1)
	assert.deepEqual(l.by_source, { '서비스 호출(앱·대시보드·음성·집 비서)': 2, '자동화: 심야 소등': 2, '기기에서 직접(물리 버튼·리모컨·기기 자체)': 1 })
	assert.equal(l.manual[0], '11-10(화) 07:00 on · 기기에서 직접(물리 버튼·리모컨·기기 자체)')
	assert.deepEqual(l.reverted, [{ at: '11-10(화) 23:04', automation: '자동화: 심야 소등', trigger: 'time', did: 'on → off', undone_after_min: 4, by: '서비스 호출(앱·대시보드·음성·집 비서)' }])
	assert.deepEqual(l.overridden, [{ at: '11-10(화) 23:33', person_did: 'on → off', undone_after_min: 3, by: '자동화: 심야 소등', trigger: 'time' }])
	assert.deepEqual(l.automation_notes, ['11-10(화) 23:00 끔: 심야 ← 자동화: 심야 소등'])
	assert.deepEqual(d.devices.find(x => x.id === 'switch.idle'), { id: 'switch.idle', name: 'switch.idle', changes: 0, by_source: {}, unavailable_count: 1, manual_count: 0 })
	assert.deepEqual(deviceActivity(null, new Map(), null, period).devices, [])
})

test('주간 분석 설정과 답: 요일을 맞추고, 보고서는 길이를 자른다', () => {
	assert.deepEqual(DEFAULTS.weekly, { enabled: true, weekday: '일', hour: 21, timeout_seconds: 900, publish: true })
	assert.equal(mergeConfig({ weekly: { weekday: 3 } }).weekly.weekday, '수')
	assert.equal(mergeConfig({ weekly: { weekday: '토요일', hour: 9 } }).weekly.weekday, '토')
	assert.equal(mergeConfig({ weekly: { weekday: 'Sunday' } }).weekly.weekday, '일')
	assert.equal(mergeConfig({ weekly: { hour: 9 } }).weekly.hour, 9)
	assert.equal(validateResponse({}).report, '')
	assert.equal(validateResponse({ report: 42 }).report, '')
	assert.equal(validateResponse({ report: 'x'.repeat(30000) }).report.length, 20000)
	const p = buildPrompt({ guide: 'g', now: T0, quiet: false, reasons: [{ type: 'weekly' }], rules: [], runtime: {}, schedule: [], memory: '', ring: [], weather: null, calendar: [], lastReport: '2026-11-08.md' })
	for (const s of ['[주간 분석]', 'run/weekly-automations.json', 'run/weekly-devices.json', 'run/weekly-last-report.md: 지난 주간 분석 보고서 (2026-11-08)']) assert.ok(p.includes(s), s)
	assert.ok(!buildPrompt({ guide: 'g', now: T0, quiet: false, reasons: [{ type: 'hourly', hour: 9 }], rules: [], runtime: {}, schedule: [], memory: '', ring: [], weather: null, calendar: [] }).includes('weekly-'))
})

test('판단 방식: control.json이 config.json보다 먼저, api에 적지 않은 값은 codex 값을 쓴다', () => {
	const cfg = mergeConfig({ codex: { model: 'm-codex', effort: 'high' }, api: { effort: 'low' } })
	assert.equal(brainMode(cfg, {}), 'codex')
	assert.equal(brainMode(mergeConfig({ brain: 'api' }), {}), 'api')
	assert.equal(brainMode(mergeConfig({ brain: 'api' }), { brain: 'codex' }), 'codex')
	assert.equal(brainMode(cfg, { brain: 'api' }), 'api')
	assert.equal(brainMode(mergeConfig({ brain: '엉뚱한 값' }), { brain: 'x' }), 'codex')
	assert.deepEqual([brainSettings(cfg, 'codex').effort, brainSettings(cfg, 'api').effort], ['high', 'low'])
	assert.equal(brainSettings(cfg, 'api').model, 'm-codex')
	assert.equal(brainSettings(mergeConfig({ api: { model: 'm-api' } }), 'api').model, 'm-api')
	assert.equal(brainSettings(cfg, 'api').timeout_seconds, DEFAULTS.codex.timeout_seconds)
})

// API 방식 시험용 폴더: brain 구실을 하는 dir와, 그 밖에 둔 비밀 파일
function apiFixture() {
	const base = mkdtempSync(join(tmpdir(), 'haagent-api-'))
	const dir = join(base, 'brain')
	mkdirSync(join(dir, 'run'), { recursive: true })
	writeFileSync(join(dir, 'run', 'states.json'), JSON.stringify([{ id: 'light.a', name: '거실 불', state: 'on' }, { id: 'switch.b', name: '환풍기', state: 'off' }], null, 1))
	writeFileSync(join(dir, 'run', 'automation-configs.json'), JSON.stringify({ 'automation.x': { alias: '귀가 조명', triggers: [{ entity_id: 'person.me' }] } }, null, 1))
	writeFileSync(join(base, 'secret.txt'), 'TOKEN-123')
	writeFileSync(join(base, 'key'), 'sk-test\n')
	symlinkSync(join(base, 'secret.txt'), join(dir, 'run', 'link.txt'))
	const cfg = mergeConfig({ api: { key_file: join(base, 'key'), max_tool_calls: 3 } })
	return { base, dir, cfg, done: () => rmSync(base, { recursive: true, force: true }) }
}

test('API 키: 파일 → 환경 변수 → .env 순서, 없으면 오류', () => {
	const f = apiFixture()
	try {
		assert.equal(apiKey(f.cfg), 'sk-test')
		const cfg = mergeConfig({})
		const envFile = join(f.base, '.env')
		writeFileSync(envFile, '# 주석\nOTHER=1\nexport OPENAI_API_KEY="sk-from-file"\n')
		assert.equal(apiKey(cfg, { env: { OPENAI_API_KEY: ' sk-env ' }, envFile }), 'sk-env')
		assert.equal(apiKey(cfg, { env: {}, envFile }), 'sk-from-file')
		assert.throws(() => apiKey(cfg, { env: {}, envFile: join(f.base, 'none') }), /API 키를 찾지 못함/)
		assert.equal(selfCheck(f.cfg, 'api'), null)
		assert.match(selfCheck(mergeConfig({ api: { key_file: join(f.base, 'none') } }), 'api'), /ENOENT/)
	} finally { f.done() }
})

test('API 파일 도구: brain 폴더 안에서 읽기만, 밖으로 나가는 경로와 링크는 막는다', async () => {
	const f = apiFixture()
	try {
		const ctx = { brainDir: f.dir }, call = (name, args) => runTool(name, JSON.stringify(args), ctx)
		const listed = await call('list_files', {})
		assert.match(listed, /run\/states\.json/)
		assert.ok(!listed.includes('link.txt'), '링크는 목록에 없음')
		assert.match(await call('read_file', { path: 'run/states.json', start_line: 1, max_lines: 3 }), /^1: \[\n2: {2}\{\n3: {3}"id": "light\.a",\n\(전체 \d+줄 가운데 1~3줄\)$/)
		assert.match(await call('grep', { pattern: '"id": "switch\\.', path: 'run/states.json', context: 1, max_matches: null }), /환풍기/)
		assert.match(await call('grep', { pattern: '귀가', path: null, context: null, max_matches: null }), /^run\/automation-configs\.json:\d+:/m)
		assert.equal(await call('grep', { pattern: '없는말', path: null, context: null, max_matches: null }), '(찾은 줄 없음)')
		assert.equal(JSON.parse(await call('json_get', { path: 'run/states.json', keys: ['switch.b'] })).name, '환풍기')
		assert.equal(JSON.parse(await call('json_get', { path: 'run/automation-configs.json', keys: ['automation.x', 'triggers', '0'] })).entity_id, 'person.me')
		assert.match(await call('json_get', { path: 'run/states.json', keys: ['light.none'] }), /^\(없음/)
		for (const path of ['../secret.txt', join(f.base, 'secret.txt'), 'run/link.txt', '/etc/passwd', 'run/../../key']) {
			for (const [name, args] of [['read_file', { path, start_line: null, max_lines: null }], ['grep', { pattern: '.', path, context: null, max_matches: null }], ['json_get', { path, keys: [] }]]) {
				const out = await call(name, args)
				assert.match(out, /^오류: /, `${name} ${path}`)
				assert.ok(!out.includes('TOKEN-123') && !out.includes('sk-test') && !out.includes('root:'), `${name} ${path}`)
			}
		}
		assert.ok(!(await call('grep', { pattern: 'TOKEN', path: null, context: null, max_matches: null })).includes('TOKEN-123'), '전체 검색도 링크를 따라가지 않음')
		assert.match(await runTool('exec', '{}', ctx), /없는 도구/)
		assert.match(await runTool('read_file', '{잘못된 JSON', ctx), /^오류: /)
		assert.deepEqual(TOOLS.map(t => t.name), ['list_files', 'grep', 'json_get', 'read_file'], '읽기 도구뿐')
	} finally { f.done() }
})

test('API 판단: 도구 호출을 처리해 되돌려 보내고, 스키마에 맞춘 답과 토큰 합계를 돌려준다', async () => {
	const f = apiFixture()
	try {
		const ans = { summary: '요약', notifications: [], rule_changes: { upsert: [], delete: [] }, next_wakes: [], memory: { mode: 'keep', text: '' }, info_requests: [], actions: [], report: '' }
		const sent = []
		const replies = [
			{ status: 'completed', usage: { total_tokens: 100 }, output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' }, { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'json_get', arguments: JSON.stringify({ path: 'run/states.json', keys: ['light.a'] }) }, { type: 'function_call', id: 'fc_2', call_id: 'c2', name: 'read_file', arguments: JSON.stringify({ path: '../secret.txt', start_line: null, max_lines: null }) }] },
			{ status: 'completed', usage: { total_tokens: 150 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ans) }] }] },
		]
		const fetchFn = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => replies[sent.length - 1] } }
		const r = await runApi({ cfg: f.cfg, prompt: '프롬프트', effort: 'low', timeoutSec: 5, model: 'm1', brainDir: f.dir, runDir: join(f.dir, 'run'), fetchFn })
		assert.deepEqual(r.result, ans)
		assert.equal(r.tokens, 250)
		assert.equal(r.tool_calls, 2)
		assert.equal(sent.length, 2)
		const [a, b] = sent.map(s => s.body)
		assert.equal(sent[0].url, 'https://api.openai.com/v1/responses')
		assert.equal(sent[0].init.headers.authorization, 'Bearer sk-test')
		assert.equal(a.model, 'm1')
		assert.equal(a.store, false, '대화를 OpenAI에 저장하지 않음')
		assert.deepEqual(a.include, ['reasoning.encrypted_content'])
		assert.deepEqual(a.reasoning, { effort: 'low' })
		assert.equal(a.text.format.type, 'json_schema')
		assert.equal(a.text.format.strict, true)
		assert.ok(a.text.format.schema.required.includes('report'))
		assert.ok(a.tools.every(t => t.type === 'function' && t.strict), '웹 검색·코드 실행 같은 도구는 주지 않음')
		assert.deepEqual(a.input, [{ role: 'user', content: '프롬프트' }])
		assert.deepEqual(b.input.map(i => i.type ?? i.role), ['user', 'reasoning', 'function_call', 'function_call', 'function_call_output', 'function_call_output'])
		assert.equal(JSON.parse(b.input[4].output).name, '거실 불')
		assert.match(b.input[5].output, /^오류: /)
		assert.ok(!JSON.stringify(b).includes('TOKEN-123'))
	} finally { f.done() }
})

test('API 판단: 도구 한도에 닿으면 도구 없이 답을 받고, 오류·거절·시간 초과는 실패로 올린다', async () => {
	const f = apiFixture()
	try {
		const base = { cfg: f.cfg, prompt: 'p', effort: 'low', timeoutSec: 5, model: 'm1', brainDir: f.dir, runDir: join(f.dir, 'run') }
		const callOut = n => ({ status: 'completed', usage: { total_tokens: 1 }, output: Array.from({ length: n }, (_, i) => ({ type: 'function_call', call_id: `c${i}`, name: 'list_files', arguments: '{}' })) })
		const msg = content => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ type: 'message', content }] }) })
		const choices = []
		const r = await runApi({ ...base, fetchFn: async (_u, init) => { const b = JSON.parse(init.body); choices.push(b.tool_choice); return b.tool_choice === 'none' ? msg([{ type: 'output_text', text: '{"summary":"끝"}' }]) : { ok: true, status: 200, json: async () => callOut(2) } } })
		assert.deepEqual(choices, ['auto', 'auto', 'none'], '한도(3번)를 넘기면 도구를 끈다')
		assert.equal(r.result.summary, '끝')
		await assert.rejects(runApi({ ...base, fetchFn: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'Incorrect API key' } }) }) }), /API 오류 401: Incorrect API key/)
		await assert.rejects(runApi({ ...base, fetchFn: async () => msg([{ type: 'refusal', refusal: '안 됨' }]) }), /거절/)
		await assert.rejects(runApi({ ...base, fetchFn: async () => msg([{ type: 'output_text', text: '{깨진' }]) }), /API 답을 읽지 못함/)
		await assert.rejects(runApi({ ...base, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }) }) }), /중간에 끊김: max_output_tokens/)
		const hang = (_u, init) => new Promise((_, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason)))
		await assert.rejects(runApi({ ...base, timeoutSec: 0.05, fetchFn: hang }), /API 응답 시간 초과/)
	} finally { f.done() }
})

test('쿨다운·쉼 안에 다시 시작돼 이어지는 상황은 그 시간이 끝날 때 발동한다', () => {
	const door = (s, t) => st('binary_sensor.door', s, t)
	const e = new RuleEngine([rule({ for_minutes: 0, cooldown_minutes: 60 })], {})
	e.initAll(states, T0)
	assert.equal(e.onState('binary_sensor.door', door('on', T0 + MIN), T0 + MIN).length, 1)
	e.onState('binary_sensor.door', door('off', T0 + 5 * MIN), T0 + 5 * MIN)
	assert.equal(e.onState('binary_sensor.door', door('on', T0 + 10 * MIN), T0 + 10 * MIN).length, 0, '쿨다운 안이라 미룸')
	const open = new Map([['binary_sensor.door', door('on', T0 + 10 * MIN)]])
	assert.equal(e.rt.door_open_long.waiting, true)
	assert.equal(e.tick(open, T0 + 59 * MIN).length, 0)
	assert.equal(e.tick(open, T0 + 62 * MIN).length, 1, '쿨다운이 끝났는데 아직 참이면 발동')
	assert.equal(e.tick(open, T0 + 200 * MIN).length, 0, '그 뒤로는 한 번만')
	// 미뤄 둔 사이 풀리면 발동하지 않는다
	const e2 = new RuleEngine([rule({ for_minutes: 0, cooldown_minutes: 60 })], {})
	e2.initAll(states, T0)
	e2.onState('binary_sensor.door', door('on', T0 + MIN), T0 + MIN)
	e2.onState('binary_sensor.door', door('off', T0 + 5 * MIN), T0 + 5 * MIN)
	e2.onState('binary_sensor.door', door('on', T0 + 10 * MIN), T0 + 10 * MIN)
	e2.onState('binary_sensor.door', door('off', T0 + 20 * MIN), T0 + 20 * MIN)
	assert.equal(e2.tick(states, T0 + 62 * MIN).length, 0)
	// 쉬는(mute) 동안 시작된 상황도 쉼이 끝날 때 아직 참이면 알린다. 알린 뒤에 누른 [이건 그만]은 다시 알리지 않는다.
	const e3 = new RuleEngine([rule({ for_minutes: 0, cooldown_minutes: 0 })], {})
	e3.initAll(states, T0)
	e3.mute('door_open_long', T0 + 30 * MIN)
	assert.equal(e3.onState('binary_sensor.door', door('on', T0 + MIN), T0 + MIN).length, 0)
	assert.equal(e3.tick(new Map([['binary_sensor.door', door('on', T0 + MIN)]]), T0 + 31 * MIN).length, 1)
	e3.mute('door_open_long', T0 + 90 * MIN)
	assert.equal(e3.tick(new Map([['binary_sensor.door', door('on', T0 + MIN)]]), T0 + 91 * MIN).length, 0)
})

test('older_than: 값이 가리키는 시각이 정한 분보다 오래되면 참, 시각이 아닌 엔티티에는 못 쓴다', () => {
	const backup = at => st('sensor.backup', new Date(at).toISOString().replace('Z', '+00:00'))
	const sm = new Map([...states, ['sensor.backup', backup(T0 - 60 * MIN)]])
	const r = rule({ id: 'backup_old', entity_id: 'sensor.backup', op: 'older_than', value: 2880, for_minutes: 0 })
	assert.equal(validateRule(r, sm).ok, true)
	assert.match(validateRule({ ...r, entity_id: 'sensor.humidity' }, sm).error, /시각\(timestamp\)/)
	assert.match(validateRule({ ...r, for_minutes: 10 }, sm).error, /for_minutes는 0/)
	assert.equal(validateRule({ ...r, value: 0 }, sm).ok, false)
	assert.equal(condition(r, backup(T0 - 47 * 60 * MIN), T0), false)
	assert.equal(condition(r, backup(T0 - 49 * 60 * MIN), T0), true)
	assert.equal(condition(r, st('sensor.backup', 'unknown'), T0), false)
	// 상태 변화가 없어도 시간이 흘러 참이 되면 tick에서 발동한다
	const e = new RuleEngine([r], {})
	e.initAll(sm, T0)
	assert.equal(e.tick(sm, T0 + 46 * 60 * MIN).length, 0)
	assert.equal(e.tick(sm, T0 + 47 * 60 * MIN + MIN).length, 1)
	// 속성(예: 자동화의 last_triggered)에도 쓸 수 있다
	const auto = st('automation.x', 'on', T0, { last_triggered: new Date(T0 - 10 * 24 * 60 * MIN).toISOString() })
	assert.equal(condition(rule({ entity_id: 'automation.x', attribute: 'last_triggered', op: 'older_than', value: 7 * 1440, for_minutes: 0 }), auto, T0), true)
})

test('규칙 백테스트: 지난 기록에 같은 규칙 엔진을 돌려 발동 횟수를 센다', () => {
	const from = T0 - 7 * 24 * 60 * MIN, at = (h, m = 0) => (from + h * 60 * MIN + m * MIN) / 1000
	const hist = {
		'binary_sensor.door': [{ s: 'off', lu: at(-5) }, { s: 'on', lu: at(10) }, { s: 'off', lu: at(10, 5) }, { s: 'on', lu: at(20) }, { s: 'off', lu: at(20, 30) }, { s: 'on', lu: at(20, 40) }, { s: 'off', lu: at(21, 30) }, { s: 'on', lu: at(100) }, { s: 'off', lu: at(101) }],
		'person.x': [{ s: 'home', lu: at(-1) }, { s: 'not_home', lu: at(90) }],
	}
	// 10분 지속: 5분 열림은 빠지고 30분·50분·60분 열림이 걸리지만, 둘째(20:40)는 첫 발동(20:10)의 쿨다운 30분 안에 시작돼 쿨다운이 끝나는 20:40~에 이어져 있어 한 번 더 센다
	const b = backtestRule(rule(), hist, from, T0)
	assert.equal(b.fires, 3)
	assert.equal(b.days, 7)
	assert.ok(b.last)
	assert.equal(backtestRule(rule({ for_minutes: 0, cooldown_minutes: 0 }), hist, from, T0).fires, 4, '지속 조건이 없으면 열릴 때마다')
	assert.equal(backtestRule(rule({ for_minutes: 0, cooldown_minutes: 0, also: [{ entity_id: 'person.x', attribute: null, op: 'eq', value: 'not_home' }] }), hist, from, T0).fires, 1, 'also까지 참일 때만')
	assert.equal(backtestRule(rule({ id: 'flap', op: 'changes_gt', value: 3, for_minutes: 120, cooldown_minutes: 0 }), hist, from, T0).fires, 1)
	assert.equal(backtestRule(rule({ entity_id: 'sensor.none' }), hist, from, T0), null, '기록이 없으면 판단하지 않음')
	assert.equal(backtestable(rule({ op: 'stale', value: null })), false)
	assert.equal(backtestable(rule({ attribute: 'x' })), false)
	// 구간이 시작될 때 이미 참이던 것은 세지 않는다
	assert.equal(backtestRule(rule({ for_minutes: 0 }), { 'binary_sensor.door': [{ s: 'on', lu: at(-3) }] }, from, T0).fires, 0)
})

test('최근 변화: 짧은 사이 되풀이된 변화는 한 줄로 묶고 소음은 횟수만 남긴다', () => {
	const c = (m, id, from, to) => ({ t: T0 + m * MIN, id, name: id, from, to })
	const list = [
		c(0, 'lock.door', 'locked', 'unlocking'), c(0.2, 'lock.door', 'unlocking', 'unlocked'), c(1, 'lock.door', 'unlocked', 'locking'), c(1.2, 'lock.door', 'locking', 'locked'),
		c(2, 'light.a', 'off', 'on'), c(3, 'light.a', 'on', 'off'),
		...Array.from({ length: 12 }, (_, i) => c(10 + i, 'media_player.stb', i % 2 ? 'playing' : 'idle', i % 2 ? 'idle' : 'playing')),
		c(30, 'binary_sensor.ipad_kiosk_screensaver', 'on', 'off'), c(40, 'binary_sensor.ipad_kiosk_screensaver', 'off', 'on'),
		c(50, 'light.a', 'off', 'on'),
	]
	const lines = changeLines(list, globs(['binary_sensor.*_kiosk_screensaver']))
	assert.equal(lines.length, 6)
	assert.match(lines[0], /lock\.door\) 4번 바뀜: locked → unlocking → unlocked → locking → locked/)
	assert.match(lines[1], /light\.a\) off → on/)
	assert.match(lines[3], /media_player\.stb\) 12번 바뀜: idle → playing → idle → … → playing → idle/)
	assert.match(lines[4], /light\.a\) off → on/)
	assert.match(lines[5], /소음으로 분류해 줄임.*screensaver 2번/)
	assert.equal(significantChange(list[6], () => false), false, '재생↔대기는 집 상태가 달라진 것이 아님')
	assert.equal(significantChange(c(0, 'media_player.stb', 'off', 'playing')), true)
	assert.equal(significantChange(list.at(-2), globs(['binary_sensor.*_kiosk_screensaver'])), false)
	assert.equal(significantChange(list[4], globs(['binary_sensor.*_kiosk_screensaver'])), true)
})

test('지침 나누기와 하루 시간표: 깨움 종류에 맞는 절만 넣고, 시각은 설정에서 온다', () => {
	const guide = '공통\n<!-- only: weekly -->\n## 주간 분석\n주간 내용\n<!-- /only -->\n<!-- only: hourly, reflection -->\n## 정각 점검\n정각 내용\n<!-- /only -->\n끝'
	assert.equal(guideFor(guide, [{ type: 'weekly' }]), '공통\n## 주간 분석\n주간 내용\n끝')
	assert.equal(guideFor(guide, [{ type: 'rule' }, { type: 'reflection' }]), '공통\n## 정각 점검\n정각 내용\n끝')
	assert.equal(guideFor(guide, [{ type: 'user' }]), '공통\n끝')
	const base = { guide, now: T0, quiet: false, rules: [], runtime: {}, schedule: [], memory: '', ring: [], weather: null, calendar: [] }
	const p = buildPrompt({ ...base, reasons: [{ type: 'hourly', hour: 15 }], hours: { start: 7, end: 23, checkins: [7, 8, 22], reflection: 23 } })
	assert.ok(p.includes('정각 내용') && !p.includes('주간 내용'))
	assert.ok(p.includes('활동 시간 7~23시(그 밖은 조용한 시간), 정각 점검 7~22시, 하루 돌아보기 23시'))
	assert.ok(!buildPrompt({ ...base, reasons: [] }).includes('하루 시간표'), '예전 보관분(시간표 없음)도 다시 돌려볼 수 있다')
	// 실제 지침 파일: 주간 분석 절은 주간 깨움에만 들어간다
	const real = readFileSync(new URL('../brain/GUIDE.md', import.meta.url), 'utf8')
	assert.ok(guideFor(real, [{ type: 'weekly' }]).includes('weekly-devices.json'))
	assert.ok(!guideFor(real, [{ type: 'hourly' }]).includes('weekly-devices.json'))
	assert.ok(!/<!--/.test(guideFor(real, [{ type: 'hourly' }])), '표시는 프롬프트에 남지 않는다')
	assert.ok(guideFor(real, [{ type: 'hourly' }]).length < real.length * 0.85)
})

test('프롬프트: 백테스트 결과, 미뤄 둔 발동, 직접 시킨 행동 안내가 보인다', () => {
	const r = { ...rule({ cooldown_minutes: 60 }), also: [], hour_from: null, hour_to: null }
	const acts = { today: 0, perDay: 20, onRequest: true, tiers: [{ id: 'switch.b', name: '작은방', tier: 'confirm', state: 'on' }], recent: [] }
	const base = { guide: 'g', now: T0, quiet: false, rules: [r], runtime: { door_open_long: { fired: true, waiting: true, backtest: { fires: 21, days: 7, last: null } } }, schedule: [], memory: '', ring: [], weather: null, calendar: [], actions: acts }
	const p = buildPrompt({ ...base, reasons: [{ type: 'user', text: '작은방 불 꺼줘' }] })
	for (const s of ['백테스트: 만들 때 지난 7일 기록으로는 21회 발동했을 것', '지금 조건 참(쿨다운·쉼이 끝나면 발동)', 'requested=true로 낸다']) assert.ok(p.includes(s), s)
	assert.ok(!buildPrompt({ ...base, reasons: [{ type: 'hourly', hour: 9 }] }).includes('requested=true로 낸다'), '사용자 말로 깨어났을 때만')
})

test('설정 검증: 잘못된 범위·oob 누락은 오류, api의 max 상속은 경고', () => {
	assert.deepEqual(validateConfig(mergeConfig({})), { errors: [], warnings: [] })
	const bad = validateConfig(mergeConfig({ active_hours: { start: 23, end: 7 }, reflection_hour: 25, oob: { type: 'ntfy' } }))
	assert.ok(bad.errors.some(e => /active_hours/.test(e)))
	assert.ok(bad.errors.some(e => /reflection_hour/.test(e)))
	assert.ok(bad.errors.some(e => /oob\.topic/.test(e)))
	const warn = validateConfig(mergeConfig({ codex: { effort_deep: 'max' } }))
	assert.equal(warn.errors.length, 0)
	assert.ok(warn.warnings.some(w => /max/.test(w)))
})

test('규칙 7일 발동 필터, 타임존 없는 시각 파싱, null last_triggered 허용', () => {
	const old = T0 - 10 * 24 * 60 * MIN, recent = T0 - 2 * 24 * 60 * MIN
	assert.equal(recentFires({ fire_log: [old, recent] }, T0).length, 1)
	const p = buildPrompt({ guide: 'g', now: T0, quiet: false, reasons: [{ type: 'hourly', hour: 9 }], rules: [rule()], runtime: { door_open_long: { fire_log: [old, recent] } }, schedule: [], memory: '', ring: [], weather: null, calendar: [] })
	assert.ok(p.includes('7일 발동 1회'))
	const autoNull = st('automation.never', 'on', T0, { last_triggered: null })
	const sm = new Map([...states, ['automation.never', autoNull], ['sensor.no_tz', st('sensor.no_tz', '2026-11-11 10:00:00')]])
	assert.equal(validateRule(rule({ entity_id: 'automation.never', attribute: 'last_triggered', op: 'older_than', value: 60, for_minutes: 0 }), sm).ok, true)
	assert.equal(condition(rule({ entity_id: 'sensor.no_tz', op: 'older_than', value: 60, for_minutes: 0 }), sm.get('sensor.no_tz'), Date.parse('2026-11-11T12:00:00+09:00')), true)
})

test('다일 일정, 가전 가동 상태, readJsonlAll, effort_hourly 설정', () => {
	const cal = calendarText([
		{ calendar: '개인', start: '2026-11-19', end: '2026-11-22', summary: '제주 여행' },
		{ calendar: '개인', start: '2026-11-19', end: '2026-11-20', summary: '당일' },
		{ calendar: '개인', start: '2026-11-19T22:00:00+09:00', end: '2026-11-20T01:00:00+09:00', summary: '야간' },
	])
	assert.match(cal, /11-19\(목\)~11-21\(토\) 종일 제주 여행/)
	assert.match(cal, /11-19\(목\) 종일 당일/)
	assert.match(cal, /11-19\(목\) 22:00~11-20\(금\) 01:00 야간/)
	const d0 = Date.parse('2026-11-10T00:00:00+09:00')
	const d = dailyDigest('2026-11-10', [{ t: d0 + 60 * MIN, id: 'sensor.washer', name: '세탁기', from: 'power_off', to: 'washing' }, { t: d0 + 95 * MIN, id: 'sensor.washer', name: '세탁기', from: 'washing', to: 'power_off' }])
	assert.equal(d['sensor.washer'].active_min, 35)
	const cfg = mergeConfig({ codex: { effort: 'high', effort_hourly: 'low' }, api: { effort: 'medium' } })
	assert.equal(brainSettings(cfg, 'codex').effort_hourly, 'low')
	assert.equal(brainSettings(cfg, 'api').effort_hourly, 'medium')
	const tmp = mkdtempSync(join(tmpdir(), 'haagent-jsonl-'))
	try {
		const f = join(tmp, 'log.jsonl')
		writeFileSync(`${f}.1`, '{"a":1}\n')
		writeFileSync(f, '{"a":2}\n')
		assert.deepEqual(readJsonlAll(f), [{ a: 1 }, { a: 2 }])
	} finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('API 파일 도구 run/ 제한 및 세부 토큰·비추론 effort 생략', async () => {
	const f = apiFixture()
	try {
		writeFileSync(join(f.dir, 'GUIDE.md'), 'SECRET_OUTSIDE_RUN')
		const ctx = { brainDir: f.dir }
		assert.ok(!(await runTool('list_files', '{}', ctx)).includes('GUIDE.md'))
		assert.match(await runTool('read_file', JSON.stringify({ path: 'GUIDE.md', start_line: null, max_lines: null }), ctx), /^오류: 이 폴더 밖은/)
		assert.equal(await runTool('grep', JSON.stringify({ pattern: 'SECRET_OUTSIDE_RUN', path: null, context: null, max_matches: null }), ctx), '(찾은 줄 없음)')
		let seenBody = null
		const r = await runApi({
			cfg: f.cfg, prompt: 'p', effort: 'none', timeoutSec: 5, model: 'gpt-4o-mini', brainDir: f.dir, runDir: join(f.dir, 'run'),
			fetchFn: async (_u, init) => {
				seenBody = JSON.parse(init.body)
				return {
					ok: true, status: 200,
					json: async () => ({ status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"summary":"ok"}' }] }] }),
				}
			},
		})
		assert.equal(seenBody.reasoning, undefined)
		assert.equal(seenBody.include, undefined)
		assert.deepEqual(r.usage, { input: 100, cached: 40, output: 20, reasoning: 5 })
	} finally { f.done() }
})
