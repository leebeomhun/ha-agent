// 프로젝트 분석 보완 사항(1~9) 회귀 테스트:
// 기억 추출기 폴백, 롤백 실패 상태, 기억 보호 단계, 실험 판정 표본·범위, 제안 상태 경합, HTTP 오류 코드, 허용 네트워크·UMask, Tier 3 기본값
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'haagent-hardening-'))
process.env.HAAGENT_DATA_DIR = TMP
after(() => rmSync(TMP, { recursive: true, force: true }))

const { mergeConfig, validateConfig } = await import('../src/config.mjs')
const { DAY } = await import('../src/util.mjs')
const { Store } = await import('../src/core/store.mjs')
const { MemoryManager } = await import('../src/core/memory.mjs')
const { extractMemoryFromTurn, deterministicExtract } = await import('../src/core/memory-extractor.mjs')
const { HaAdmin } = await import('../src/admin/ha-admin.mjs')
const { registerExperiment, evaluateDueExperiments, judgeExperiment, proposalExperimentScope } = await import('../src/engine/learning.mjs')
const { AssistServer, isIpAllowed } = await import('../src/channels/assist-server.mjs')
const { PolicyEngine, DEFAULT_TIER3_PATTERNS } = await import('../src/core/policy.mjs')
const { ToolBroker } = await import('../src/tools/registry.mjs')
const { proposalResultPayload } = await import('../src/notify.mjs')

const T0 = Date.parse('2026-11-25T10:00:00+09:00') // 수요일 오전 10시 KST
const HOUR = 3600000
const LIVE_CFG = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'))
const st = (entity_id, state) => ({ entity_id, state, attributes: { friendly_name: entity_id }, last_changed: new Date(T0).toISOString(), last_updated: new Date(T0).toISOString() })
const newMemory = name => {
	const store = new Store(join(TMP, `${name}.db`))
	return { store, mm: new MemoryManager({ store, memoryPath: join(TMP, `${name}-none.md`), profilePath: join(TMP, `${name}-none2.md`) }) }
}

