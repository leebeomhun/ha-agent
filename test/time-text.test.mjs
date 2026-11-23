// 도구 결과 시각을 KST로 바꾸는 테스트: 건조기 "남은 시간"(UTC ISO)을 모델이 과거로 잘못 읽던 문제
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { localTime, localizeDeep, relText } = await import('../src/util.mjs')
const { readTools, digestHaData } = await import('../src/tools/read.mjs')

// 2026-11-21 01:57:49 KST
const NOW = Date.parse('2026-11-20T16:57:49Z')

test('localTime: UTC·오프셋·시간대 없는 현지 시각을 KST + 지금 기준 차이로', () => {
	// 실제 사례: 01:57에 물었을 때 남은 시간 센서 값(= 03:09 KST, 72분 뒤)
	assert.equal(localTime('2026-11-20T18:09:41+00:00', NOW), '2026-11-21 03:09 KST (1시간 12분 뒤)')
	assert.equal(localTime('2026-11-20T11:47:01.952+00:00', NOW), '2026-11-20 20:47 KST (5시간 11분 전)')
	assert.equal(localTime('2026-11-20T18:09:41Z', NOW), '2026-11-21 03:09 KST (1시간 12분 뒤)')
	assert.equal(localTime('2026-11-21T03:09:41+0900', NOW), '2026-11-21 03:09 KST (1시간 12분 뒤)')
	// input_datetime처럼 시간대 없는 값은 HA 현지 시각(KST)으로 본다
	assert.equal(localTime('2026-11-20 20:47:01', NOW), '2026-11-20 20:47 KST (5시간 11분 전)')
	assert.equal(localTime('2026-11-20T18:09:41+00:00', NOW, false), '2026-11-21 03:09 KST')
	// 시각이 아니면 그대로
	for (const v of ['running', '85', '2026-11-20', '20:47:00', 'unknown', '', null, 42]) assert.equal(localTime(v, NOW), v)
})

test('relText: 분·시간·일 단위', () => {
	assert.equal(relText(NOW, NOW), '지금')
	assert.equal(relText(NOW + 18 * 60000, NOW), '18분 뒤')
	assert.equal(relText(NOW - 120 * 60000, NOW), '2시간 전')
	assert.equal(relText(NOW - 30 * 3600000, NOW), '1일 6시간 전')
	assert.equal(relText(NOW + 24 * 3600000, NOW), '1일 뒤')
	assert.equal(relText(NOW - 3 * 86400000, NOW), '3일 전')
})

test('localizeDeep: 속성 안의 시각만 바꾸고 나머지는 그대로', () => {
	const out = localizeDeep({ friendly_name: '세탁실 건조기 알림', event_types: ['a'], device_class: 'timestamp', last: '2026-11-20T11:47:01.952+00:00', n: 3, nested: { at: '2026-11-20T18:09:41+00:00' } }, NOW)
	assert.deepEqual(out, { friendly_name: '세탁실 건조기 알림', event_types: ['a'], device_class: 'timestamp', last: '2026-11-20 20:47 KST (5시간 11분 전)', n: 3, nested: { at: '2026-11-21 03:09 KST (1시간 12분 뒤)' } })
})

test('조회 도구: 상태·속성·기록의 시각이 KST로 나간다', async () => {
	const tools = Object.fromEntries(readTools().map(t => [t.name, t]))
	const now = Date.now()
	const endIso = new Date(now + 72 * 60000 + 30000).toISOString() // 72분 30초 뒤(UTC ISO)
	const states = new Map([
		['sensor.dryer_remaining_time', { entity_id: 'sensor.dryer_remaining_time', state: endIso, last_changed: new Date(now).toISOString(), attributes: { friendly_name: '세탁실 건조기 남은 시간', device_class: 'timestamp' } }],
		['sensor.dryer_current_status', { entity_id: 'sensor.dryer_current_status', state: 'running', last_changed: new Date(now).toISOString(), attributes: { friendly_name: '세탁실 건조기 현재 상태' } }],
	])
	const ha = {
		history: async () => ({ 'sensor.dryer_remaining_time': [{ s: '2026-11-20T18:09:41+00:00', lu: 1795193081.7 }] }),
		logbook: async () => [{ when: 1795193081.7, entity_id: 'sensor.dryer_current_status', name: '세탁실 건조기 현재 상태', state: 'running', context_name: 'ThinQ' }],
		statistics: async () => ({ 'sensor.x': [{ start: 1795193081700, mean: 1.23456 }] }),
	}
	const ctx = { states, ha, areaOf: new Map() }

	const found = JSON.parse(await tools.ha_search_entities.run(ctx, { query: '건조기' }))
	const rem = found.find(x => x.id === 'sensor.dryer_remaining_time')
	assert.match(rem.state, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST \(1시간 1[23]분 뒤\)$/)
	assert.equal(found.find(x => x.id === 'sensor.dryer_current_status').state, 'running')

	const got = JSON.parse(await tools.ha_get_state.run(ctx, { entity_ids: ['sensor.dryer_remaining_time'] }))
	assert.match(got['sensor.dryer_remaining_time'].state, /KST \(1시간 1[23]분 뒤\)$/)
	assert.equal(got['sensor.dryer_remaining_time'].attributes.device_class, 'timestamp')

	const hist = JSON.parse(await tools.ha_get_history.run(ctx, { kind: 'history', entity_ids: ['sensor.dryer_remaining_time'], hours: null }))
	assert.deepEqual(hist['sensor.dryer_remaining_time'], [['2026-11-21 01:44', '2026-11-21 03:09 KST']])
	const lb = JSON.parse(await tools.ha_get_history.run(ctx, { kind: 'logbook', entity_ids: ['sensor.dryer_current_status'], hours: 3 }))
	assert.deepEqual(lb[0], { t: '2026-11-21 01:44', id: 'sensor.dryer_current_status', name: '세탁실 건조기 현재 상태', state: 'running', by: 'ThinQ' })
	assert.deepEqual(JSON.parse(JSON.stringify(digestHaData('statistics', await ha.statistics()))), { 'sensor.x': [{ t: '2026-11-21 01:44', mean: 1.23 }] })
})
