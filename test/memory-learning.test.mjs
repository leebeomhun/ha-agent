// 지속적 기억(Memory) 및 데이터 기반 자가개선(Self-Improvement) 전체 1~4단계 통합·단위 테스트
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'haagent-memlearn-'))
process.env.HAAGENT_DATA_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

const { mergeConfig, saveControl } = await import('../src/config.mjs')
const { P, DAY, writeJson, readJson } = await import('../src/util.mjs')
const { Store } = await import('../src/core/store.mjs')
const { MemoryManager } = await import('../src/core/memory.mjs')
const { formatEmbedInput, embedText, isGeminiEmbedding2, localEmbed, lexicalSimilarity } = await import('../src/core/embeddings.mjs')
const { hasMemorySignal, estimateKoreanExpiryMs, deterministicExtract } = await import('../src/core/memory-extractor.mjs')
const { AnomalyEngine } = await import('../src/engine/anomaly.mjs')
const {
	filterRestartSpikes, ImplicitFeedbackTracker, mineRoutines, scoreRules,
	recordEvalCase, loadEvalCases, generateSelfProposals, registerExperiment, evaluateDueExperiments,
} = await import('../src/engine/learning.mjs')
const { dailyDigest, writeDaily, weekMetrics, rangeStats } = await import('../src/records.mjs')
const { HaAdmin } = await import('../src/admin/ha-admin.mjs')
const { mergedBenchCases } = await import('../src/bench-assist.mjs')
const { validateResponse } = await import('../src/brain.mjs')
const { Agent } = await import('../src/agent.mjs')

const T0 = Date.parse('2026-11-21T10:30:00+09:00') // 토요일 오전 10:30 KST
const MIN = 60000
const st = (entity_id, state, attrs = {}, at = T0) => ({
	entity_id, state,
	attributes: { friendly_name: entity_id, ...attrs },
	last_changed: new Date(at).toISOString(),
	last_updated: new Date(at).toISOString(),
})
const blankAnswer = (over = {}) => ({
	summary: 'ok', notifications: [], rule_changes: { upsert: [], delete: [] }, next_wakes: [],
	memory: { mode: 'keep', text: '' }, memory_ops: [], lesson_ops: [], info_requests: [], actions: [], proposals: [], report: '',
	...over,
})

function cleanState() {
	rmSync(TMP, { recursive: true, force: true })
	mkdirSync(P.state, { recursive: true })
	saveControl({ paused: false, send: true })
	writeJson(P.rules, { updated: new Date(T0).toISOString(), rules: [] })
}

test('1. 기억 우선순위·예산 보호·TTL·확신도 가드·고정(Pin) 삭제 보호·버전 이력 복원', () => {
	cleanState()
	const store = new Store(join(TMP, 'm1.db'))
	const memPath = join(TMP, 'memory.md')
	writeFileSync(memPath, '오래된 메모 라인 1\n' + '중간 낡은 내용 '.repeat(120) + '\n최신 작업 메모 핵심 라인\n')
	const mm = new MemoryManager({ store, memoryPath: memPath, profilePath: join(TMP, 'none.md') })
	try {
		// 다량의 incident를 먼저 넣고, standing_order와 preference를 나중에 넣는다
		const ops = []
		for (let i = 1; i <= 12; i++) {
			ops.push({ op: 'upsert', category: 'incident', key: `inc_${i}`, content: `일회성 장애 기록 ${i}번: `.padEnd(150, '가'), entity_ids: [`sensor.s${i}`] })
		}
		ops.push({ op: 'upsert', category: 'standing_order', key: 'never_turn_off_study', content: '작은방 조명은 손님 있을 때 절대 끄지 마', pinned: true })
		ops.push({ op: 'upsert', category: 'preference', key: 'restore_prev', content: '화장실 정전 보상 설정은 이전 상태로 유지', entity_ids: ['select.bul_jeongjeon'] })
		ops.push({ op: 'upsert', category: 'incident', key: 'short_trip', content: '3일 출장 중', ttl_days: 3 })
		ops.push({ op: 'upsert', category: 'pattern', key: 'weak_guess', content: '한 번 본 약한 추정', confidence: 0.3 })

		const res = mm.applyOps(ops, { source: 'cycle', now: T0 })
		assert.equal(res.upserted.length, 16)
		assert.equal(res.warnings.length, 1, '낮은 확신도 pattern은 임시 incident로 강등 경고')
		assert.equal(store.getMemory('weak_guess').category, 'incident')

		// 1) 정렬 순서: pinned / standing_order가 incident보다 반드시 먼저 나온다
		const listed = mm.list(null, { now: T0 })
		assert.equal(listed[0].key, 'never_turn_off_study')
		assert.equal(listed[1].key, 'restore_prev')

		// 2) 작은 프롬프트 예산(1500자)에서도 영구 지시·선호와 최신 작업 메모 끝줄이 잘리지 않는다
		const rendered = mm.renderForPrompt(1500, { contextText: '작은방 조명', now: T0 })
		assert.match(rendered, /never_turn_off_study/)
		assert.match(rendered, /restore_prev/)
		assert.match(rendered, /최신 작업 메모 핵심 라인/)

		// 3) TTL 만료: short_trip(3일)은 4일 뒤 자동 아카이브, 기본 incident(21일)는 22일 뒤 만료, standing_order는 무기한
		assert.ok(store.getMemory('inc_1').expires_at > T0)
		assert.equal(store.getMemory('never_turn_off_study').expires_at, null)
		const expired4d = store.archiveExpiredMemory(T0 + 4 * DAY)
		assert.deepEqual(expired4d, ['short_trip'])
		assert.equal(mm.search('출장', null, { now: T0 + 4 * DAY }).length, 0)
		assert.equal(mm.search('출장', null, { includeArchived: true, now: T0 + 4 * DAY }).length, 1, '아카이브 검색으로 복원 조회 가능')

		// 4) pinned 기억은 자동(cycle) 삭제가 차단되고, 사용자(console/force) 삭제만 허용된다
		const autoDel = mm.applyOps([{ op: 'delete', key: 'never_turn_off_study' }], { source: 'cycle', now: T0 })
		assert.equal(autoDel.deleted.length, 0)
		assert.equal(autoDel.blocked.length, 1)
		assert.ok(store.getMemory('never_turn_off_study').active)

		// 5) 수정 이력 및 이전 버전 복원
		mm.applyOps([{ op: 'upsert', category: 'preference', key: 'restore_prev', content: '잘못 덮어쓴 내용' }], { source: 'cycle', now: T0 + 1000 })
		const hist = mm.history('restore_prev', 10)
		assert.ok(hist.length >= 2)
		const updateRec = hist.find(h => h.op === 'update')
		const restored = mm.restoreVersion(updateRec.id, { source: 'console', now: T0 + 2000 })
		assert.equal(restored.ok, true)
		assert.match(store.getMemory('restore_prev').content, /이전 상태로 유지/)
	} finally { store.close() }
})