test('1. 기억 추출기: LLM이 "없음"이라 답하면 저장하지 않고, 폴백은 LLM을 못 쓸 때만·좁게·고정 없이', async () => {
	const router = result => ({
		calls: 0,
		async run() { this.calls++; if (result instanceof Error) throw result; return { result } },
	})
	const base = { cfg: { memory: {} }, mode: 'api', model: 'm', now: T0 }

	// LLM이 스키마대로 빈 배열로 답하면 정규식 폴백으로 넘어가지 않는다(예전에는 아래 문장들이 모두 저장됐다)
	for (const text of ['쓰레기통 비워야 하는데 몇 시야?', '환풍기 상태 보고 돌아올게', '휴가 때 쓸 에어컨 설정 알려줘', '앞으로 공기청정기 상태 알려줘', '원주집에갔다가 월요일에 올께']) {
		const r = router({ ops: [] })
		assert.deepEqual(await extractMemoryFromTurn({ ...base, text, llmRouter: r }), [], text)
		assert.equal(r.calls, 1, `${text}: LLM 추출기를 실제로 불렀음`)
	}

	// LLM이 준 항목은 쓰되, 고정(pinned)은 떼고 형식이 틀린 항목은 버린다
	const llmOps = await extractMemoryFromTurn({
		...base,
		text: '앞으로 밤에는 거실 불 끄지 마',
		llmRouter: router({ ops: [
			{ op: 'upsert', category: 'standing_order', key: 'no_night_off', content: '밤에 거실 불 끄지 않기', ttl_days: null, pinned: true, confidence: 0.9, entity_ids: null },
			{ bogus: true },
		] }),
	})
	assert.equal(llmOps.length, 1)
	assert.equal(llmOps[0].key, 'no_night_off')
	assert.equal(llmOps[0].pinned, null)

	// LLM 호출 실패·형식 오류(ops 없음)일 때만 결정론적 폴백을 쓴다
	const viaErr = await extractMemoryFromTurn({ ...base, text: '원주집에갔다가 월요일에 올께', llmRouter: router(new Error('timeout')) })
	assert.equal(viaErr[0]?.category, 'incident')
	const viaBad = await extractMemoryFromTurn({ ...base, text: '원주집에갔다가 월요일에 올께', llmRouter: router({ speech: '형식 오류' }) })
	assert.equal(viaBad[0]?.category, 'incident')

	// 폴백 패턴은 좁다: 오탐 문장은 저장하지 않는다
	for (const text of [
		'쓰레기통 비워야 하는데 몇 시야?', '환풍기 상태 보고 돌아올게', '휴가 때 쓸 에어컨 설정 알려줘',
		'앞으로 공기청정기 상태 알려줘', '여행 가서 쓸 충전기 어디 있어?', '오늘 거실 불 켜지 마',
	]) {
		assert.deepEqual(deterministicExtract(text, T0), [], text)
	}
	// 확실한 말은 여전히 저장하고, 고정은 붙이지 않는다
	assert.equal(deterministicExtract('내일 본가 다녀올게 금요일에 와', T0)[0]?.category, 'incident')
	const order = deterministicExtract('앞으로 밤에는 거실 불 끄지 마', T0)
	assert.equal(order[0]?.category, 'standing_order')
	assert.equal(order[0]?.pinned, false)
	assert.equal(deterministicExtract('앞으로 에어컨은 24도로 유지해', T0)[0]?.category, 'preference')

	// 저장해도 자동 고정되지 않는다(잘못 저장됐으면 대화·콘솔에서 지울 수 있게)
	const { store, mm } = newMemory('extract')
	try {
		mm.applyOps(order, { source: 'extractor', now: T0 })
		assert.equal(store.getMemory(order[0].key).pinned, false)
	} finally { store.close() }
})

