// 관리 명령: node src/cli.mjs <명령>
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, cpSync, copyFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { P, ROOT, readJson, writeJson, readJsonlAll, latestBy, fmt, kst, newId, expandHome } from './util.mjs'
import { loadConfig, loadControl, saveControl, validateConfig } from './config.mjs'
import { MODES, MODE_LABEL, normalizeMode, brainMode, brainSettings, selfCheck } from './brain.mjs'
import { recentFires } from './rules.mjs'
import { rangeStats } from './records.mjs'
import { PolicyEngine } from './core/policy.mjs'
import { Store } from './core/store.mjs'
import { Journal } from './core/journal.mjs'
import { MemoryManager } from './core/memory.mjs'
import { mineRoutines, scoreRules, generateSelfProposals, loadEvalCases, evaluateDueExperiments, ImplicitFeedbackTracker } from './engine/learning.mjs'
import { checkOobSlackConfig, checkOobKakaoConfig } from './oob.mjs'
import { HA } from './ha.mjs'
import { HaAdmin } from './admin/ha-admin.mjs'
import { geminiKey } from './llm/providers/gemini.mjs'
import { buildScorecard, renderScorecard } from './engine/scorecard.mjs'
import { suggestAutomations } from './engine/automation-suggest.mjs'
import { scanDeviceHealth } from './engine/device-health.mjs'
import { fastPathCases, runFastPathRegression, directoryIndexFor } from './engine/regression.mjs'
import { globs } from './util.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const daemonPid = () => { const p = Number(existsSync(P.pid) ? readFileSync(P.pid, 'utf8') : 0); try { return p && process.kill(p, 0) ? p : 0 } catch { return 0 } }
const toInbox = obj => {
	mkdirSync(P.inbox, { recursive: true })
	writeJson(join(P.inbox, `${Date.now()}-${newId()}.json`), obj)
}
const VERB = { turn_on: '켜기', turn_off: '끄기' }
const MODE_DESC = { codex: 'OpenAI Codex CLI', api: 'OpenAI API 직접 호출', agy: 'Gemini Antigravity CLI', gemini: 'Gemini API 직접 호출' }
const brainLine = (cfg, c) => {
	const mode = brainMode(cfg, c), s = brainSettings(cfg, mode)
	const from = MODES.includes(c.brain) ? `cli brain으로 바꿈, config.json은 ${brainMode(cfg)}` : 'config.json'
	return `판단 방식: ${mode} (${MODE_DESC[mode]}) | 모델 ${s.model}, 노력 ${s.effort_hourly}/${s.effort}/${s.effort_deep} | ${from}`
}

async function assistIpc(cfg, method, path, body = null) {
	const a = cfg.assist ?? {}
	if (!a.enabled || !daemonPid()) return null
	const tokPath = expandHome(a.token_file || '~/.config/ha-agent/assist-token')
	if (!existsSync(tokPath)) return null
	const tok = readFileSync(tokPath, 'utf8').trim()
	if (!tok) return null
	const rawHost = a.host
	const host = (!rawHost || rawHost === '0.0.0.0' || rawHost === '::') ? '127.0.0.1' : rawHost
	const url = `http://${host}:${a.port ?? 8787}${path}`
	const res = await fetch(url, {
		method,
		headers: { authorization: `Bearer ${tok}`, ...(body != null ? { 'content-type': 'application/json' } : {}) },
		...(body != null ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout((a.timeout_seconds ?? 90) * 1000),
	})
	const json = await res.json().catch(() => ({}))
	if (!res.ok) {
		const err = new Error(json.error || `HTTP ${res.status}`)
		err.status = res.status
		err.body = json
		throw err
	}
	return json
}

async function withLiveHa(cfg, fn) {
	const policy = new PolicyEngine(cfg)
	const ha = new HA({ url: cfg.ha_ws_url, tokenFile: expandHome(cfg.token_file), notifyTargets: cfg.notify_targets, policy })
	ha.start()
	try {
		const states = await new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error('HA 연결 시간 초과')), 15000)
			ha.once('ready', list => { clearTimeout(t); resolve(new Map(list.map(s => [s.entity_id, s]))) })
		})
		return await fn(ha, states)
	} finally { ha.stop() }
}