test('2. 하이브리드 검색(FTS5·한국어 2-gram·임베딩·엔티티), Contextual Recall, 기억 통합(Consolidation)', () => {
	cleanState()
	const store = new Store(join(TMP, 'm2.db'))
	const mm = new MemoryManager({ store, memoryPath: join(TMP, 'none.md'), profilePath: join(TMP, 'none2.md') })
	try {
		mm.applyOps([
			{ op: 'upsert', category: 'preference', key: 'bath_restore', content: '화장실 불과 환풍기의 정전 보상 설정은 이전 상태로 유지하길 원함', entity_ids: ['select.bul_jeongjeon', 'light.bul'] },
			{ op: 'upsert', category: 'incident', key: 'bathroom_relay_recovery_20261121', content: '11월 21일 화장실 릴레이 정전 복구 설정이 켜짐으로 바뀜 원인은 미확인', entity_ids: ['light.bul'] },
			{ op: 'upsert', category: 'incident', key: 'bathroom_relay_restore_setting_20261121', content: '11월 21일 화장실 릴레이 정전 복구 설정이 켜짐으로 바뀜 원인은 미확인이며 추가 확인 필요', entity_ids: ['light.hwanpunggi'] },
			{ op: 'upsert', category: 'incident', key: 'unrelated_big_1', content: '거실 셋톱박스 상태 흔들림 '.repeat(15), entity_ids: ['media_player.stb'] },
			{ op: 'upsert', category: 'incident', key: 'unrelated_big_2', content: '주방 스마트플러그 순간 전압 변동 '.repeat(15), entity_ids: ['sensor.plug'] },
		], { source: 'cycle', now: T0 })

		// 한국어 조사/띄어쓰기 변형 검색
		const hits = mm.search('정전보상 이전상태', null, { now: T0 })
		assert.ok(hits.some(h => h.key === 'bath_restore'), '한국어 띄어쓰기/조사 변형 하이브리드 매칭')

		// 엔티티 기반 Contextual Recall: 작은 예산에서 관련 엔티티 기억이 무관한 큰 기억보다 우선 회상
		const recalled = mm.renderStructured(420, { contextText: '화장실 릴레이', entityIds: ['light.bul'], now: T0, touch: true })
		assert.match(recalled, /bath_restore/)
		assert.ok(store.getMemory('bath_restore').hit_count >= 1, 'touchMemory로 회상 횟수 기록')

		// 기억 통합(Consolidation): 유사 중복 incident 키 자동 병합 + 엔티티 합집합 + evidence_count 합산
		const cons = mm.consolidate({ now: T0 })
		assert.equal(cons.merged.length, 1)
		const kept = store.getMemory(cons.merged[0].kept)
		assert.equal(kept.evidence_count, 2)
		assert.ok(kept.entity_ids.includes('light.bul') && kept.entity_ids.includes('light.hwanpunggi'))

		// 근거 3회 도달 시 패턴 승격 후보로 부상
		mm.applyOps([{ op: 'upsert', category: 'incident', key: kept.key, content: kept.content }], { source: 'cycle', now: T0 + 1000 })
		const cons2 = mm.consolidate({ now: T0 + 2000, dry: true })
		assert.ok(cons2.promotion_candidates.length >= 1)
	} finally { store.close() }
})