test('3. 기억 보호: 고정·사용자 등록·대화 기억은 더 낮은 출처가 덮어쓰거나 지울 수 없다', async () => {
	const { store, mm } = newMemory('protect')
	try {
		mm.applyOps([{ op: 'upsert', category: 'standing_order', key: 'console_order', content: '세탁기 끝나면 알려줘' }], { source: 'console', now: T0 })
		mm.applyOps([{ op: 'upsert', category: 'preference', key: 'pinned_pref', content: '공기청정기는 자동 모드', pinned: true }], { source: 'cycle', now: T0 })
		mm.applyOps([{ op: 'upsert', category: 'incident', key: 'trip', content: '금요일까지 출장', ttl_days: 3 }], { source: 'assist_user', now: T0 })
		mm.applyOps([{ op: 'upsert', category: 'pattern', key: 'auto_pat', content: '평일 7시 기상' }], { source: 'cycle', now: T0 })

		// 1) 콘솔 등록 기억: 추출기·Assist 대화·백그라운드 모두 덮어쓰지 못하고 내용이 그대로 남는다
		for (const source of ['extractor', 'assist_user', 'cycle']) {
			const r = mm.applyOps([{ op: 'upsert', category: 'standing_order', key: 'console_order', content: `잘못 들은 말 (${source})` }], { source, now: T0 + 1000 })
			assert.deepEqual([r.upserted.length, r.blocked.length], [0, 1], source)
		}
		assert.equal(store.getMemory('console_order').content, '세탁기 끝나면 알려줘')
		// 내용이 같으면 차단 목록에 올리지 않고 조용히 넘어간다(LLM이 같은 기억을 다시 써도 거절 기록이 쌓이지 않게)
		const same = mm.applyOps([{ op: 'upsert', category: 'standing_order', key: 'console_order', content: '세탁기 끝나면 알려줘' }], { source: 'cycle', now: T0 + 1000 })
		assert.deepEqual([same.upserted.length, same.blocked.length], [0, 0])
		// 사용자 직접 조작은 바꿀 수 있다
		assert.equal(mm.applyOps([{ op: 'upsert', category: 'standing_order', key: 'console_order', content: '세탁기·건조기 끝나면 알려줘' }], { source: 'cli', now: T0 + 2000 }).upserted.length, 1)

		// 2) 고정 기억: Assist 대화(LLM 해석)로는 지우거나 바꿀 수 없고, 콘솔은 가능
		const assistDel = mm.applyOps([{ op: 'delete', key: 'pinned_pref' }], { source: 'assist_user', now: T0 })
		assert.equal(assistDel.blocked.length, 1)
		assert.match(assistDel.blocked[0].error, /웹 콘솔/)
		assert.ok(store.getMemory('pinned_pref').active)
		assert.equal(mm.applyOps([{ op: 'delete', key: 'pinned_pref' }], { source: 'console', force: true, now: T0 }).deleted.length, 1)

		// 3) Assist 대화로 저장한 기억: 백그라운드 판단은 못 바꾸고, 대화(assist_user·추출기)는 바꿀 수 있다
		assert.equal(mm.applyOps([{ op: 'delete', key: 'trip' }], { source: 'cycle', now: T0 }).blocked.length, 1)
		assert.equal(mm.applyOps([{ op: 'upsert', category: 'incident', key: 'trip', content: '덮어쓰기' }], { source: 'cycle', now: T0 }).blocked.length, 1)
		assert.equal(mm.applyOps([{ op: 'upsert', category: 'incident', key: 'trip', content: '토요일까지 출장으로 연장', ttl_days: 4 }], { source: 'extractor', now: T0 }).upserted.length, 1)
		assert.equal(mm.applyOps([{ op: 'delete', key: 'trip' }], { source: 'assist_user', now: T0 }).deleted.length, 1)

		// 4) 백그라운드가 만든 기억은 예전처럼 백그라운드가 바꿀 수 있다
		assert.equal(mm.applyOps([{ op: 'upsert', category: 'pattern', key: 'auto_pat', content: '평일 7시 반 기상' }], { source: 'cycle', now: T0 }).upserted.length, 1)

		// 5) Assist 대화로 만든 영구 지시는 자동 고정되지 않는다(콘솔·CLI로 만든 것만 자동 고정)
		mm.applyOps([{ op: 'upsert', category: 'standing_order', key: 'assist_order', content: '밤에 거실 불 끄지 마' }], { source: 'assist_user', now: T0 })
		assert.equal(store.getMemory('assist_order').pinned, false)
		assert.equal(store.getMemory('console_order').pinned, true)

		// 6) Assist 도구 경로: 기억 도구는 'assist_user' 출처로 기록되어 고정 기억을 지우지 못한다
		mm.applyOps([{ op: 'upsert', category: 'preference', key: 'pinned_2', content: '거실 온도 24도', pinned: true }], { source: 'console', now: T0 })
		const broker = new ToolBroker({ memory: mm })
		const viaTool = JSON.parse(await broker.run('memory_delete', JSON.stringify({ key: 'pinned_2' }), { allowDirectRequest: true, memorySource: 'assist_user' }))
		assert.equal(viaTool.blocked.length, 1)
		assert.ok(store.getMemory('pinned_2').active)
		const upTool = JSON.parse(await broker.run('memory_upsert', JSON.stringify({ category: 'preference', key: 'tool_pref', content: '조명은 따뜻한 색', ttl_days: null, confidence: null, pinned: null, entity_ids: null }), { allowDirectRequest: true, memorySource: 'assist_user' }))
		assert.deepEqual(upTool.upserted, ['tool_pref'])
		assert.equal(store.getMemory('tool_pref').source, 'assist_user')

		// 7) 기억 통합(Consolidation)은 사용자 등록 기억을 병합하지 않는다
		mm.applyOps([{ op: 'upsert', category: 'incident', key: 'relay_a', content: '11월 21일 화장실 릴레이 정전 복구 설정이 켜짐으로 바뀜 원인은 미확인' }], { source: 'console', now: T0 })
		mm.applyOps([{ op: 'upsert', category: 'incident', key: 'relay_b', content: '11월 21일 화장실 릴레이 정전 복구 설정이 켜짐으로 바뀜 원인은 미확인이며 추가 확인 필요' }], { source: 'cycle', now: T0 })
		const cons = mm.consolidate({ now: T0 })
		assert.equal(cons.merged.length, 0)
		assert.ok(cons.duplicates.some(d => [d.keep, d.dup].includes('relay_a')), '중복 의심 힌트는 그대로 보여 준다')
		assert.ok(store.getMemory('relay_a').active && store.getMemory('relay_b').active)
	} finally { store.close() }
})