const cmds = {
	status() {
		const c = loadControl(), cfg = loadConfig(), rules = readJson(P.rules, null), rt = readJson(P.runtime, { rules: {} }).rules ?? {}
		const cnt = readJson(P.counters, {}), sched = readJson(P.schedule, []), held = readJson(P.held, [])
		const q = readJson(P.queue, {}), outbox = readJson(P.outbox, [])
		const st = existsSync(P.db) ? new Store() : null
		let pending = [], last = null, lastAssist = null
		try {
			const journal = new Journal({ store: st })
			pending = journal.pendingActions()
			last = journal.latestDecision({ excludeAssist: true, excludeSkipped: true, excludeDeferred: true })
			lastAssist = journal.latestDecision({ onlyAssist: true })
		} finally { st?.close() }
		console.log(`데몬: ${daemonPid() ? `실행 중 (pid ${daemonPid()})` : '꺼짐'} | ${c.paused ? '일시정지' : '동작'} | 알림 발송 ${c.send ? '켜짐' : '꺼짐(시험 모드)'}`)
		console.log(brainLine(cfg, c))
		console.log(`오늘(${cnt.date ?? '-'}): 판단 ${cnt.runs ?? 0}회, 알림 ${cnt.alerts ?? 0}개, 요약 ${cnt.summaries ?? 0}개, 행동 ${cnt.actions ?? 0}회, 되돌리기 ${cnt.undos ?? 0}회`)
		console.log(`규칙 ${rules?.rules?.length ?? 0}개 (지금 조건 참: ${Object.values(rt).filter(r => r.fired).length}개), 예약 ${sched.length}개, 밤사이 보류 ${held.length}개`)
		console.log(`대기 중인 깨움 ${(q.queue ?? []).length}건, 다시 보낼 알림 ${outbox.length}개, 승인 기다리는 행동 ${pending.length}개`)
		const pol = new PolicyEngine(cfg).describe()
		const oobLabel = cfg.oob?.type ? `${cfg.oob.type}${cfg.oob.recipient_name ? `:${cfg.oob.recipient_name}` : ''}${cfg.oob.fallback?.type ? `→${cfg.oob.fallback.type}` : ''}` : '꺼짐'
		console.log(`정책: ${pol.enabled ? `Tier1 자율 ${pol.tier1_auto.length}개, Tier2 승인 ${pol.tier2_confirm.length}개` : '행동 꺼짐'} | HA 관리 ${pol.admin_enabled ? '켜짐' : '꺼짐'} | 비상 알림 길: ${oobLabel} | Assist: ${cfg.assist?.enabled ? `포트 ${cfg.assist.port}` : '꺼짐'}`)
		const wk = cfg.weekly, lastWeekly = readJson(P.runtime, {}).last_weekly
		const schedLabel = Array.isArray(cfg.briefing_hours) && cfg.briefing_hours.length ? `브리핑 ${cfg.briefing_hours.join(',')}시` : `활동 시간 ${cfg.active_hours.start}~${cfg.active_hours.end}시`
		console.log(`주간 분석: ${wk.enabled ? `매주 ${wk.weekday}요일 ${wk.hour}시` : '꺼짐'}${lastWeekly ? ` | 마지막 ${lastWeekly}` : ''} | 하루 돌아보기: ${cfg.reflection_hour == null ? '꺼짐' : `${cfg.reflection_hour}시`} | ${schedLabel}`)
		console.log(`자동 전환(codex↔api · agy↔gemini): ${cfg.failover.enabled ? `${cfg.failover.after_failures}번 연속 실패 시 (${MODES.filter(m => m !== brainMode(cfg, c)).map(m => `${m} ${selfCheck(cfg, m) ? '쓸 수 없음' : '쓸 수 있음'}`).join(', ')})` : '꺼짐'} | urgent 다시 알림: ${cfg.escalation.enabled ? `${cfg.escalation.remind_minutes}분마다 ${cfg.escalation.max_reminders}번` : '꺼짐'}`)
		for (const w of sched) console.log(`  예약 ${fmt(Date.parse(w.at))} ${w.reason}`)
		if (last) console.log(`마지막 판단 ${fmt(Date.parse(last.ts))} (${Math.round((last.total_ms ?? 0) / 1000)}초): ${last.error ? `실패 ${last.error}` : last.summary}`)
		if (lastAssist) console.log(`마지막 Assist ${fmt(Date.parse(lastAssist.ts))} (${Math.round((lastAssist.total_ms ?? 0) / 1000)}초): ${lastAssist.error ? `실패 ${lastAssist.error}` : lastAssist.summary}`)
	},
	policy() {
		const pol = new PolicyEngine(loadConfig()).describe()
		console.log(JSON.stringify(pol, null, 2))
	},
	rules() {
		const rules = readJson(P.rules, null)?.rules ?? [], rt = readJson(P.runtime, { rules: {} }).rules ?? {}
		const now = Date.now()
		const cond = c => `${c.entity_id}${c.attribute ? `[${c.attribute}]` : ''} ${c.op} ${c.value ?? ''}`.trim()
		for (const r of rules) {
			const x = rt[r.id] ?? {}
			const extra = [...(r.also ?? []).map(c => `그리고 ${cond(c)}`), ...(r.hour_from != null ? [`${r.hour_from}~${r.hour_to}시만`] : [])]
			console.log(`${r.id}  [${r.priority}] ${r.description}\n    ${cond(r)}${extra.length ? ` · ${extra.join(' · ')}` : ''} · ${r.for_minutes}분 · 쿨다운 ${r.cooldown_minutes}분 · 7일 발동 ${recentFires(x, now).length}회${x.backtest ? ` · 백테스트 ${x.backtest.days}일 ${x.backtest.fires}회` : ''}${x.waiting ? ' · 쿨다운·쉼 뒤 발동 대기' : ''}${x.muted_until > now ? ` · ${fmt(x.muted_until)}까지 쉼` : ''}`)
		}
		if (!rules.length) console.log('규칙 없음')
	},
	log() {
		const n = Number(rest[0]) || 10
		let rows = readJsonlAll(P.decisions)
		if (!rows.length && existsSync(P.db)) {
			const st = new Store()
			try { rows = st.decisionsInRange(0) } finally { st.close() }
		}
		for (const d of rows.slice(-n)) {
			const u = d.usage ? ` (입력 ${d.usage.input}/캐시 ${d.usage.cached}/출력 ${d.usage.output}/추론 ${d.usage.reasoning})` : ''
			console.log(`${fmt(Date.parse(d.ts))} [${d.reasons.join(', ')}] ${Math.round(d.total_ms / 1000)}초 토큰 ${d.tokens ?? '?'}${u}${d.rounds > 1 ? ` (${d.rounds}번 물음)` : ''}${d.skipped ? ' (건너뜀)' : ''}${d.deferred ? ' (미룸)' : ''}${d.brain && d.brain !== 'codex' ? ` [${d.brain}]` : ''}${d.failover ? ' (자동 전환)' : ''}`)
			console.log(`  ${d.error ? `실패: ${d.error}` : d.summary}`)
			const a = d.applied
			if (a) {
				const parts = []
				if (a.added?.length) parts.push(`규칙 추가 ${a.added.join(', ')}`)
				if (a.changed?.length) parts.push(`규칙 수정 ${a.changed.join(', ')}`)
				if (a.deleted?.length) parts.push(`규칙 삭제 ${a.deleted.join(', ')}`)
				if (a.wakes?.length) parts.push(`예약 ${a.wakes.join(', ')}`)
				if (a.memory && a.memory !== 'keep') parts.push(`메모 ${a.memory}`)
				if (a.proposals?.length) parts.push(`제안 ${a.proposals.join(', ')}`)
				if (a.report) parts.push(`주간 보고서 ${a.report}`)
				if (a.rejected?.length) parts.push(`거절 ${a.rejected.length}건`)
				if (a.backtest?.length) parts.push(`백테스트 ${a.backtest.join(', ')}`)
				if (parts.length) console.log(`  ${parts.join(' · ')}`)
				for (const x of a.actions ?? []) console.log(`  행동 ${x}`)
				for (const n of a.notifications ?? []) console.log(`  알림 ${n}`)
			}
		}
	},
	notes() {
		const day = rest[0] ?? kst().date
		for (const n of latestBy(readJsonlAll(P.notifications), 'nid').filter(n => kst(new Date(n.ts)).date === day)) console.log(`${kst(new Date(n.ts)).hm} [${n.kind}/${n.level}/${n.status}] ${n.title} — ${n.message}`)
	},
	actions() {
		const n = Number(rest[0]) || 20
		const list = latestBy(readJsonlAll(P.actions), 'aid').slice(-n)
		for (const a of list) console.log(`${fmt(Date.parse(a.ts))} [${a.tier}/${a.status}] ${a.name} ${VERB[a.action] ?? a.action} — ${a.reason}${a.error ? ` (${a.error})` : ''}`)
		if (!list.length) console.log('행동 기록 없음')
	},
	async memory() {
		const sub = rest[0]
		const cfg = loadConfig()
		if (!sub) {
			console.log(existsSync(P.memory) ? readFileSync(P.memory, 'utf8') : '(비어 있음)')
			if (existsSync(P.db)) {
				const st = new Store()
				try {
					const items = st.listMemory()
					if (items.length) {
						console.log('=== 구조화 장기 기억 ===')
						for (const it of items) console.log(`- [${it.category}] ${it.key}: ${it.content}`)
					}
				} finally { st.close() }
			}
			return
		}
		const st = new Store()
		const mgr = new MemoryManager({ store: st, cfg })
		try {
			if (sub === 'list') {
				const items = mgr.list(rest[1] ?? null)
				for (const it of items) {
					const exp = it.expires_at ? ` (만료 ${fmt(it.expires_at)})` : ''
					const embTag = it.embedding?.model ? ` [${it.embedding.model}/${it.embedding.dims}d]` : ''
					console.log(`${it.pinned ? '📌 ' : ''}[${it.category}|P${it.priority ?? 3}] ${it.key}${embTag}: ${it.content}${exp}`)
				}
				if (!items.length) console.log('구조화 기억 없음')
			} else if (sub === 'search') {
				const q = rest.slice(1).join(' ')
				const hits = await mgr.searchAsync(q, null, { includeArchived: true })
				for (const it of hits) console.log(`[${it.category}${it.active ? '' : '/보관'}] ${it.key}: ${it.content}`)
				if (!hits.length) console.log('검색 결과 없음')
			} else if (sub === 'add' && rest.length >= 4) {
				const [, cat, key, ...txt] = rest
				const res = mgr.applyOps([{ op: 'upsert', category: cat, key, content: txt.join(' ') }], { source: 'cli' })
				await mgr.flushEmbeddings()
				console.log(JSON.stringify(res))
			} else if (sub === 'rm' && rest[1]) {
				console.log(JSON.stringify(mgr.applyOps([{ op: 'delete', key: rest[1] }], { source: 'cli', force: true })))
			} else if ((sub === 'pin' || sub === 'unpin') && rest[1]) {
				const item = mgr.setPinned(rest[1], sub === 'pin', { source: 'cli' })
				console.log(item ? `${item.key}: pinned=${item.pinned}` : `찾지 못함: ${rest[1]}`)
			} else if (sub === 'history') {
				for (const h of mgr.history(rest[1] ?? null, 20)) {
					console.log(`#${h.id} ${fmt(h.ts)} [${h.op}/${h.source}] ${h.memory_key}: ${h.new_content ?? h.prev_content ?? ''}`)
				}
			} else if (sub === 'restore' && rest[1]) {
				const res = mgr.restoreVersion(Number(rest[1]), { source: 'cli' })
				await mgr.flushEmbeddings()
				console.log(JSON.stringify(res, null, 2))
			} else if (sub === 'consolidate') {
				const dry = rest.includes('--dry')
				const res = mgr.consolidate({ dry })
				await mgr.flushEmbeddings()
				console.log(JSON.stringify(res, null, 2))
			} else if (sub === 'reindex') {
				const res = await mgr.backfillEmbeddings({ includeArchived: true })
				console.log(JSON.stringify(res, null, 2))
			} else {
				console.log('쓰는 법: memory [list [cat]|search <키워드>|add <cat> <key> <내용>|rm <key>|pin <key>|unpin <key>|history [key]|restore <이력번호>|consolidate [--dry]|reindex]')
			}
		} finally { st.close() }
	},
	learning() {
		const cfg = loadConfig(), rules = readJson(P.rules, null)?.rules ?? [], rt = readJson(P.runtime, { rules: {} }).rules ?? {}
		const st = new Store()
		try {
			const now = Date.now()
			const impl = new ImplicitFeedbackTracker({ store: st }).summarize({ sinceMs: now - 14 * 86400000 })
			const lessons = st.listLessons({ limit: 30 })
			const exps = st.listExperiments({ limit: 20 })
			const scores = scoreRules({ rules, runtime: rt, store: st, now })
			const routines = mineRoutines({ store: st, now })
			const evals = loadEvalCases()
			const cands = generateSelfProposals({ store: st, cfg, rules, now })
			console.log('=== 자가학습 현황 ===')
			console.log('암묵적 피드백(14일):', JSON.stringify(impl))
			console.log(`교훈(Playbook) ${lessons.length}건:`)
			for (const l of lessons) console.log(`  - [${l.scope}] ${l.key} (신뢰 ${l.confidence}, 근거 ${l.evidence_count}): ${l.condition_text} → ${l.rule_text}`)
			console.log(`실험 원장 ${exps.length}건:`)
			for (const e of exps) console.log(`  - [${e.status}] ${e.eid} ${e.title}${e.notes ? ` (${e.notes})` : ''}`)
			console.log('규칙 정밀도 주의:', scores.filter(s => s.grade === 'noisy' || s.grade === 'muted').map(s => `${s.id}(${s.grade})`).join(', ') || '없음')
			console.log(`루틴 발견: 재실 ${routines.presence_routines.length}건, 기기 ${routines.device_routines.length}건 (재시작 노이즈 ${routines.filtered_restart_events}건 제외)`)
			console.log(`학습된 회귀 평가 케이스: ${evals.length}건`)
			console.log(`자가 튜닝 제안 후보: ${cands.length}건`)
			for (const c of cands) console.log(`  - (${c.kind}) ${c.title}: ${c.summary}`)
		} finally { st.close() }
	},
	routines() {
		const st = new Store()
		try { console.log(JSON.stringify(mineRoutines({ store: st, days: Number(rest[0]) || 42 }), null, 2)) } finally { st.close() }
	},
	experiments() {
		const st = new Store()
		try {
			if (rest[0] === 'eval') console.log(JSON.stringify(evaluateDueExperiments(st), null, 2))
			else console.log(JSON.stringify(st.listExperiments({ limit: 30 }), null, 2))
		} finally { st.close() }
	},
	evals() {
		console.log(JSON.stringify(loadEvalCases(), null, 2))
	},
	// 자기 성능 지표(주 단위 추세)
	scorecard() {
		const st = new Store()
		try {
			const sc = buildScorecard({ store: st, weeks: Number(rest[0]) || 4, regression: readJson(P.runtime, {}).last_regression ?? null })
			if (rest.includes('--json')) return console.log(JSON.stringify(sc, null, 2))
			console.log(renderScorecard(sc))
		} finally { st.close() }
	},
	// 생활 루틴 → 자동화 제안. 기본은 계산만(dry), apply면 데몬을 통해 승인 대기 제안으로 올린다.
	async 'suggest-automations'() {
		const cfg = loadConfig()
		const apply = rest[0] === 'apply'
		const ipc = await assistIpc(cfg, apply ? 'POST' : 'GET', '/api/automation-suggestions').catch(() => null)
		let res = ipc
		if (!res) {
			if (apply) return console.log('데몬이 돌고 있지 않아 제안을 올릴 수 없어요(계산만 하려면 apply 없이 실행)')
			const st = new Store()
			try {
				res = await withLiveHa(cfg, async (ha, states) => {
					const autoCfg = {}
					for (const id of [...states.keys()].filter(i => i.startsWith('automation.'))) {
						try { autoCfg[id] = (await ha.call({ type: 'automation/config', entity_id: id }))?.config } catch {}
					}
					// 데몬과 같은 기준으로 물리 조작을 추정하도록 통합 이름도 읽는다.
					const platformOf = new Map()
					try { for (const e of await ha.call({ type: 'config/entity_registry/list' })) if (e.platform) platformOf.set(e.entity_id, e.platform) } catch {}
					return suggestAutomations({ store: st, ha, states, meta: { autoCfg, platformOf }, policy: new PolicyEngine(cfg), cfg, isNoise: globs(cfg.noise_entities), proposals: st.listProposals({ limit: 500 }), dry: true })
				})
			} finally { st.close() }
		}
		const label = { eligible: '✅ 제안 가능', proposed: '📨 제안함', skipped: '·' }
		for (const c of res.candidates ?? []) {
			const bt = c.backtest?.[0]
			console.log(`${label[c.status] ?? c.status} ${c.name} (${c.entity_id}) ${c.day_type} ${c.window} ${c.direction === 'on' ? '켜기' : '끄기'} — ${c.status === 'skipped' ? `건너뜀: ${c.reason}${c.automations ? ` [${c.automations.join(', ')}]` : ''}` : ''}${bt ? ` 백테스트(${bt.trigger}): 맞음 ${bt.agree}·불필요 ${bt.unwanted}·놓침 ${bt.missed}` : ''}${c.attribution ? ` 주체 ${JSON.stringify(c.attribution)}` : ''}`)
			if (c.evidence && c.status !== 'skipped') console.log(`    ${c.evidence}`)
		}
		if (!(res.candidates ?? []).length) console.log('루틴 후보가 없어요')
		if (res.created?.length) console.log(`새 제안 ${res.created.length}건: ${res.created.map(p => p.pid).join(', ')}`)
	},
	// 기기 건강(응답 없음·배터리·신호·방 미지정)
	async health() {
		const cfg = loadConfig()
		const ipc = await assistIpc(cfg, 'GET', '/api/health').catch(() => null)
		const res = ipc ?? await withLiveHa(cfg, async (ha, states) => scanDeviceHealth({ states, cfg, isNoise: globs(cfg.noise_entities) }))
		console.log(JSON.stringify(res, null, 2))
	},
	// Assist 빠른 경로 회귀 평가(LLM 없이)
	async regression() {
		const cfg = loadConfig()
		const ipc = await assistIpc(cfg, 'GET', '/api/regression').catch(() => null)
		const res = ipc ?? await withLiveHa(cfg, async (ha, states) => runFastPathRegression({ index: directoryIndexFor({ policy: new PolicyEngine(cfg), states, cfg }), cases: fastPathCases() }))
		console.log(`빠른 경로 회귀 평가: ${res.passed}/${res.total} 통과${res.skipped ? ` (기대값 없는 사례 ${res.skipped}건 제외)` : ''}`)
		for (const f of res.failed ?? []) console.log(`  ✘ "${f.text}" → ${f.got ? f.got.join(' ') : '없음'} (기대 ${f.expect.map(e => e.join(' ')).join(', ') || '제어 없음'})`)
	},
	// 하루 자가개선 작업을 지금 한 번 돌린다(데몬 필요)
	async 'daily-learning'() {
		const cfg = loadConfig()
		const ipc = await assistIpc(cfg, 'POST', '/api/learning/daily').catch(e => ({ error: e.message }))
		console.log(JSON.stringify(ipc ?? { error: '데몬이 돌고 있지 않음' }, null, 2))
	},
	async 'self-tune'() {
		const cfg = loadConfig(), rules = readJson(P.rules, null)?.rules ?? []
		const ipc = rest[0] === 'propose' ? await assistIpc(cfg, 'POST', '/api/learning/propose-self').catch(() => null) : null
		if (ipc) return console.log(JSON.stringify(ipc, null, 2))
		const st = new Store()
		try {
			const cands = generateSelfProposals({ store: st, cfg, rules })
			console.log(JSON.stringify(cands, null, 2))
		} finally { st.close() }
	},
	async proposals() {
		const cfg = loadConfig()
		const sub = rest[0] || 'list', pid = rest[1]
		if (sub === 'list') {
			const ipc = await assistIpc(cfg, 'GET', '/api/proposals').catch(() => null)
			let list = ipc?.proposals
			if (!list) {
				const st = new Store()
				try { list = st.listProposals({ limit: 30 }) } finally { st.close() }
			}
			for (const p of list) console.log(`${p.pid} [${p.status}] (${p.kind}) ${p.title} — ${p.summary}`)
			if (!list.length) console.log('제안 없음')
			return
		}
		if (sub === 'show' && pid) {
			const st = new Store()
			try {
				const p = st.getProposal(pid)
				console.log(p ? JSON.stringify(p, null, 2) : `찾지 못함: ${pid}`)
			} finally { st.close() }
			return
		}
		if (['approve', 'reject', 'rollback'].includes(sub) && pid) {
			// 데몬이 답했으면(거절·충돌·운영 모드 차단 포함) 그 답을 그대로 보여 준다. 데몬에 닿지 못했을 때만 직접 처리한다.
			const ipc = await assistIpc(cfg, 'POST', `/api/proposals/${encodeURIComponent(pid)}/${sub}`).catch(e => (e.body ? { ...e.body, http_status: e.status } : null))
			if (ipc) return console.log(JSON.stringify(ipc, null, 2))
			const st = new Store()
			try {
				if (sub === 'reject') {
					const adm = new HaAdmin({ cfg, store: st, memory: new MemoryManager({ store: st }) })
					return console.log(JSON.stringify(adm.rejectProposal(pid), null, 2))
				}
				// 데몬 없이 직접 처리할 때도 운영 모드를 따른다. CLI에서 직접 실행한 롤백만 일시정지·시험 모드에서 허용한다.
				// 감시 규칙 승격의 롤백은 규칙을 되살릴 데몬이 있어야 해서 여기서는 거절된다.
				const res = await withLiveHa(cfg, async (ha, states) => {
					const adm = new HaAdmin({ cfg, ha, store: st, states, memory: new MemoryManager({ store: st }), readControl: loadControl })
					return sub === 'approve' ? adm.approveProposal(pid) : adm.rollbackProposal(pid, Date.now(), { explicit: true })
				})
				console.log(JSON.stringify(res, null, 2))
			} finally { st.close() }
			return
		}
		console.log('쓰는 법: proposals [list|show <pid>|approve <pid>|reject <pid>|rollback <pid>]')
	},
	async audit() {
		const cfg = loadConfig()
		const ipc = await assistIpc(cfg, 'POST', '/api/audit').catch(() => null)
		if (ipc) return console.log(JSON.stringify(ipc, null, 2))
		const res = await withLiveHa(cfg, async (ha, states) => {
			const autoCfg = {}
			for (const id of states.keys()) {
				if (!id.startsWith('automation.')) continue
				try { autoCfg[id] = (await ha.call({ type: 'automation/config', entity_id: id }))?.config } catch {}
			}
			const adm = new HaAdmin({ cfg, ha, states, meta: { autoCfg } })
			return adm.auditHealth()
		})
		console.log(JSON.stringify(res, null, 2))
	},
	async traces() {
		const cfg = loadConfig(), target = rest[0] ?? null
		const rows = await withLiveHa(cfg, async ha => {
			let itemId = null
			if (target) itemId = (await ha.call({ type: 'automation/config', entity_id: target }))?.config?.id ?? target.replace(/^automation\./, '')
			return ha.traces('automation', itemId ? String(itemId) : null)
		})
		for (const t of (rows ?? []).slice(0, 20)) {
			console.log(`${t.timestamp?.start ?? ''} [${t.state}/${t.script_execution}] ${t.item_id} (${t.run_id}) step=${t.last_step ?? '-'}${t.error ? ` err=${t.error}` : ''}`)
		}
	},
	async assist() {
		if (!rest.length) return console.log('쓰는 법: assist <집 비서에게 할 말>')
		const cfg = loadConfig()
		const sessPath = join(P.state, 'cli-assist-session.txt')
		const text = rest.join(' ')
		const convId = existsSync(sessPath) ? readFileSync(sessPath, 'utf8').trim() : null
		try {
			const r = await assistIpc(cfg, 'POST', '/api/assist/converse', { text, conversation_id: convId || undefined, channel: 'cli_assist' })
			if (!r) return console.log('Assist 서버가 꺼져 있거나 데몬이 실행 중이 아니에요. (say 명령을 쓰세요)')
			if (r.conversation_id) writeFileSync(sessPath, r.conversation_id)
			console.log(r.response?.speech ?? JSON.stringify(r))
		} catch (e) { console.log(`Assist 오류: ${e.message}`) }
	},
	async weekly() {
		const { listWeekly, readWeekly } = await import('./records.mjs')
		const arg = rest[0]
		if (arg === 'run') {
			toInbox({ cmd: 'weekly' })
			return console.log(daemonPid() ? '주간 분석을 요청했어요. 몇 분 걸리고, 끝나면 알림이 가요.' : '데몬이 꺼져 있어 요청만 넣어 두었어요.')
		}
		if (arg === 'publish') {
			if (!readWeekly()) return console.log('올릴 보고서가 아직 없어요.')
			toInbox({ cmd: 'weekly-publish' })
			return console.log(daemonPid() ? '가장 최근 보고서를 HA 앱의 알림(🔔)에 올리도록 요청했어요.' : '데몬이 꺼져 있어 요청만 넣어 두었어요.')
		}
		if (arg === 'list') {
			const names = listWeekly()
			for (const n of names) console.log(n.replace('.md', ''))
			if (!names.length) console.log('보고서 없음')
			return
		}
		const r = arg ? readWeekly(`${arg}.md`) : readWeekly()
		const w = loadConfig().weekly
		console.log(r ? r.text : arg ? `그 날짜의 보고서가 없어요: ${arg}. 'weekly list'로 확인하세요.` : `아직 보고서가 없어요. ${w.enabled ? `매주 ${w.weekday}요일 ${w.hour}시에 분석합니다.` : '주간 분석이 꺼져 있어요(config.json의 weekly.enabled).'} 지금 하려면 'weekly run'.`)
	},
	async wake() {
		const cfg = loadConfig(), reason = rest.join(' ') || '수동 점검'
		const ipc = await assistIpc(cfg, 'POST', '/api/wake', { reason }).catch(() => null)
		if (ipc?.ok) return console.log('깨움 요청을 즉시 전달했어요.')
		toInbox({ cmd: 'wake', reason })
		console.log(daemonPid() ? '깨움 요청을 넣었어요. 15초 안에 판단을 시작합니다.' : '데몬이 꺼져 있어 요청만 넣어 두었어요.')
	},
	async say() {
		if (!rest.length) return console.log('쓰는 법: say <집 비서에게 할 말>')
		const cfg = loadConfig(), text = rest.join(' ')
		const ipc = await assistIpc(cfg, 'POST', '/api/say', { text }).catch(() => null)
		if (ipc?.speech) return console.log(ipc.speech)
		toInbox({ cmd: 'say', text })
		console.log(daemonPid() ? '말을 전했어요. 15초 안에 판단을 시작합니다.' : '데몬이 꺼져 있어 말만 넣어 두었어요.')
	},
	brain() {
		const cfg = loadConfig(), c = loadControl(), wantRaw = rest[0], want = wantRaw ? normalizeMode(wantRaw) : null
		if (!wantRaw) {
			console.log(brainLine(cfg, c))
			for (const m of MODES) console.log(`  ${m} (${MODE_DESC[m]}): ${selfCheck(cfg, m) ?? '쓸 수 있음'}`)
			return console.log(`바꾸기: node src/cli.mjs brain ${MODES.join('|')}  (config.json 값으로 되돌리기: brain default)`)
		}
		if (wantRaw === 'default') {
			const { brain, ...keep } = c
			saveControl(keep)
			return console.log(`config.json 값으로 되돌렸어요.\n${brainLine(cfg, keep)}`)
		}
		if (!MODES.includes(want)) return console.log(`쓰는 법: brain [${MODES.join('|')}|default]`)
		const problem = selfCheck(cfg, want)
		if (problem) return console.log(`바꾸지 않았어요. ${want} 방식을 쓸 수 없어요: ${problem}`)
		const next = { ...c, brain: want }
		saveControl(next)
		console.log(`${brainLine(cfg, next)}\n${daemonPid() ? '다음 판단부터 이 방식으로 묻습니다(재시작 필요 없음).' : '데몬이 꺼져 있어요. 켜지면 이 방식으로 묻습니다.'}`)
		if (want === 'api' || want === 'gemini') console.log(`${MODE_LABEL[want]} 방식은 쓴 토큰만큼 요금이 나가요. 쓴 양은 \`log\`의 토큰으로 봅니다.`)
	},
	pause() { saveControl({ ...loadControl(), paused: true }); console.log('일시정지: 규칙 감시는 계속하지만 AI 판단·알림·행동을 멈춥니다.') },
	resume() { saveControl({ ...loadControl(), paused: false }); console.log('다시 동작합니다.') },
	'send-on'() { saveControl({ ...loadControl(), send: true }); console.log('알림 발송을 켰어요.') },
	'send-off'() { saveControl({ ...loadControl(), send: false }); console.log('알림 발송을 껐어요(시험 모드: 알림·행동을 기록만 남김).') },
	async history() {
		const { listSnapshots } = await import('./records.mjs')
		const names = listSnapshots()
		for (const n of names) console.log(n)
		console.log(names.length ? '\n되돌리기: node src/cli.mjs restore <파일 이름>' : '이전 판 없음 (규칙·메모가 바뀔 때마다 직전 판이 state/history/에 남습니다)')
	},
	async restore() {
		const { readSnapshot } = await import('./records.mjs')
		try { readSnapshot(rest[0] ?? '') } catch (e) { return console.log(`되돌릴 수 없어요: ${e.message}. 'history'로 파일 이름을 확인하세요.`) }
		toInbox({ cmd: 'restore', file: rest[0] })
		console.log(daemonPid() ? '되돌리기 요청을 넣었어요. 지금 판은 state/history/에 남습니다.' : '데몬이 꺼져 있어 요청만 넣어 두었어요.')
	},
	async 'oob-test'() {
		const { sendOob } = await import('./oob.mjs')
		try {
			const sent = await sendOob(loadConfig(), '집 비서 비상 알림 시험', 'HA가 끊겼을 때 이 길로 알려 드려요.', { urgent: false })
			console.log(sent ? '보냈어요.' : 'config.json의 oob.type이 비어 있어요(꺼짐).')
		} catch (e) { console.log(`실패: ${e.message}`) }
	},
	async runs() {
		const { listRuns } = await import('./records.mjs')
		for (const n of listRuns().slice(-(Number(rest[0]) || 20))) console.log(n)
	},
	async replay() {
		const { listRuns } = await import('./records.mjs')
		const { buildPrompt } = await import('./context.mjs')
		const { runBrain, validateResponse } = await import('./brain.mjs')
		const reqMode = rest[1] ? normalizeMode(rest[1]) : null
		if (reqMode && !MODES.includes(reqMode)) return console.log(`쓰는 법: replay [이름|latest] [${MODES.join('|')}]`)
		const name = !rest[0] || rest[0] === 'latest' ? listRuns().at(-1) : rest[0]
		const dir = join(P.runs, name ?? '')
		if (!name || !existsSync(join(dir, 'input.json'))) return console.log(`보관된 판단이 없어요: ${rest[0] ?? '(없음)'}. 'runs'로 이름을 확인하세요.`)
		const cfg = loadConfig()
		const mode = reqMode ?? brainMode(cfg, loadControl()), bs = brainSettings(cfg, mode)
		const problem = selfCheck(cfg, mode)
		if (problem) return console.log(`${mode} 방식을 쓸 수 없어요: ${problem}`)
		rmSync(P.replay, { recursive: true, force: true })
		mkdirSync(join(P.replay, 'run'), { recursive: true })
		if (existsSync(join(dir, 'files'))) cpSync(join(dir, 'files'), join(P.replay, 'run'), { recursive: true })
		const replayAutoCfg = join(P.replay, 'run', 'automation-configs.json')
		if (!existsSync(replayAutoCfg) && existsSync(join(P.run, 'automation-configs.json'))) {
			copyFileSync(join(P.run, 'automation-configs.json'), replayAutoCfg)
		}
		let input = readJson(join(dir, 'input.json'), null)
		if (typeof input === 'string') input = JSON.parse(input)
		const weekly = input.reasons.some(r => r.type === 'weekly')
		const deep = weekly || input.reasons.some(r => r.type === 'bootstrap' || r.type === 'reflection')
		const pureHourly = !deep && input.reasons.length === 1 && input.reasons[0].type === 'hourly'
		const prompt = buildPrompt({ ...input, guide: readFileSync(P.guide, 'utf8'), infoFiles: [], lastRound: true })
		console.log(`다시 묻는 중: ${name} (${MODE_LABEL[mode]} ${bs.model}, 지금의 GUIDE.md, 추가 자료 요청 없이 한 번)`)
		const r = await runBrain({ cfg, mode, prompt, model: bs.model, effort: deep ? bs.effort_deep : pureHourly ? bs.effort_hourly : bs.effort, timeoutSec: weekly ? cfg.weekly.timeout_seconds : deep ? bs.timeout_deep_seconds : bs.timeout_seconds, brainDir: P.replay, runDir: join(P.replay, 'run') })
		let last = 1
		while (existsSync(join(dir, `answer-${last + 1}.json`))) last++
		const old = readJson(join(dir, `answer-${last}.json`), null)
		console.log('── 그때의 답 ──')
		console.log(JSON.stringify(old && validateResponse(old), null, 1))
		console.log(`── 지금의 답 (${MODE_LABEL[mode]}, ${Math.round(r.ms / 1000)}초, 토큰 ${r.tokens ?? '?'}${r.tool_calls != null ? `, 파일 도구 ${r.tool_calls}번` : ''}) ──`)
		console.log(JSON.stringify(validateResponse(r.result), null, 1))
	},
	async doctor() {
		const cfg = loadConfig(), c = loadControl(), rt = readJson(P.runtime, {})
		let errors = 0, warnings = 0
		const ok = msg => console.log(`[OK]   ${msg}`)
		const warn = msg => { warnings++; console.log(`[WARN] ${msg}`) }
		const fail = msg => { errors++; console.log(`[FAIL] ${msg}`) }

		const pid = daemonPid()
		if (pid) ok(`데몬 실행 중 (pid ${pid}, ${c.paused ? '일시정지' : '동작'}, 알림 ${c.send ? '켜짐' : '꺼짐'})`)
		else warn('데몬이 꺼져 있음')

		const cfgRes = validateConfig(cfg)
		if (!cfgRes.errors.length && !cfgRes.warnings.length) ok('config.json 설정 유효')
		for (const e of cfgRes.errors) fail(`설정: ${e}`)
		for (const w of cfgRes.warnings) warn(`설정: ${w}`)

		const mode = brainMode(cfg, c)
		const mainChk = selfCheck(cfg, mode)
		if (mainChk) fail(`주 판단 방식(${mode}): ${mainChk}`)
		else ok(`주 판단 방식(${mode}): 사용 가능 (모델 ${brainSettings(cfg, mode).model})`)
		for (const m of MODES) {
			if (m === mode) continue
			const chk = selfCheck(cfg, m)
			if (chk) warn(`보조 판단 방식(${m}): ${chk}`)
			else ok(`보조 판단 방식(${m}): 사용 가능 (모델 ${brainSettings(cfg, m).model})`)
		}

		const checkPerm = (label, filePath, required = false) => {
			if (!filePath) return
			const p = expandHome(filePath)
			if (!existsSync(p)) return required ? fail(`${label} 파일 없음: ${filePath}`) : null
			const modeBits = statSync(p).mode & 0o777
			if (modeBits & 0o077) warn(`${label} 권한 과다 (${modeBits.toString(8)}): chmod 600 ${filePath} 권장`)
			else ok(`${label} 권한 안전 (${modeBits.toString(8)})`)
		}
		checkPerm('HA 토큰', cfg.token_file, true)
		checkPerm('.env', join(ROOT, '.env'), false)
		checkPerm('OpenAI API 키 파일', cfg.api.key_file, false)
		checkPerm('Gemini API 키 파일', cfg.gemini?.key_file ?? cfg.llm?.gemini?.key_file, false)
		checkPerm('OOB 토큰 파일', cfg.oob.token_file, false)
		checkPerm('OOB env 파일', cfg.oob.env_file, false)
		if (cfg.assist?.enabled) checkPerm('Assist 토큰 파일', cfg.assist.token_file, false)

		if (existsSync(P.homeProfile)) ok('집 프로필(state/home-profile.md) 존재')
		else warn('집 프로필(state/home-profile.md) 없음')

		if (existsSync(P.db)) {
			try {
				const st = new Store()
				const s = st.stats()
				const memMgr = new MemoryManager({ store: st, cfg })
				const embStats = memMgr.embeddingStats()
				st.close()
				const dbSizeMb = (statSync(P.db).size / (1024 * 1024)).toFixed(2)
				const walPath = `${P.db}-wal`
				const walBytes = existsSync(walPath) ? statSync(walPath).size : 0
				const walMb = (walBytes / (1024 * 1024)).toFixed(2)
				ok(`SQLite DB 정상 (이벤트 ${s.events}, 기억 ${s.memory_items}[고정 ${s.memory_pinned ?? 0}], 교훈 ${s.lessons ?? 0}, 실험 ${s.experiments_active ?? 0}, 롤업 ${s.daily_rollups ?? 0}일/${s.monthly_rollups ?? 0}월, 제안 대기 ${s.proposals_pending}, DB ${dbSizeMb}MB, WAL ${walMb}MB)`)
				if (embStats.enabled) {
					try {
						geminiKey(cfg)
						if (embStats.active_total > 0 && embStats.active_matching < embStats.active_total) {
							warn(`기억 임베딩(${embStats.target_model}/${embStats.target_dims}d): ${embStats.active_matching}/${embStats.active_total}건 색인됨 — 'node src/cli.mjs memory reindex' 실행 권장`)
						} else {
							ok(`기억 임베딩 정상 (${embStats.target_model}/${embStats.target_dims}d, ${embStats.active_matching}/${embStats.active_total}건)`)
						}
					} catch (e) {
						warn(`기억 임베딩(${embStats.target_model}): Gemini API 키 없음 (${e.message}) — 로컬 폴백 사용 중`)
					}
				} else {
					ok('기억 임베딩: 로컬(local) 모드')
				}
				if (walBytes > 10 * 1024 * 1024) warn(`SQLite WAL 파일이 큼 (${walMb}MB): 체크포인트 권장`)
			} catch (e) { fail(`SQLite DB 오류: ${e.message}`) }
		} else warn('SQLite DB 미생성 (데몬 시작 시 자동 생성)')

		const pol = new PolicyEngine(cfg).describe()
		ok(`Risk 정책: ${pol.enabled ? `Tier1 ${pol.tier1_auto.length}개 / Tier2 ${pol.tier2_confirm.length}개` : '꺼짐'}, HA 관리=${pol.admin_enabled ? '켜짐' : '꺼짐'}`)

		const baks = []
		for (const dir of [ROOT, join(ROOT, 'src'), join(ROOT, 'test'), P.brain]) {
			try {
				for (const f of readdirSync(dir)) if (/\.bak($|-)/.test(f)) baks.push(join(dir, f).replace(ROOT + '/', ''))
			} catch {}
		}
		if (baks.length) warn(`잔여 백업 파일 ${baks.length}개: ${baks.join(', ')}`)
		else ok('잔여 백업 파일 없음')

		const checkOobEntry = (entry, label, isFallback = false) => {
			const rep = isFallback ? warn : fail
			if (entry.type === 'slack') {
				const sErr = checkOobSlackConfig({ oob: entry })
				if (sErr) rep(`${label}(slack): ${sErr}`)
				else ok(`${label}(slack): 토큰·채널 설정 확인됨`)
			} else if (entry.type === 'kakao') {
				const kErr = checkOobKakaoConfig({ oob: entry })
				if (kErr) rep(`${label}(kakao): ${kErr}`)
				else ok(`${label}(kakao): 토큰·수신자(${entry.recipient_name || entry.recipient_uuid || entry.mode || 'memo'}) 설정 확인됨`)
			} else if (entry.type) {
				ok(`${label}(oob): ${entry.type} 설정됨`)
			}
		}
		if (cfg.oob?.type) {
			checkOobEntry(cfg.oob, '비상 알림 길', false)
			if (cfg.oob.fallback?.type) checkOobEntry(cfg.oob.fallback, '대체 비상 알림 길', true)
		} else warn('비상 알림 길(oob) 꺼짐 (HA 단절 시 외부 알림 없음)')

			if (cfg.assist?.enabled) {
				const aHost = cfg.assist.host
				if ((!aHost || aHost === '0.0.0.0' || aHost === '::') && !(Array.isArray(cfg.assist.allowed_networks) && cfg.assist.allowed_networks.length)) {
					warn('Assist 서버가 0.0.0.0에 열려 있고 allowed_networks 제한이 없음')
				}
				try {
					const hr = await fetch(`http://127.0.0.1:${cfg.assist.port}/health`, { signal: AbortSignal.timeout(3000) })
					if (hr.ok) ok(`Assist HTTP 서버 정상 (포트 ${cfg.assist.port})`)
					else fail(`Assist HTTP 서버 비정상 응답 (${hr.status})`)
				} catch (e) {
					if (pid) fail(`Assist HTTP 서버 연결 실패: ${e.message}`)
					else warn(`Assist HTTP 서버 대기 중 (데몬 꺼짐, 포트 ${cfg.assist.port})`)
				}
				const assistProv = normalizeMode(cfg.llm?.routes?.assist ?? mode)
				const assistBs = ['codex', 'api', 'agy', 'gemini'].includes(assistProv) ? brainSettings(cfg, assistProv) : { model: cfg.llm?.[assistProv]?.model ?? null, effort: null }
				const assistMdl = cfg.assist?.model ?? assistBs.model
				const assistEff = cfg.assist?.effort ?? assistBs.effort
				ok(`Assist 대화 AI: ${assistProv} (${assistMdl}${assistEff ? `, 노력 ${assistEff}` : ''})`)
				if (cfg.assist?.voice?.provider === 'gemini') {
					const v = cfg.assist.voice
					try {
						geminiKey(cfg)
						ok(`Assist 음성(Gemini Interactions API): STT ${v.stt_model} / TTS ${v.tts_model} (${v.tts_voice})`)
					} catch (e) {
						warn(`Assist 음성(Gemini): API 키 없음 (${e.message})`)
					}
				}
			} else warn('Assist HTTP 서버 꺼짐 (config.json assist.enabled=false)')

		if (cfg.heartbeat?.enabled) {
			const beatAgeMin = rt.last_beat_ok ? Math.round((Date.now() - rt.last_beat_ok) / 60000) : null
			if (beatAgeMin == null) warn('heartbeat 전달 기록 없음')
			else if (beatAgeMin > cfg.heartbeat.alert_minutes) warn(`마지막 heartbeat ${beatAgeMin}분 전 (임계 ${cfg.heartbeat.alert_minutes}분 초과)`)
			else ok(`heartbeat 정상 (${beatAgeMin}분 전)`)
		}

		const autos = readJson(join(P.run, 'automations.json'), null)
		if (Array.isArray(autos)) {
			const hb = autos.find(a => (a.watches ?? []).includes('haagent_heartbeat') || a.id === 'automation.jib_biseo_eungdab_eobseum_gyeonggo')
			if (!hb) warn('HA에 heartbeat 응답 없음 경고 자동화 미설치 (ha/heartbeat-automation.yaml 참고)')
			else if (hb.state !== 'on') warn(`HA heartbeat 자동화 꺼짐 (${hb.id})`)
			else ok(`HA heartbeat 자동화 활성 (${hb.id})`)
		}
		const states = readJson(join(P.run, 'states.json'), null)
		if (Array.isArray(states)) {
			const hasSensors = states.some(s => /jib_biseo_yeongyeol|jib_biseo_sangtae|haagent_alive|haagent_status/i.test(s.id))
			if (hasSensors) ok('HA 상태 센서(status-sensors.yaml) 적용됨')
			else warn('HA 상태 센서(ha/status-sensors.yaml) 미적용 — 대시보드 표시·경량 heartbeat 전환 권장')
		}
		console.log(`점검 요약: 오류 ${errors}건, 주의 ${warnings}건`)
		if (errors) process.exitCode = 1
	},
	stats() {
		const days = Math.max(1, Number(rest[0]) || 7)
		const st = existsSync(P.db) ? new Store() : null
		let s
		try { s = rangeStats(days, Date.now(), { store: st }) } finally { st?.close() }
		console.log(`=== 최근 ${s.days}일 통계 ===`)
		console.log(`판단: 전체 ${s.total}회 (실행 ${s.real}, 건너뜀 ${s.skipped}, 미룸 ${s.deferred}, 실패 ${s.errors})`)
		console.log(`빈 호출(알림·행동·규칙변경 없음): ${s.noop}회 (${s.noop_pct}%)`)
		console.log(`토큰: 합계 ${s.tokens.toLocaleString()} (성공 회당 평균 ${s.avg_tokens.toLocaleString()})`)
		if (s.usage) console.log(`세부 토큰(API): 입력 ${s.usage.input.toLocaleString()}, 캐시 ${s.usage.cached.toLocaleString()}, 출력 ${s.usage.output.toLocaleString()}, 추론 ${s.usage.reasoning.toLocaleString()}`)
		const brains = Object.entries(s.by_brain).map(([k, v]) => `${k} ${v.runs}회(${v.tokens.toLocaleString()}tok${v.errors ? `, 실패 ${v.errors}` : ''})`)
		if (brains.length) console.log(`방식별: ${brains.join(' | ')}`)
		const reasons = Object.entries(s.by_reason).sort((a, b) => b[1].runs - a[1].runs)
		if (reasons.length) {
			console.log('이유별:')
			for (const [k, v] of reasons) console.log(`  - ${k}: ${v.runs}회 (빈 호출 ${v.noop}회, 토큰 ${v.tokens.toLocaleString()})`)
		}
		console.log(`알림: 경고 ${s.notifications.sent_alerts}, 정보 ${s.notifications.sent_infos}, 요약 ${s.notifications.sent_summaries}, 미발송·기타 ${s.notifications.other}`)
		console.log(`피드백: 도움됐어요 ${s.feedback.up}, 그만 ${s.feedback.mute}, 줄여 줘 ${s.feedback.less}, 답장 ${s.feedback.reply}`)
		console.log(`행동: 실행 ${s.actions.done}, 거절 ${s.actions.declined}, 되돌림 ${s.actions.undone}, 실패 ${s.actions.error}`)
		const rules = readJson(P.rules, null)?.rules ?? [], rt = readJson(P.runtime, { rules: {} }).rules ?? {}, now = Date.now()
		const fired = rules.map(r => [r.id, recentFires(rt[r.id], now).length]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
		if (fired.length) console.log(`규칙 7일 발동: ${fired.map(([id, n]) => `${id}(${n}회)`).join(', ')}`)
	},
	// Assist 모델 비교: node src/cli.mjs bench-assist [provider:model[:effort] ...] [--repeat N] [--case "말" ...]
	// 실제 HA 상태·프롬프트·도구로 돌리지만 기기는 움직이지 않는다(제어는 정책 판정만 하고 성공으로 흉내).
	async 'bench-assist'() {
		const { benchAssist, DEFAULT_MODELS, DEFAULT_CASES } = await import('./bench-assist.mjs')
		const models = [], texts = []
		let repeat = 1, includeLearned = false
		for (let i = 0; i < rest.length; i++) {
			if (rest[i] === '--repeat') repeat = Math.max(1, Number(rest[++i]) || 1)
			else if (rest[i] === '--learned') includeLearned = true
			else if (rest[i] === '--case') texts.push(rest[++i])
			else models.push(rest[i])
		}
		const cases = texts.length ? texts.map(t => DEFAULT_CASES.find(c => c.text === t) ?? { text: t, expect: null }) : DEFAULT_CASES
		await benchAssist({ cfg: loadConfig(), models: models.length ? models : DEFAULT_MODELS, cases, includeLearned, repeat })
		process.exit(0)
	},
	async once() {
		if (daemonPid()) { console.log('데몬이 실행 중이라 once는 쓰지 않아요. wake를 쓰세요.'); return }
		const { Agent } = await import('./agent.mjs')
		const a = new Agent({ dry: true })
		a.start()
		await a.waitReady()
		const type = rest[0] ?? 'manual'
		const e = await a.cycle([{ type, reason: rest.slice(1).join(' ') || '시험 판단', text: rest.slice(1).join(' '), hour: kst().h }])
		console.log(JSON.stringify(e, null, 1))
		a.stop()
		process.exit(0)
	},
}

if (!cmds[cmd]) {
	console.log('명령: status | policy | rules | log [n] | notes [YYYY-MM-DD] | actions [n] | memory [list|search|add|rm|pin|unpin|history|restore|consolidate] | learning | routines [일수] | experiments [eval] | evals | scorecard [주수] [--json] | suggest-automations [apply] | health | regression | daily-learning | self-tune [propose] | proposals [list|show|approve|reject|rollback] | audit | traces [id] | assist <말> | stats [일수] | doctor | weekly [list|run|publish|YYYY-MM-DD] | wake [이유] | say <말> | brain [codex|api|agy|gemini|default] | pause | resume | send-on | send-off | history | restore <파일> | runs [n] | replay [이름|latest] [codex|api|agy|gemini] | oob-test | once [bootstrap|hourly|weekly|manual] [이유] | bench-assist [provider:model[:effort] ...] [--repeat N] [--learned] [--case 말]')
	process.exit(cmd ? 1 : 0)
}
await cmds[cmd]()