test('3. Post-Turn 비동기 기억 추출기: 상대 한국어 날짜 계산 및 Assist 턴 후 자동 저장', async () => {
	cleanState()
	assert.equal(hasMemorySignal('원주집에갔다가 월요일에 올께'), true)
	assert.equal(hasMemorySignal('앞으로 밤에는 거실 불 끄지 마'), true)
	assert.equal(hasMemorySignal('거실 온도 몇 도야?'), false)

	// 토요일(2026-11-21) 기준 "월요일에 올께" → 화요일(2026-11-24 00:00 KST) 만료
	const expMs = estimateKoreanExpiryMs('원주집에갔다가 월요일에 올께', T0)
	assert.equal(expMs, Date.parse('2026-11-24T00:00:00+09:00'))
	const det = deterministicExtract('원주집에갔다가 월요일에 올께', T0)
	assert.equal(det[0].category, 'incident')
	assert.equal(det[0].ttl_days, 3)

	// Agent.handleAssist 통합: Fast LLM이 memory_upsert를 놓쳐도 Post-Turn 추출기가 자동 저장
	const ha = new EventEmitter()
	ha.connected = true; ha.start = () => {}; ha.stop = () => {}
	ha.call = async m => (m.type === 'get_states' ? [st('light.a', 'off')] : [])
	ha.callService = async () => ({ response: {} })
	ha.heartbeat = async () => {}

	const agent = new Agent({
		cfg: mergeConfig({ heartbeat: { enabled: false }, assist: { fast_path: false, model: 'gpt-6-luna', effort: 'low' }, llm: { routes: { assist: 'api' } } }),
		ha, clock: () => T0, canUse: () => true,
		brain: async () => ({ result: { speech: '알겠어요. 월요일에 오시는군요.', continue_conversation: false }, ms: 1, tokens: 10 }),
	})
	agent.attach()
	ha.emit('ready', [st('light.a', 'off')])
	try {
		const res = await agent.handleAssist({ text: '원주집에갔다가 월요일에 올께', conversationId: 'conv_trip' })
		assert.match(res.speech, /월요일/)
		assert.ok(agent.assist.lastExtractPromise, '비동기 추출 작업이 스케줄됨')
		await agent.assist.lastExtractPromise
		const found = agent.memoryMgr.search('원주집', null, { now: T0 })
		assert.equal(found.length, 1)
		assert.ok(found[0].expires_at > T0, '귀가 일정에 자동 만료(TTL)가 설정됨')
	} finally { agent.stop() }
})

test('4. 컨텍스트 분리 이상탐지(weekday/weekend/away), 재시작 스파이크 필터, SQLite Rollup 보존', () => {
	cleanState()
	const store = new Store(join(TMP, 'anom_roll.db'))
	try {
		const ae = new AnomalyEngine({ store, awayOverrideEntity: 'input_boolean.override' })
		const fri10 = Date.parse('2026-11-20T10:00:00+09:00') // 금요일
		const statesWorkday = new Map([
			['sensor.power', st('sensor.power', '200', { unit_of_measurement: 'W' }, fri10)],
			['person.ibeomhun', st('person.ibeomhun', 'home', {}, fri10)],
			['binary_sensor.workday_sensor_kr', st('binary_sensor.workday_sensor_kr', 'on', {}, fri10)],
			['input_boolean.override', st('input_boolean.override', 'off', {}, fri10)],
		])
		assert.equal(ae.contextOf(statesWorkday, fri10), 'weekday')

		const statesHoliday = new Map([...statesWorkday, ['binary_sensor.workday_sensor_kr', st('binary_sensor.workday_sensor_kr', 'off', {}, fri10)]])
		assert.equal(ae.contextOf(statesHoliday, fri10), 'weekend', '평일 공휴일은 weekend 버킷으로 분류')

		const statesAway = new Map([...statesWorkday, ['person.ibeomhun', st('person.ibeomhun', 'not_home', {}, fri10)]])
		assert.equal(ae.contextOf(statesAway, fri10), 'away', '외출(재실 도우미 off)은 away 버킷으로 분리')

		// 평일 재실(200W)과 외출(40W) 표본이 서로 다른 버킷으로 학습됨
		for (let i = 0; i < 8; i++) {
			store.recordSensorSample('sensor.power', 200 + (i % 2) * 10, fri10 - 7 * DAY + i * 6 * MIN, 'weekday')
			store.recordSensorSample('sensor.power', 40 + (i % 2) * 5, fri10 - 7 * DAY + i * 6 * MIN, 'away')
		}
		ae.recomputeBaselines(fri10, statesWorkday)
		// 외출 중 450W는 away 버킷 기준 이상으로 탐지됨 (weekday 200W 기준이 아니라 away 42.5W 기준!)
		const awayHigh = new Map([...statesAway, ['sensor.power', st('sensor.power', '450', { unit_of_measurement: 'W' }, fri10)]])
		ae.checkAnomalies(awayHigh, fri10)
		const hits = ae.checkAnomalies(awayHigh, fri10 + 16 * MIN)
		assert.equal(hits.length, 1)
		assert.equal(hits[0].context, 'away')

		// HA 재시작 스파이크(20개 엔티티 동시 변화) 필터링
		const d0 = Date.parse('2026-11-19T16:02:00+09:00')
		const burst = Array.from({ length: 20 }, (_, i) => ({ t: d0 + i * 1000, id: `sensor.boot_${i}`, name: `s${i}`, from: 'unavailable', to: 'on' }))
		const genuine = [{ t: d0 - 3600000, id: 'light.living', name: '거실 불', from: 'off', to: 'on' }]
		const filtered = filterRestartSpikes([...genuine, ...burst])
		assert.equal(filtered.removed, 20)
		assert.deepEqual(filtered.events.map(e => e.id), ['light.living'])
		const digest = dailyDigest('2026-11-19', [...genuine, ...burst])
		assert.ok(digest['light.living'])
		assert.equal(digest['sensor.boot_0'], undefined)

		// SQLite 단일 원본 통계 & maintain() 삭제 전 daily/monthly Rollup 영구 보존
		const oldDay = Date.parse('2026-08-10T10:00:00+09:00')
		store.recordEvent({ t: oldDay, id: 'light.living', name: '거실 불', from: 'off', to: 'on' })
		store.recordSensorSample('sensor.temp', 27.5, oldDay, 'weekday')
		store.recordDecision({ ts: oldDay, reasons: ['hourly'], tokens: 1200, summary: 'ok', applied: { notifications: [] } })
		const del = store.maintain(T0)
		assert.ok(del.events >= 1)
		assert.ok(del.rolled_up_days >= 1, '삭제 전 일별 롤업 영구 생성')
		assert.ok(del.rolled_up_months >= 1, '삭제 전 월별 롤업 영구 생성')
		const monthly = store.listMonthlyRollups(12)
		assert.ok(monthly.some(m => m.month === '2026-08' && m.sensor_stats['sensor.temp']?.avg === 27.5))

		// writeDaily / weekMetrics / rangeStats가 JSONL 없이 SQLite만으로 동작
		store.recordDecision({ ts: T0 - 2 * 3600000, reasons: ['hourly'], tokens: 500, summary: 'ok', applied: { notifications: ['sent: a'] } })
		const dailyDoc = writeDaily('2026-11-21', 60, { store })
		assert.equal(dailyDoc.runs, 1)
		assert.equal(weekMetrics(T0, { store }).runs, 1)
		assert.equal(rangeStats(7, T0, { store }).tokens, 500)
	} finally { store.close() }
})