test('2·5. 제안: 승인 중 거절·만료·중복 승인이 끼어들지 못하고, 자동 롤백 실패는 rollback_failed로 남아 비상 알림·재롤백', async () => {
	const { store, mm } = newMemory('proposal')
	try {
		let gate = null
		const ha = {
			connected: true,
			guard: { allowConfigWrite: false },
			saved: new Map(),
			failSave: false,
			failRestore: false,
			async getConfigRest(d, id) { return this.saved.get(`${d}:${id}`) ?? null },
			async saveConfigRest(d, id, c) {
				if (gate) await gate
				if (this.failSave) throw new Error('HA 500')
				this.saved.set(`${d}:${id}`, c)
			},
			async deleteConfigRest(d, id) {
				if (this.failRestore) throw new Error('HA 연결 끊김')
				this.saved.delete(`${d}:${id}`)
			},
			async callService() {},
			async checkConfig() { return { result: 'valid' } },
			async renderTemplate() { return 'ok' },
		}
		const states = new Map([['light.a', st('light.a', 'on')]])
		const cfg = mergeConfig({ policy: { admin_enabled: true, proposal_expire_hours: 0.05 } }) // 3분 뒤 만료
		const alerts = []
		const adm = new HaAdmin({ cfg, ha, store, states, memory: mm, onRollbackFailed: p => alerts.push(p) })
		// 같은 DB를 쓰는 다른 프로세스(CLI)
		const cliAdm = new HaAdmin({ cfg, ha, store, states, memory: mm })
		const mk = async alias => {
			const r = await adm.createProposal({
				kind: 'automation_upsert', target_id: '', title: alias, summary: 's',
				payload: { config: { id: alias, alias, triggers: [{ trigger: 'state', entity_id: 'light.a' }], actions: [{ action: 'light.turn_off', target: { entity_id: 'light.a' } }] } },
			}, T0)
			assert.equal(r.ok, true, r.error)
			return r.proposal
		}

		// A) 승인이 HA에 쓰는 동안 거절(알림 버튼·CLI)·만료·중복 승인이 들어와도 막힌다
		const pA = await mk('a1')
		let open
		gate = new Promise(r => { open = r })
		const approving = adm.approveProposal(pA.pid, T0)
		await new Promise(r => setImmediate(r))
		assert.equal(store.getProposal(pA.pid).status, 'applying')
		assert.equal(adm.rejectProposal(pA.pid, T0).ok, false)
		assert.equal(cliAdm.rejectProposal(pA.pid, T0).ok, false)
		const dup = await cliAdm.approveProposal(pA.pid, T0)
		assert.equal(dup.ok, false)
		assert.match(dup.error, /applying/)
		assert.equal(adm.expireProposals(T0 + 10 * 60000).some(p => p.pid === pA.pid), false, '적용 중인 제안은 만료되지 않음')
		open()
		const resA = await approving
		gate = null
		assert.equal(resA.ok, true)
		assert.equal(store.getProposal(pA.pid).status, 'applied')
		assert.equal(mm.list(null, { now: T0 }).some(m => m.key.startsWith('rej_')), false, '적용된 제안에 거절 기억이 남지 않음')

		// B) 거절이 먼저면 승인은 적용하지 않는다
		const pB = await mk('b1')
		assert.equal(cliAdm.rejectProposal(pB.pid, T0).ok, true)
		const lateApprove = await adm.approveProposal(pB.pid, T0)
		assert.equal(lateApprove.ok, false)
		assert.equal(store.getProposal(pB.pid).status, 'rejected')

		// C) 적용 도중 프로세스가 죽어 'applying'에 멈춘 제안은 15분 뒤 'interrupted'로 바뀌고 [롤백] 대상이 된다
		const pC = await mk('c1')
		assert.ok(store.transitionProposal(pC.pid, 'pending', 'applying', { decidedAt: T0 }))
		const recovered = adm.expireProposals(T0 + 20 * 60000).find(p => p.pid === pC.pid)
		assert.equal(recovered?.status, 'interrupted')
		assert.equal(adm.canRollback(recovered), true)
		assert.match(proposalResultPayload(recovered).title, /적용 중단/)

		// D) 적용 실패 뒤 자동 롤백까지 실패하면 'rolled_back'이라 하지 않고 'rollback_failed' + 비상 알림
		const pD = await mk('d1')
		ha.failSave = true
		ha.failRestore = true
		const resD = await adm.approveProposal(pD.pid, T0)
		assert.equal(resD.ok, false)
		assert.equal(resD.proposal.status, 'rollback_failed')
		assert.match(resD.error, /자동 롤백도 실패/)
		assert.equal(store.getProposal(pD.pid).status, 'rollback_failed')
		assert.equal(alerts.length, 1)
		assert.equal(alerts[0].pid, pD.pid)
		assert.equal(adm.canRollback(resD.proposal), true)
		assert.match(proposalResultPayload(resD.proposal).title, /롤백 실패/)
		// HA가 돌아오면 [롤백]을 다시 눌러 되돌릴 수 있다
		ha.failSave = false
		ha.failRestore = false
		const rb = await adm.rollbackProposal(pD.pid, T0)
		assert.equal(rb.ok, true)
		assert.equal(store.getProposal(pD.pid).status, 'rolled_back')

		// E) 자동 롤백이 성공하는 경우는 예전처럼 'rolled_back'
		const pE = await mk('e1')
		ha.failSave = true
		const resE = await adm.approveProposal(pE.pid, T0)
		assert.equal(resE.proposal.status, 'rolled_back')
		assert.equal(alerts.length, 1, '롤백이 성공하면 비상 알림 없음')
		ha.failSave = false

		// F) HA 설정을 읽지 못해 적용을 미루면 다시 승인할 수 있게 pending으로 돌아간다
		const pF = await mk('f1')
		const realGet = ha.getConfigRest
		ha.getConfigRest = async () => { throw new Error('HA 연결 시간 초과') }
		const resF = await adm.approveProposal(pF.pid, T0)
		assert.equal(resF.ok, false)
		assert.equal(store.getProposal(pF.pid).status, 'pending')
		ha.getConfigRest = realGet
		assert.equal((await adm.approveProposal(pF.pid, T0)).ok, true)
	} finally { store.close() }
})