test('5. 암묵적 피드백(되돌림·재발화·정정·거짓제어), 회귀 평가셋, 루틴 마이너, 규칙 정밀도 스코어카드', () => {
	cleanState()
	const store = new Store(join(TMP, 'learn.db'))
	const evalPath = join(TMP, 'state', 'evals', 'cases.json')
	try {
		const tracker = new ImplicitFeedbackTracker({ store, evalPath })
		// 1) 에이전트가 light.a를 끈 뒤 4분 만에 사람이 다시 켬 → action_reverted
		tracker.trackExecutedControl({ aid: 'a1', entity_id: 'light.a', service: 'turn_off', prev: 'on', reason: '빈 집 소등', requested: false }, T0)
		const rev = tracker.onStateEvent({ id: 'light.a', from: 'off', to: 'on' }, { now: T0 + 4 * MIN })
		assert.equal(rev.kind, 'action_reverted')

		// 2) Assist 마찰(거짓 제어 + 재발화 + 정정 + 의향 질문 오실행) → 암묵적 피드백 + 회귀 평가 케이스 자동 축적
		tracker.onAssistTurn({
			text: '주방 불 끄는 게 어때?',
			speech: '주방 불을 껐어요.',
			prevUserMsgs: [{ ts: T0 - 30000, text: '주방 불 끄는 게 어때?' }],
			hadUnexecutedClaim: false,
			actions: [{ status: 'done' }],
			now: T0,
		})
		tracker.onAssistTurn({
			text: '아니 그게 아니라 끄지 마',
			prevUserMsgs: [{ ts: T0, text: '주방 불 끄는 게 어때?' }],
			hadUnexecutedClaim: true,
			now: T0 + 10000,
		})
		const summary = tracker.summarize({ sinceMs: T0 - DAY })
		assert.equal(summary.by_kind.action_reverted, 1)
		assert.equal(summary.by_kind.assist_retry, 1)
		assert.equal(summary.by_kind.assist_correction, 1)
		assert.equal(summary.by_kind.assist_unexecuted_claim, 1)

		const cases = loadEvalCases(evalPath)
		assert.ok(cases.some(c => c.text === '주방 불 끄는 게 어때?'))
		assert.ok(mergedBenchCases({ includeLearned: true }).some(c => c.text === '주방 불 끄는 게 어때?'))

		// 3) 루틴 마이너: 평일 5일간 08:05 외출 + 07:25 작은방 조명 켜기 + HA 재시작 스파이크 주입
		const mon = Date.parse('2026-11-16T00:00:00+09:00')
		for (let d = 0; d < 5; d++) {
			const base = mon + d * DAY
			store.recordEvent({ t: base + 7 * 3600000 + 25 * MIN, id: 'switch.study', name: '작은방 스위치', from: 'off', to: 'on' })
			store.recordEvent({ t: base + 8 * 3600000 + (5 + d) * MIN, id: 'person.ibeomhun', name: '이범훈', from: 'home', to: 'not_home' })
		}
		// 재시작 스파이크 주입(20개 동시 변화)
		for (let i = 0; i < 20; i++) store.recordEvent({ t: mon + 12 * 3600000 + i * 500, id: `switch.boot_${i}`, from: 'unavailable', to: 'on' })
		const routines = mineRoutines({ store, now: mon + 6 * DAY })
		assert.equal(routines.filtered_restart_events, 20)
		assert.equal(routines.presence_routines[0].direction, 'leave')
		assert.equal(routines.presence_routines[0].observed_days, 5)
		assert.ok(routines.device_routines.some(r => r.entity_id === 'switch.study' && r.window === '07:00~07:30'))

		// 4) 규칙 정밀도 스코어카드: 4회 깨움 중 4회 noop인 시끄러운 규칙 탐지
		for (let i = 0; i < 4; i++) {
			store.recordDecision({ ts: T0 - (i + 1) * 3600000, reasons: ['rule:noisy_rain'], summary: 'no alert', applied: { notifications: [], actions: [] } })
		}
		const scores = scoreRules({
			rules: [
				{ id: 'noisy_rain', description: '비 감시' },
				{ id: 'muted_rule', description: '쉼 규칙' },
			],
			runtime: {
				noisy_rain: { fire_log: [T0 - 3600000], clear_log: [[T0 - 7200000, T0 - 6600000]] },
				muted_rule: { muted_until: T0 + DAY },
			},
			store, now: T0,
		})
		assert.equal(scores[0].grade, 'noisy')
		assert.equal(scores[0].noop_rate_pct, 100)
		assert.equal(scores[0].avg_clear_min, 10)
		assert.equal(scores[1].grade, 'muted')
	} finally { store.close() }
})