test('4. 실험 판정: 대상 범위 신호만 비교하고, 표본이 적으면 inconclusive로 두고 교훈 신뢰도를 건드리지 않는다', () => {
	const store = new Store(join(TMP, 'exp.db'))
	try {
		// (a) 신호 1건 → 0건은 예전에는 improved였지만 이제 판단 보류
		assert.equal(judgeExperiment({ negative_implicit: 1 }, { negative_implicit: 0 }).verdict, 'inconclusive')
		store.upsertLesson({ key: 'les1', scope: 'assist', condition_text: 'c', rule_text: 'r', confidence: 0.7, source: 'user_approved', now: T0 })
		store.recordImplicitFeedback({ ts: T0 - HOUR, kind: 'assist_retry', score: -0.5 })
		const e1 = registerExperiment(store, { kind: 'lesson', ref_id: 'les1', title: '교훈', evalDays: 7, now: T0 })
		assert.deepEqual(e1.baseline_metrics.scope, { channel: 'assist' }, '교훈 범위(assist)에서 실험 범위를 짐작')
		const [r1] = evaluateDueExperiments(store, T0 + 8 * DAY)
		assert.equal(r1.verdict, 'inconclusive')
		assert.equal(store.getLesson('les1').confidence, 0.7, '판단 보류면 신뢰도 그대로')

		// (b) 규칙 실험: 다른 규칙의 🔕가 늘어도(집 전체로는 악화) 이 규칙의 🔕가 사라졌으면 개선
		const T1 = T0 + 30 * DAY
		for (let i = 1; i <= 4; i++) store.recordFeedback({ ts: T1 - i * HOUR, nid: `n${i}`, kind: 'mute', rules: ['my_rule'] })
		for (let i = 1; i <= 5; i++) store.recordFeedback({ ts: T1 - i * HOUR, nid: `o${i}`, kind: 'mute', rules: ['other_rule'] })
		registerExperiment(store, { kind: 'rule', ref_id: 'my_rule', title: '규칙', evalDays: 7, now: T1, scope: { rule_ids: ['my_rule'], entity_ids: ['sensor.x'] } })
		for (let i = 1; i <= 20; i++) store.recordFeedback({ ts: T1 + 2 * DAY + i * HOUR, nid: `p${i}`, kind: 'mute', rules: ['other_rule'] })
		// (c) 엔티티 실험: 그 기기를 사람이 곧바로 되돌린 일이 늘면 악화
		registerExperiment(store, { kind: 'proposal:automation_upsert', ref_id: 'p1', title: '자동화', evalDays: 7, now: T1, scope: proposalExperimentScope({ kind: 'automation_upsert', target_id: 'light.y', payload: {} }) })
		for (let i = 1; i <= 3; i++) store.recordImplicitFeedback({ ts: T1 + 3 * DAY + i * HOUR, kind: 'action_reverted', entity_id: 'light.y', score: -1 })
		const out = evaluateDueExperiments(store, T1 + 8 * DAY)
		const rule = out.find(e => e.ref_id === 'my_rule')
		assert.equal(rule.verdict, 'improved')
		assert.ok(rule.after_metrics.fb_mute > rule.baseline_metrics.fb_mute, '집 전체 🔕는 늘었지만 범위 밖 신호라 무시')
		assert.equal(judgeExperiment({ fb_mute: rule.baseline_metrics.fb_mute }, { fb_mute: rule.after_metrics.fb_mute }).verdict, 'regressed', '예전 방식(집 전체)이었다면 악화로 오판')
		assert.equal(out.find(e => e.ref_id === 'p1').verdict, 'regressed')
	} finally { store.close() }
})

test('6. Assist HTTP: 본문 초과 413, JSON 오류 400, 예상 못 한 오류는 500 + 내부 메시지 숨김', async () => {
	const cfg = mergeConfig({
		heartbeat: { enabled: false },
		assist: { enabled: true, host: '127.0.0.1', port: 0, token_file: join(TMP, 'tok-http'), allowed_networks: ['127.0.0.0/8'] },
	})
	const agent = {
		statusSummary() { throw new Error('비밀 경로 /home/ubuntu/.config/ha-agent 열기 실패') },
		async handleAssist({ text }) { return { conversation_id: 'c1', speech: `받음: ${text.length}자`, actions: [], proposals: [] } },
	}
	const srv = new AssistServer({ cfg, agent, token: 'tok' })
	const port = await srv.start()
	const url = p => `http://127.0.0.1:${port}${p}`
	const auth = { authorization: 'Bearer tok', 'content-type': 'application/json' }
	try {
		const big = await fetch(url('/api/assist/converse'), { method: 'POST', headers: auth, body: JSON.stringify({ text: 'x'.repeat(300 * 1024) }) })
		assert.equal(big.status, 413)
		assert.match((await big.json()).error, /너무 큼/)

		const bad = await fetch(url('/api/assist/converse'), { method: 'POST', headers: auth, body: '{not json' })
		assert.equal(bad.status, 400)
		assert.match((await bad.json()).error, /JSON 파싱 실패/)
		const arr = await fetch(url('/api/assist/converse'), { method: 'POST', headers: auth, body: '[1,2]' })
		assert.equal(arr.status, 400)

		const boom = await fetch(url('/api/status'), { headers: auth })
		assert.equal(boom.status, 500)
		const boomBody = await boom.json()
		assert.equal(/비밀 경로|\.config/.test(boomBody.error), false, '내부 오류 내용을 응답에 싣지 않음')
		assert.match(boomBody.error, /서버 내부 오류/)

		// 오류 뒤에도 서버는 정상 응답
		const ok = await fetch(url('/api/assist/converse'), { method: 'POST', headers: auth, body: JSON.stringify({ text: '안녕' }) })
		assert.equal(ok.status, 200)
		assert.match((await ok.json()).response.speech, /받음: 2자/)
	} finally { await srv.stop() }
})