test('6. 사전 백테스트 과다발동 차단 게이트 & 제안 사전 검증 실패 시 1회 Self-Repair 라운드', async () => {
	cleanState()
	const ha = new EventEmitter()
	ha.connected = true; ha.start = () => {}; ha.stop = () => {}
	ha.guard = { allowConfigWrite: false }
	ha.sent = []
	ha.call = async m => (m.type === 'get_states' ? [st('light.a', 'off'), st('binary_sensor.door', 'off')] : m.type === 'repairs/list_issues' ? { issues: [] } : [])
	ha.callService = async (d, _s, { data }) => { if (d === 'notify') ha.sent.push(data); return { response: {} } }
	ha.heartbeat = async () => {}
	ha.renderTemplate = async () => 'ok'
	// 지난 7일간 20회 on/off 반복 기록 → backtest_max_fires(5) 초과로 규칙 적용 차단돼야 함
	ha.history = async ids => {
		const rows = []
		for (let i = 0; i < 20; i++) {
			rows.push({ lu: (T0 - (40 - i * 2) * 3600000) / 1000, s: 'on' })
			rows.push({ lu: (T0 - (39 - i * 2) * 3600000) / 1000, s: 'off' })
		}
		return Object.fromEntries(ids.map(id => [id, rows]))
	}

	let callCount = 0
	const seenPrompts = []
	const agent = new Agent({
		cfg: mergeConfig({ heartbeat: { enabled: false }, policy: { admin_enabled: true }, limits: { backtest_max_fires: 5, proposal_self_repair: true } }),
		ha, clock: () => T0, canUse: () => false,
		brain: async a => {
			callCount++
			seenPrompts.push(a.prompt)
			if (callCount === 1) {
				// 1차 응답: 없는 엔티티(sensor.typo)를 참조한 잘못된 제안 + 과다 발동 규칙
				return {
					result: blankAnswer({
						rule_changes: {
							upsert: [{ id: 'too_noisy', description: '과다 발동 테스트', entity_id: 'binary_sensor.door', attribute: null, op: 'eq', value: 'on', for_minutes: 0, cooldown_minutes: 10, priority: 'normal', also: [], hour_from: null, hour_to: null }],
							delete: [],
						},
						proposals: [{
							kind: 'automation_upsert', target_id: 'automation.fix_me', title: '수정 테스트', summary: '테스트',
							payload_json: JSON.stringify({ alias: 'test', triggers: [{ trigger: 'state', entity_id: 'sensor.typo' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] }),
						}],
					}),
					ms: 1, tokens: 10,
				}
			}
			// 2차 자가 수정(Self-Repair) 응답: 오류 피드백을 보고 sensor.typo → binary_sensor.door로 고쳐 제출
			return {
				result: blankAnswer({
					rule_changes: {
						upsert: [{ id: 'too_noisy', description: '과다 발동 테스트', entity_id: 'binary_sensor.door', attribute: null, op: 'eq', value: 'on', for_minutes: 0, cooldown_minutes: 10, priority: 'normal', also: [], hour_from: null, hour_to: null }],
						delete: [],
					},
					proposals: [{
						kind: 'automation_upsert', target_id: 'automation.fix_me', title: '수정 테스트', summary: '테스트',
						payload_json: JSON.stringify({ alias: 'test', triggers: [{ trigger: 'state', entity_id: 'binary_sensor.door' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] }),
					}],
				}),
				ms: 1, tokens: 10,
			}
		},
	})
	agent.attach()
	ha.emit('ready', [st('light.a', 'off'), st('binary_sensor.door', 'off')])
	try {
		const entry = await agent.cycle([{ type: 'manual', reason: '검증' }])
		assert.equal(callCount, 2, '제안 사전 검증 실패 시 1회 자가 수정 라운드 수행')
		assert.match(seenPrompts[1], /직전 제안 사전 검증 오류[\s\S]*sensor\.typo/)
		assert.equal(entry.proposal_repaired, true)
		assert.equal(entry.applied.proposals.length, 1, '자가 수정된 제안이 정상 등록됨')
		assert.equal(agent.engine.rules.some(r => r.id === 'too_noisy'), false, '사전 백테스트 과다 발동 규칙은 적용 차단')
		assert.ok(entry.applied.rejected.some(r => r.rule === 'too_noisy' && /사전 백테스트 과다 발동 차단/.test(r.error)))
	} finally { agent.stop() }
})

test('7. Tier 2 자가 튜닝 제안(별칭·소음·STT·교훈), 불변 코어 차단, 롤백 및 7일 실험 사후 검증', async () => {
	cleanState()
	const store = new Store(join(TMP, 'self.db'))
	const cfgPath = join(TMP, 'test-config.json')
	const sttDir = join(TMP, 'stt-fail')
	mkdirSync(sttDir, { recursive: true })
	const rawCfg = {
		notify_targets: ['mobile_app_ibeomhun'],
		noise_entities: ['sensor.seoul_*'],
		policy: { admin_enabled: true, tier3_blocked: ['lock.*'] },
		assist: { aliases: { 'switch.kitchen': ['주방 불'] }, voice: { endpoint: { enabled: true, silence_ms: 700, max_seconds: 10, no_speech_seconds: 6 }, stt_hints: ['주방'] } },
	}
	writeJson(cfgPath, rawCfg)
	try {
		// 1) 별칭·소음·STT·교훈 후보 데이터 적재
		store.ensureConversation('s1', 'ha_assist', null, T0)
		for (let i = 0; i < 2; i++) {
			const at = T0 - (2 - i) * 3600000
			store.appendMessage('s1', 'user', '부엌 등 켜줘', null, at - 2000)
			store.upsertAction({ aid: `act_${i}`, ts: at, entity_id: 'switch.kitchen', service: 'turn_on', tier: 'confirm', requested: 1, status: 'done', reason: 'r' })
		}
		for (let i = 0; i < 25; i++) store.recordEvent({ t: T0 - i * 600000, id: 'sensor.chatty_wifi', from: 'a', to: 'b' })
		for (let i = 0; i < 3; i++) {
			writeJson(join(sttDir, `f${i}.json`), { text: null, stats: { peakDbfs: -12, activeMs: 500 }, endpoint: { reason: 'stream_end' } })
			store.recordImplicitFeedback({ ts: T0 - i * 10000, kind: 'assist_unexecuted_claim', score: -1 })
		}

		const cfg = mergeConfig(rawCfg)
		const cands = generateSelfProposals({ store, cfg, rules: [], states: new Map([['switch.kitchen', st('switch.kitchen', 'off')]]), sttFailuresDir: sttDir, now: T0 })
		const kinds = new Set(cands.map(c => c.kind))
		assert.ok(kinds.has('self_alias_proposal'))
		assert.ok(kinds.has('self_noise_proposal'))
		assert.ok(kinds.has('self_stt_tune'))
		assert.ok(kinds.has('self_lesson_proposal'))

		let liveCfg = cfg
		const adm = new HaAdmin({ cfg, ha: { connected: true }, store, states: new Map(), configPath: cfgPath, onConfigUpdated: m => { liveCfg = m } })

		// 불변 코어 가드: policy/tier3_blocked 포함 payload 거부
		const badImm = await adm.createProposal({ kind: 'self_alias_proposal', target_id: 'switch.kitchen', title: '공격', summary: 's', payload: { entity_id: 'switch.kitchen', alias: 'x', policy: { tier3_blocked: [] } } }, T0)
		assert.equal(badImm.ok, false)
		assert.match(badImm.error, /불변 코어 보호/)

		// 별칭 제안 승인 → config.json 갱신 + liveCfg 반영 → 롤백 시 원복
		const aliasCand = cands.find(c => c.kind === 'self_alias_proposal')
		const pAlias = await adm.createProposal(aliasCand, T0)
		assert.equal(pAlias.ok, true)
		assert.match(pAlias.proposal.diff_text, /\+.*"부엌 등"/)
		const appAlias = await adm.approveProposal(pAlias.proposal.pid, T0)
		assert.equal(appAlias.ok, true)
		assert.ok(readJson(cfgPath, {}).assist.aliases['switch.kitchen'].includes('부엌 등'))
		assert.ok(liveCfg.assist.aliases['switch.kitchen'].includes('부엌 등'))
		const rbAlias = await adm.rollbackProposal(pAlias.proposal.pid, T0 + 1000)
		assert.equal(rbAlias.ok, true)
		assert.equal(readJson(cfgPath, {}).assist.aliases['switch.kitchen'].includes('부엌 등'), false)

		// 교훈 제안 승인 → lessons 테이블 등록 → 7일 실험 사후 검증(부정 신호 감소 시 improved + confidence 상승)
		const lesCand = cands.find(c => c.kind === 'self_lesson_proposal')
		const pLes = await adm.createProposal(lesCand, T0)
		await adm.approveProposal(pLes.proposal.pid, T0)
		const beforeConf = store.getLesson(lesCand.payload.key).confidence
		const exp = registerExperiment(store, { kind: 'lesson', ref_id: lesCand.payload.key, title: '교훈 검증', evalDays: 7, now: T0 })
		assert.equal(exp.status, 'active')
		// 8일 경과(그사이 부정 암묵적 피드백 0건 → 개선 판정!)
		const evaluated = evaluateDueExperiments(store, T0 + 8 * DAY)
		assert.equal(evaluated.length, 1)
		assert.equal(evaluated[0].verdict, 'improved')
		assert.ok(store.getLesson(lesCand.payload.key).confidence > beforeConf)
	} finally { store.close() }
})

test('8. 웹 콘솔 메모리·자가학습 REST API CRUD, Pin, 이력 복원, XSS-Free HTML 및 validateResponse 확장', async () => {
	cleanState()
	const v = validateResponse({
		summary: 'ok',
		memory_ops: [{ op: 'upsert', category: 'standing_order', key: 'k1', content: '절대 끄지 마', ttl_days: null, confidence: 0.95, pinned: true, entity_ids: ['light.a'] }],
		lesson_ops: [{ op: 'upsert', key: 'l1', scope: 'assist', condition_text: '의향 질문일 때', rule_text: '먼저 확인한다', evidence: '사례 2건', pinned: true }],
		proposals: [{ kind: 'self_alias_proposal', target_id: 'light.a', title: '별칭', summary: 's', payload_json: '{"entity_id":"light.a","alias":"방불"}' }],
	})
	assert.equal(v.memory_ops[0].pinned, true)
	assert.deepEqual(v.memory_ops[0].entity_ids, ['light.a'])
	assert.equal(v.lesson_ops[0].key, 'l1')
	assert.equal(v.proposals[0].kind, 'self_alias_proposal')

	const ha = new EventEmitter()
	ha.connected = true; ha.start = () => {}; ha.stop = () => {}
	ha.call = async m => (m.type === 'get_states' ? [st('light.a', 'off')] : [])
	ha.callService = async () => ({ response: {} })
	ha.heartbeat = async () => {}

	const agent = new Agent({
		cfg: mergeConfig({ heartbeat: { enabled: false }, policy: { admin_enabled: true }, assist: { enabled: true, host: '127.0.0.1', port: 0, token_file: join(TMP, 'tok') } }),
		ha, clock: () => T0, canUse: () => false,
	})
	agent.attach()
	ha.emit('ready', [st('light.a', 'off')])
	const port = await agent.assistServer.start()
	const hdr = { authorization: `Bearer ${agent.assistServer.token}`, 'content-type': 'application/json' }
	try {
		const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
		assert.equal(/\.innerHTML\b/.test(html), false, '새 UI 탭도 innerHTML 없이 DOM API만 사용')
		assert.match(html, /메모리 관리/)
		assert.match(html, /자가학습·실험/)

		// Memory POST → Pin → Update → History → Restore → Delete
		const m1 = await (await fetch(`http://127.0.0.1:${port}/api/memory`, { method: 'POST', headers: hdr, body: JSON.stringify({ category: 'preference', key: 'web_pref', content: '초기 선호', pinned: false }) })).json()
		assert.equal(m1.ok, true)
		const pinR = await (await fetch(`http://127.0.0.1:${port}/api/memory/web_pref/pin`, { method: 'POST', headers: hdr, body: JSON.stringify({ pinned: true }) })).json()
		assert.equal(pinR.item.pinned, true)
		await fetch(`http://127.0.0.1:${port}/api/memory`, { method: 'POST', headers: hdr, body: JSON.stringify({ category: 'preference', key: 'web_pref', content: '수정된 선호' }) })
		const hRes = await (await fetch(`http://127.0.0.1:${port}/api/memory/web_pref/history`, { headers: hdr })).json()
		const updH = hRes.history.find(h => h.op === 'update')
		const rst = await (await fetch(`http://127.0.0.1:${port}/api/memory/restore/${updH.id}`, { method: 'POST', headers: hdr })).json()
		assert.equal(rst.item.content, '초기 선호')

		// Lessons & Learning API
		const lAdd = await (await fetch(`http://127.0.0.1:${port}/api/lessons`, { method: 'POST', headers: hdr, body: JSON.stringify({ key: 'console_l1', scope: 'assist', condition_text: '질문', rule_text: '확인 먼저' }) })).json()
		assert.equal(lAdd.ok, true)
		const learn = await (await fetch(`http://127.0.0.1:${port}/api/learning`, { headers: hdr })).json()
		assert.equal(learn.lessons.length, 1)
		assert.ok(Array.isArray(learn.rule_scorecard))
		assert.ok(Array.isArray(learn.self_proposal_candidates))
		const reidx = await (await fetch(`http://127.0.0.1:${port}/api/memory/reindex`, { method: 'POST', headers: hdr })).json()
		assert.equal(reidx.model, 'local')
	} finally {
		await agent.stop()
	}
})

test('9. Gemini Embedding 2 연동·프롬프트 접두어·백필·캐시·순수 동의어 의미 검색·오프라인 폴백·오탐 보정', async () => {
	cleanState()
	assert.equal(isGeminiEmbedding2('gemini-embedding-2'), true)
	assert.equal(isGeminiEmbedding2('gemini-embedding-2-preview'), true)
	assert.equal(isGeminiEmbedding2('gemini-embedding-001'), false)
	assert.equal(formatEmbedInput('정전 보상', { model: 'gemini-embedding-2', task: 'query' }), 'task: search result | query: 정전 보상')
	assert.equal(formatEmbedInput('화장실 설정', { model: 'gemini-embedding-2', task: 'document', title: 'bath_key' }), 'title: bath_key | text: 화장실 설정')
	assert.equal(formatEmbedInput('정전 보상', { model: 'gemini-embedding-001', task: 'query' }), '정전 보상')

	// 로컬 어휘/해시 오탐 보정 검증: "이전상태"가 무관 문서의 "상태" 2글자 때문에 과대 매칭되지 않아야 함
	assert.ok(lexicalSimilarity('정전보상 이전상태', '블루투스 어댑터 오류 도어락 신호 강도 상태 변화') < 0.35)
	assert.equal(localEmbed('테스트').length, 512)

	// 결정론적 개념 공간(4차원 단위벡터 기반 768차원 패딩)으로 Gemini Embedding 2 응답 모의
	const mkVec = (c0, c1, c2, c3, dims = 768) => {
		const arr = new Array(dims).fill(0)
		arr[0] = c0; arr[1] = c1; arr[2] = c2; arr[3] = c3
		return arr
	}
	const calls = []
	let failNext = false
	const mockFetch = async (url, init) => {
		const body = JSON.parse(init.body)
		const text = body.content.parts[0].text
		calls.push({ url, body, text, keyHeader: init.headers['x-goog-api-key'] })
		if (failNext) return { ok: false, status: 503, text: async () => 'service unavailable' }
		// 3개 개념 클러스터: [욕실/정전], [도어락/블루투스], [주방/조명], [무관]
		let vals
		if (/(화장실|환풍기|욕실|배기팬|정전|전원\s*복구)/.test(text)) vals = mkVec(0.95, 0.1, 0.1, 0.1, body.outputDimensionality)
		else if (/(블루투스|도어락|자물쇠|통신)/.test(text)) vals = mkVec(0.1, 0.95, 0.1, 0.1, body.outputDimensionality)
		else if (/(주방|부엌|조명|전등)/.test(text)) vals = mkVec(0.1, 0.1, 0.95, 0.1, body.outputDimensionality)
		else vals = mkVec(0.1, 0.1, 0.1, 0.95, body.outputDimensionality)
		return { ok: true, status: 200, json: async () => ({ embedding: { values: vals } }) }
	}

	const keyFile = join(TMP, 'gem-key')
	writeFileSync(keyFile, 'test-gemini-api-key\n')
	const cfg = mergeConfig({
		gemini: { key_file: keyFile },
		memory: { embedding_model: 'gemini-embedding-2', embedding_dims: 768, semantic_threshold: 0.66 },
	})

	// 1) 직접 embedText 호출: gemini-embedding-2는 taskType 없이 접두어 + outputDimensionality + L2 정규화
	const e2 = await embedText('욕실 배기팬 꺼짐', { cfg, task: 'query', fetchFn: mockFetch })
	assert.equal(e2.fallback, false)
	assert.equal(e2.model, 'gemini-embedding-2')
	assert.equal(e2.dims, 768)
	const norm = Math.sqrt(e2.vec.reduce((s, x) => s + x * x, 0))
	assert.ok(Math.abs(norm - 1) < 0.01, 'L2 정규화 유지')
	assert.equal(calls.at(-1).body.taskType, undefined, 'gemini-embedding-2는 taskType 미전송')
	assert.match(calls.at(-1).text, /^task: search result \| query: /)
	assert.equal(calls.at(-1).keyHeader, 'test-gemini-api-key')

	// 2) Store에 먼저 로컬/미색인 기억 저장 → backfillEmbeddings로 Gemini 2 백필 → 순수 동의어 의미 검색 성공
	const store = new Store(join(TMP, 'm9.db'))
	const mm = new MemoryManager({ store, cfg, fetchFn: mockFetch })
	try {
		store.upsertMemory({ category: 'preference', key: 'bath_power', content: '화장실 불과 환풍기의 정전 보상 설정은 이전 상태로 유지' })
		store.upsertMemory({ category: 'incident', key: 'bt_lock', content: '블루투스 어댑터 오류로 도어락 신호 변화 멈춤' })
		store.upsertMemory({ category: 'rejection', key: 'kitchen_light', content: '주방 조명 자율 켜기 제안 거절됨' })
		assert.equal(mm.embeddingStats().matching_target, 0)

		const bf = await mm.backfillEmbeddings()
		assert.equal(bf.updated, 3)
		assert.equal(bf.failed, 0)
		assert.equal(mm.embeddingStats().matching_target, 3)

		// 글자가 전혀 겹치지 않는 순수 동의어 쿼리 검색!
		const hBath = await mm.searchAsync('욕실 배기팬 꺼짐')
		assert.equal(hBath.length, 1)
		assert.equal(hBath[0].key, 'bath_power')

		const hLock = await mm.searchAsync('현관 자물쇠 통신 문제')
		assert.equal(hLock.length, 1)
		assert.equal(hLock[0].key, 'bt_lock')

		const hKitchen = await mm.searchAsync('부엌 전등 자동 제어')
		assert.equal(hKitchen.length, 1)
		assert.equal(hKitchen[0].key, 'kitchen_light')

		// 완전 무관 쿼리는 0건 차단
		const hNone = await mm.searchAsync('에어컨 필터 청소')
		assert.equal(hNone.length, 0)

		// LRU 쿼리 캐시: 동일 쿼리 재검색 시 추가 API 호출 없음
		const callsBefore = calls.length
		const hCached = await mm.searchAsync('욕실 배기팬 꺼짐')
		assert.equal(hCached[0].key, 'bath_power')
		assert.equal(calls.length, callsBefore, '동일 쿼리는 LRU 캐시 히트')

		// applyOps 시 백그라운드 자동 Gemini 2 임베딩
		mm.applyOps([{ op: 'upsert', category: 'standing_order', key: 'new_bath_order', content: '화장실 환풍기 밤에 유지' }], { source: 'user' })
		await mm.flushEmbeddings()
		assert.equal(store.getMemory('new_bath_order').embedding.model, 'gemini-embedding-2')

		// API 장애 시 오프라인 로컬 폴백으로도 기존 키워드 검색 정상 동작 (크래시 없음)
		failNext = true
		const hFallback = await mm.searchAsync('화장실 환풍기')
		assert.ok(hFallback.some(x => x.key === 'bath_power'), 'API 실패 시에도 FTS5+로컬 하이브리드로 폴백 검색 성공')
		failNext = false
	} finally { store.close() }
})