test('7·8. 허용 네트워크는 루프백·Tailscale만, systemd 유닛은 UMask=0077', () => {
	const nets = LIVE_CFG.assist.allowed_networks
	for (const ip of ['127.0.0.1', '::1', '100.110.65.127', '::ffff:100.121.130.25', 'fd7a:115c:a1e0::1']) assert.equal(isIpAllowed(ip, nets), true, ip)
	for (const ip of ['10.0.0.5', '172.17.0.2', '192.168.0.10', '8.8.8.8']) assert.equal(isIpAllowed(ip, nets), false, ip)
	const unit = readFileSync(new URL('../systemd/ha-agent.service', import.meta.url), 'utf8')
	assert.match(unit, /^UMask=0077$/m)
})

test('9. Tier 3: 코드 기본값은 도메인 바닥만, 집 특화 기기는 config.json에서', () => {
	assert.deepEqual(DEFAULT_TIER3_PATTERNS, ['lock.*', 'alarm_control_panel.*', 'update.*'])
	const bare = new PolicyEngine(mergeConfig({ actions: { enabled: true } }))
	assert.equal(bare.isTier3Blocked('lock.front'), true)
	assert.equal(bare.isTier3Blocked('switch.setagsil_setagsil_setaggi_power'), false, '집 특화 기기는 코드에 없음')

	// 실제 config.json만으로 예전 코드 기본값의 집 특화 기기가 모두 막힌다(동작 변화 없음)
	const pol = new PolicyEngine(mergeConfig(LIVE_CFG))
	for (const id of [
		'switch.jubang_jubang_hairaiteu_1', 'switch.geosil_geosil_seumateu_peulreogeu_2', 'switch.setagsil_setagsil_setaggi_power',
		'switch.setagsil_setagsil_geonjogi_power', 'script.unknown', 'input_boolean.kona_engine', 'select.bul_jeongjeon_bosang_mode', 'select.hwajangsil_seuwici_x',
	]) assert.equal(pol.isTier3Blocked(id), true, id)

	// 비어 있으면 시작할 때 경고
	assert.ok(validateConfig(mergeConfig({ actions: { enabled: true } })).warnings.some(w => /tier3_blocked가 비어/.test(w)))
	assert.equal(validateConfig(mergeConfig(LIVE_CFG)).warnings.some(w => /tier3_blocked가 비어/.test(w)), false)
})
