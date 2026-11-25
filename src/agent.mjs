// 집 비서 본체: HA 실시간 감시(규칙·이상탐지), Assist 대화 서버, PolicyEngine, ToolBroker, HaAdmin, LLM 라우터를 통합 조율한다.
import { readdirSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { HA } from './ha.mjs'
import { RuleEngine, validateRule } from './rules.mjs'
import { compactStates, automationList, notableChange, significantChange, buildPrompt } from './context.mjs'
import { runBrain, brainMode, brainSettings, validateResponse, selfCheck, normalizeMode, MODES, MODE_LABEL } from './brain.mjs'
import { feedbackPayload, proposalApprovalPayload, proposalResultPayload, experimentRegressedPayload, ACTION_RE, REPLY_ACTION, TAG_PREFIX } from './notify.mjs'
import { PolicyEngine } from './core/policy.mjs'
import { Store } from './core/store.mjs'
import { Journal } from './core/journal.mjs'
import { MemoryManager } from './core/memory.mjs'
import { AnomalyEngine } from './engine/anomaly.mjs'
import { ImplicitFeedbackTracker, buildLearningDigest, registerExperiment, evaluateDueExperiments, proposalExperimentScope } from './engine/learning.mjs'
import { HaAdmin } from './admin/ha-admin.mjs'
import { OriginTracker } from './engine/origin.mjs'
import { suggestAutomations } from './engine/automation-suggest.mjs'
import { buildScorecard, renderScorecard } from './engine/scorecard.mjs'
import { scanDeviceHealth, healthIssueKeys, newHealthIssues } from './engine/device-health.mjs'
import { fastPathCases, runFastPathRegression, directoryIndexFor } from './engine/regression.mjs'
import { ToolBroker } from './tools/registry.mjs'
import { digestHaData } from './tools/read.mjs'
import { SessionManager } from './orchestrator/session.mjs'
import { LlmRouter } from './llm/router.mjs'
import { AssistServer } from './channels/assist-server.mjs'
import { transcribeGemini, synthesizeGemini } from './voice/gemini-voice.mjs'
import { sendOob } from './oob.mjs'
import { archiveRun, snapshot, readSnapshot, writeDaily, recentDaily, weekMetrics, rotateLogs, saveWeekly, readWeekly } from './records.mjs'
import { automationRuns, deviceActivity, DEVICE_DOMAINS, WEEKLY_HOURS } from './weekly.mjs'
import { backtestRule, backtestable } from './backtest.mjs'
import { Notifier } from './agent/notifier.mjs'
import { ActionExecutor } from './agent/action-executor.mjs'
import { AssistHandler } from './agent/assist-handler.mjs'
import { P, DAY, readJson, writeJson, kst, fmt, log, expandHome, globs } from './util.mjs'
import { loadConfig, loadControl } from './config.mjs'

const MIN = 60000
const iso = ms => new Date(ms).toISOString()
// HA 연결이 끊겨서 난 오류(src/ha.mjs가 끊길 때 대기 중인 호출을 이 이유로 거절한다). 자료를 다 못 받은 판단은 다시 연결된 뒤로 미룬다.
const CONN_ERR = /^(HA 연결 없음|응답 없음|연결 (끊김|실패|오류|시간 초과)|초기화 실패|인증 실패)/
const MAX_DEFERS = 3
const sysKey = x => `${x.level ?? ''}|${x.name ?? ''}|${x.message ?? ''}`
const repairKey = r => `${r.domain ?? ''}:${r.id ?? ''}`
export const PUBLISH_SERVICE = 'persistent_notification.create'
const canonical = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x))
const cfgHash = c => createHash('sha1').update(canonical(c)).digest('hex').slice(0, 16)
const triggerTimes = c => [].concat(c?.triggers ?? c?.trigger ?? []).map(t => t?.at).filter(Boolean).flat().map(String)

// 주간 보고서의 "새 자동화 제안" 절에 YAML 초안이 있는가(그렇다면 proposals로도 내야 바로 승인할 수 있다)
export function reportHasAutomationDraft(report) {
	const m = /##\s*새 자동화 제안([\s\S]*?)(?=\n##\s|$)/.exec(String(report ?? ''))
	return Boolean(m && /```ya?ml|^\s*(triggers?|actions?):/m.test(m[1]))
}

// 사용자가 자동화를 직접 고쳤을 때 무엇이 바뀌었는지 사람이 읽을 요약
export function automationChangeSummary(prev, next) {
	if (!prev || !next) return []
	const out = []
	const label = { alias: '이름', description: '설명', mode: '실행 방식', triggers: '트리거', trigger: '트리거', conditions: '조건', condition: '조건', actions: '동작', action: '동작' }
	for (const k of Object.keys(label)) if (canonical(prev[k]) !== canonical(next[k]) && !out.includes(label[k])) out.push(label[k])
	const a = triggerTimes(prev).join(','), b = triggerTimes(next).join(',')
	if (a !== b && (a || b)) out.push(`시각 ${a || '없음'}→${b || '없음'}`)
	return out
}

export class Agent {
	// ha·brain·oob·clock·canUse는 시험에서 가짜로 바꿔 끼운다.
	// assistControl: Assist 대화의 기기 제어를 대신할 함수(벤치마크·시험용). 없으면 실제 정책 게이트·실행 경로를 쓴다.
	constructor({ dry = false, cfg, ha, brain, oob, clock, beat, canUse, sttFn, ttsFn, assistControl } = {}) {
		this.cfg = cfg ?? loadConfig()
		this.control = loadControl()
		this.dry = dry
		this.clock = clock ?? Date.now
		this.brain = brain ?? runBrain
		this.oob = oob ?? sendOob
		this.beat = beat ?? (() => {})
		this.canUse = canUse ?? ((c, mode) => !selfCheck(c, mode))
		this.sttFn = sttFn ?? transcribeGemini
		this.ttsFn = ttsFn ?? synthesizeGemini
		this.ttsCache = new Map()
		this.assistControl = assistControl ?? null
		this.assistWarned = new Set()
		this.isNoise = globs(this.cfg.noise_entities)
		this.policy = new PolicyEngine(this.cfg)
		this.tiers = this.policy.tiersMap()
		this.store = dry ? null : new Store()
		if (this.store) {
			try { this.store.migrateFromLegacyFiles() } catch (e) { log('DB 초기 이관 경고:', e.message) }
		}
		// 알림·피드백·행동·상태 변화 기록의 원본은 SQLite. JSONL은 내보내기.
		this.journal = new Journal({ store: this.store })
		this.ha = ha ?? new HA({
			url: this.cfg.ha_ws_url, tokenFile: expandHome(this.cfg.token_file), notifyTargets: this.cfg.notify_targets,
			actionEntities: [...this.tiers.keys()],
			services: this.cfg.weekly.publish ? [PUBLISH_SERVICE] : [],
			policy: this.policy,
		})
		this.states = new Map()
		const initEvents = dry ? [] : this.journal.recentEvents({ limit: 5000 })
		this.ring = initEvents.filter(c => !this.isNoise(c.id)).slice(-300)
		this.noiseRing = initEvents.filter(c => this.isNoise(c.id)).slice(-300)
		this.rulesDoc = readJson(P.rules, null)
		this.runtime = readJson(P.runtime, { rules: {}, last_checkin: null })
		this.runtime.rules ??= {}
		this.engine = new RuleEngine(this.rulesDoc?.rules ?? [], this.runtime.rules)
		this.schedule = readJson(P.schedule, [])
		this.held = readJson(P.held, [])
		this.counters = readJson(P.counters, null)
		this.outbox = dry ? [] : readJson(P.outbox, [])
		this.pendingActs = dry ? [] : this.journal.pendingActions()
		const saved = dry ? {} : readJson(P.queue, {})
		this.queue = [...(saved.inflight ?? []).map(r => ({ ...r, attempts: (r.attempts ?? 0) + 1 })), ...(saved.queue ?? [])]
			.filter(r => (r.attempts ?? 0) < this.#maxAttempts(r))
		this.inflight = []
		this.running = false
		this.runAbort = null
		this.actingAids = new Set()
		this.lastRunEnd = 0
		this.failures = 0
		this.failover = null
		this.lastFailedMode = null
		this.lastRun = dry ? null : this.journal.latestDecision({ excludeAssist: true, excludeSkipped: true, excludeDeferred: true })
		this.lastAssist = dry ? null : this.journal.latestDecision({ onlyAssist: true })
		this.preAt = new Map()
		this.meta = { at: 0, areaOf: null, catOf: null, autoCfg: null }
		this.lastBeat = 0
		this.lastRefresh = 0
		this.downSince = null
		this.downNotified = false
		this.startupProblem = null
		this.sessionLocks = new Map()
		this.cycleChain = Promise.resolve()
		// 상태 변화의 조작 주체(사람·기기·자동화·집 비서) 판별
		this.origin = new OriginTracker()
		this.dailyRunning = false

		this.memoryMgr = new MemoryManager({ store: this.store, cfg: this.cfg })
		this.anomaly = new AnomalyEngine({ store: this.store, isNoise: this.isNoise, awayOverrideEntity: this.cfg.away_override_entity })
		this.implicitFeedback = new ImplicitFeedbackTracker({ store: this.store })
		this.sessions = new SessionManager({ store: this.store })
		this.llmRouter = new LlmRouter({ cfg: this.cfg, brainFn: this.brain, canUse: this.canUse })
		this.haAdmin = new HaAdmin({
			cfg: this.cfg, ha: this.ha, store: this.store, states: this.states, meta: this.meta, memory: this.memoryMgr, policy: this.policy,
			onRulePromoted: async ruleId => this.#removePromotedRule(ruleId),
			// 롤백까지 실패하면 HA가 어떤 설정으로 돌고 있는지 모른다. HA 알림이 막혔을 수도 있으니 비상 길로도 알린다.
			onRollbackFailed: prop => {
				log(`제안 롤백 실패: ${prop.pid} ${prop.title} — ${prop.error}`)
				if (!this.dry) this.notifier.oobSend('🚨 집 비서: HA 설정 롤백 실패', `${prop.title}: ${prop.error}`.slice(0, 450))
			},
			onConfigUpdated: async merged => {
				this.cfg = merged
				this.isNoise = globs(this.cfg.noise_entities)
				this.anomaly.isNoise = this.isNoise
				this.llmRouter.cfg = merged
				this.memoryMgr.cfg = merged
			},
			onProposalOutcome: (prop, status, at, err) => {
				this.implicitFeedback.onProposalOutcome(prop, status, at, err)
				if (status === 'applied' && this.store && this.cfg.learning?.enabled !== false) {
					registerExperiment(this.store, {
						kind: `proposal:${prop.kind}`,
						ref_id: prop.pid,
						title: prop.title,
						scope: proposalExperimentScope(prop),
						evalDays: this.cfg.learning?.experiment_eval_days ?? 7,
						now: at,
					})
				}
			},
		})
		this.notifier = new Notifier(this)
		this.actionExecutor = new ActionExecutor(this)
		this.assist = new AssistHandler(this)
		this.toolBroker = new ToolBroker({
			ha: this.ha,
			states: this.states,
			get areaOf() { return this._agent.meta.areaOf },
			get autoCfg() { return this._agent.meta.autoCfg },
			_agent: this,
			memory: this.memoryMgr,
			haAdmin: this.haAdmin,
			executeControl: (req, opts) => this.actionExecutor.executeControlItem(req, opts),
			proposeAdmin: req => this.createAndNotifyProposal(req),
			handleProposalDecision: (pid, dec) => this.handleProposalAction(pid, dec),
			getWeather: entityId => this.getWeather(entityId),
			getCalendar: days => this.getCalendar(days),
			getRecentNotifications: (hours, limit) => this.getRecentNotifications(hours, limit),
		})
		this.assistServer = (!dry && this.cfg.assist?.enabled) ? new AssistServer({ cfg: this.cfg, agent: this }) : null
	}

	attach() {
		this.ha.on('ready', list => this.#onReady(list))
		this.ha.on('state', d => this.#onState(d))
		this.ha.on('action', d => this.#onAction(d).catch(e => log('버튼 처리 실패:', e.message)))
		this.ha.on('automation_triggered', (data, event) => this.origin.noteAutomationTriggered(event, this.clock()))
	}
	start() {
		this.attach()
		this.ha.start()
		if (this.assistServer) this.assistServer.start().catch(e => log('Assist 서버 시작 실패:', e.message))
		if (!this.dry && this.memoryMgr?.embeddingConfig().enabled) {
			this.memoryMgr.backfillEmbeddings()
				.then(r => { if (r.updated) log(`기억 임베딩 백필 완료 (${r.model}/${r.dims}d): ${r.updated}건 갱신`) })
				.catch(e => log('기억 임베딩 백필 실패:', e.message))
		}
		if (!this.dry) this.timer = setInterval(() => this.tick().catch(e => log('tick 오류:', e.stack)), 15000)
	}
	stop() {
		clearInterval(this.timer)
		this.runAbort?.abort(new Error('데몬 종료'))
		this.ha.stop()
		if (this.assistServer?.server) {
			return Promise.race([
				this.assistServer.stop().catch(() => {}),
				new Promise(r => setTimeout(r, 5000)),
			]).finally(() => this.store?.close())
		}
		this.store?.close()
		return Promise.resolve()
	}
	waitReady() { return new Promise(res => this.ha.once('ready', () => setImmediate(res))) }

	enqueueExternal(item) { this.#enqueue(item) }

	statusSummary() {
		const c = this.todayCounters()
		return {
			connected: this.ha.connected,
			paused: this.control.paused,
			send: this.control.send,
			brain: brainMode(this.cfg, this.control),
			entities: this.states.size,
			rules: this.engine.rules.length,
			rules_true: Object.values(this.runtime.rules).filter(r => r.fired).length,
			queue: this.queue.length,
			held: this.held.length,
			pending_actions: this.pendingActs.length,
			pending_proposals: this.haAdmin.listProposals({ status: 'pending' }).length,
			today: c,
			last_run: this.lastRun ? { ts: this.lastRun.ts, summary: this.lastRun.summary, error: this.lastRun.error ?? null } : null,
			last_assist: this.lastAssist ? { ts: this.lastAssist.ts, summary: this.lastAssist.summary, error: this.lastAssist.error ?? null } : null,
			db: this.store ? this.store.stats() : null,
		}
	}

	// ── HA 이벤트 ──
	#onReady(list) {
		this.states.clear()
		for (const s of list) this.states.set(s.entity_id, s)
		this.lastRefresh = this.clock()
		log(`HA 연결됨: 엔티티 ${list.length}개, 규칙 ${this.engine.rules.length}개`)
		if (this.dry) return
		if (this.cfg.assist?.enabled) this.refreshMeta(this.clock()).catch(e => log('Assist용 방 정보 준비 실패:', e.message))
		const fired = this.engine.initAll(this.states, this.clock())
		this.saveRuntime()
		this.#handleFired(fired)
		if (!this.rulesDoc && !this.queue.some(r => r.type === 'bootstrap')) this.#enqueue({ type: 'bootstrap' })
		if (this.startupProblem) {
			const message = `시작 점검에서 문제가 보여요: ${this.startupProblem}`.slice(0, 400)
			this.startupProblem = null
			this.notifier.deliver({ kind: 'info', level: 'normal', title: '🤖 집 비서 설정 문제', message, related_rule_ids: [] }).catch(e => log('알림 실패:', e.message))
		}
	}

	#onState(d) {
		const id = d.entity_id, n = d.new_state
		if (n) this.states.set(id, n)
		else this.states.delete(id)
		if (this.dry) return
		const now = this.clock()
		const c = notableChange(d)
		if (c) {
			const o = this.origin.classify(n, now)
			c.origin = o.origin
			if (o.actor && o.origin === 'automation') c.actor = o.actor
			const isNoise = this.isNoise(c.id)
			const bucket = isNoise ? this.noiseRing : this.ring
			bucket.push(c)
			if (bucket.length > 300) bucket.shift()
			// 기록이 실패해도(디스크·DB) 규칙 판정은 이어 간다.
			try { this.journal.event(c, isNoise) } catch (e) { this.#warnOnce('event', '상태 변화 기록 실패:', e) }
			try { this.implicitFeedback.onStateEvent(c, { now }) } catch {}
		}
		const fired = this.engine.onState(id, n, now, this.states)
		if (fired.length) { this.saveRuntime(); this.#handleFired(fired) }
	}

	// 같은 종류의 오류는 1분에 한 번만 남긴다(상태 변화마다 나는 오류가 로그를 덮지 않게).
	#warnOnce(key, msg, e) {
		const now = Date.now()
		this.warnAt ??= new Map()
		if (now - (this.warnAt.get(key) ?? 0) < 60000) return
		this.warnAt.set(key, now)
		log(msg, e?.message ?? e)
	}

	async #onAction(d) {
		if (this.dry) return
		const a = d?.action ?? ''
		if (a === REPLY_ACTION) return this.#onReply(d)
		const m = ACTION_RE.exec(a)
		if (!m) return
		const [, kind, nid] = m
		if (kind === 'DO' || kind === 'NO' || kind === 'UNDO') return this.actionExecutor.onActionButton(kind, nid)
		if (kind === 'APPR' || kind === 'REJ' || kind === 'ROLL') {
			const dec = kind === 'APPR' ? 'approve' : kind === 'REJ' ? 'reject' : 'rollback'
			await this.handleProposalAction(nid, dec)
			return
		}
		const rec = this.journal.findNotification({ nid })
		if (!rec) return log('버튼: 알림 기록을 찾지 못함', nid)
		const now = this.clock()
		const muted = []
		if (kind === 'MUTE') {
			for (const id of rec.related_rule_ids ?? []) if (this.engine.mute(id, now + this.cfg.limits.mute_days * DAY)) muted.push(id)
			this.saveRuntime()
		}
		if (!this.journal.hasFeedback(nid, kind.toLowerCase())) {
			const fbRec = { ts: iso(now), nid, kind: kind.toLowerCase(), title: rec.title, ...(kind === 'LESS' ? { message: String(rec.message ?? '').slice(0, 300) } : {}), rules: rec.related_rule_ids ?? [], muted }
			this.journal.feedback(fbRec)
		}
		log(`버튼 ${kind}: ${rec.title}${muted.length ? ` (규칙 쉼: ${muted.join(', ')})` : ''}`)
		const descs = muted.map(id => this.engine.rules.find(r => r.id === id)?.description).filter(Boolean)
		await this.notifier.send(feedbackPayload(rec, kind, descs, this.cfg.limits.mute_days))
	}

	async #onReply(d) {
		const text = String(d.reply_text ?? '').trim().slice(0, 500)
		const nid = d.action_data?.nid, tag = typeof d.tag === 'string' ? d.tag : null
		const rec = this.journal.findNotification({ nid, tag })
		if (!text || !(rec || tag?.startsWith(TAG_PREFIX))) return
		if (!this.dry) this.control = loadControl()
		if (this.control.paused) {
			log(`일시정지 중이라 답장을 처리하지 않음: "${text}"`)
			if (rec) await this.notifier.send(feedbackPayload(rec, 'PAUSED')).catch(() => {})
			return
		}
		const now = this.clock()
		const fbRec = { ts: iso(now), nid: rec?.nid ?? null, kind: 'reply', title: rec?.title ?? '', text, rules: rec?.related_rule_ids ?? [] }
		this.journal.feedback(fbRec)
		log(`답장: "${text}"${rec ? ` ← ${rec.title}` : ''}`)
		this.#enqueue({ type: 'user', text, about: rec?.title ?? null, urgent: true, at: now })
		if (rec) await this.notifier.send(feedbackPayload(rec, 'REPLY'))
	}

	// ── 규칙 발동과 깨움 대기열 ──
	isQuiet(now = this.clock()) {
		const h = kst(new Date(now)).h
		const { start, end } = this.cfg.active_hours
		return !(h >= start && h < end)
	}

	#handleFired(list) {
		const now = this.clock()
		for (const t of list) {
			const r = { type: 'rule', rule_id: t.rule.id, description: t.rule.description, entity_id: t.rule.entity_id, value: t.value, since: t.since, at: now }
			log(`규칙 발동: ${t.rule.id} (${t.rule.description})`)
			if (t.rule.priority === 'urgent') this.#enqueue({ ...r, urgent: true, pre_notified: this.#preNotify(r, now) })
			else if (this.isQuiet(now)) {
				this.held = this.held.filter(h => !(h.type === 'rule' && h.rule_id === r.rule_id))
				this.held.push(r)
				writeJson(P.held, this.held)
			} else this.#enqueue({ ...r, notBefore: now + this.cfg.limits.rule_batch_seconds * 1000 })
		}
	}

	#preNotify(r, now) {
		if (now - (this.preAt.get(r.rule_id) ?? 0) < 10 * MIN) return false
		this.preAt.set(r.rule_id, now)
		this.notifier.deliver(this.notifier.ruleAlert(r, 'urgent', '집 비서가 상황을 확인하고 있어요.')).catch(e => log('긴급 알림 실패:', e.message))
		return true
	}

	#maxAttempts(r) { return ['rule', 'user'].includes(r.type) ? this.cfg.limits.max_attempts : 2 }

	#saveQueue() { if (!this.dry) writeJson(P.queue, { queue: this.queue, inflight: this.inflight }) }

	#enqueue(r) {
		if (r.type === 'rule' && this.queue.some(q => q.type === 'rule' && q.rule_id === r.rule_id)) return
		if (r.type === 'anomaly' && this.queue.some(q => q.type === 'anomaly' && q.entity_id === r.entity_id)) return
		if (['bootstrap', 'hourly', 'reflection', 'held', 'weekly'].includes(r.type) && this.queue.some(q => q.type === r.type)) return
		this.queue.push(r)
		this.#saveQueue()
	}

	#checkinHours() {
		const { start, end } = this.cfg.active_hours
		const hs = []
		for (let h = start; h < Math.min(end, 24); h++) hs.push(h)
		if (end >= 24) hs.push(0)
		return hs
	}

	async tick() {
		const now = this.clock(), k = kst(new Date(now))
		this.beat()
		this.control = loadControl()
		this.todayCounters()
		await this.#refreshStates(now)
		if (this.ha.connected) {
			const fired = this.engine.tick(this.states, now)
			if (fired.length) { this.saveRuntime(); this.#handleFired(fired) }
			try { this.anomaly.sampleAll(this.states, now) } catch (e) { this.#warnOnce('samples', '센서 표본 기록 실패:', e) }
			let heldAnomaly = false
			for (const a of this.anomaly.checkAnomalies(this.states, now)) {
				if (this.isQuiet(now)) {
					this.held = this.held.filter(h => !(h.type === 'anomaly' && h.entity_id === a.entity_id))
					this.held.push(a)
					heldAnomaly = true
				} else {
					this.#enqueue(a)
				}
			}
			if (heldAnomaly) writeJson(P.held, this.held)
		}
		this.notifier.watchHa(now)
		this.notifier.heartbeat(now)
		await this.notifier.remindUrgent(now)
		if (!this.isQuiet(now) && this.held.length && !this.overLimit() && !this.inflight.some(r => r.type === 'held')) this.#enqueue({ type: 'held' })
		const due = this.schedule.filter(w => Date.parse(w.at) <= now)
		if (due.length) {
			for (const w of due) this.#enqueue({ type: 'scheduled', reason: w.reason, at: Date.parse(w.at) })
			this.schedule = this.schedule.filter(w => Date.parse(w.at) > now)
			writeJson(P.schedule, this.schedule)
		}
		const key = `${k.date}T${String(k.h).padStart(2, '0')}`
		const reflect = k.h === this.cfg.reflection_hour
		const bh = this.cfg.briefing_hours
		if (reflect && this.runtime.last_reflection !== k.date && this.runtime.last_checkin !== key) {
			this.runtime.last_reflection = k.date
			this.runtime.last_checkin = key
			this.saveRuntime()
			this.#enqueue({ type: 'reflection', hour: k.h === 0 ? 24 : k.h })
			if (!this.dry) try { this.anomaly.recomputeBaselines(now, this.states) } catch (e) { log('베이스라인 갱신 실패:', e.message) }
		} else if (Array.isArray(bh) && bh.length) {
			if (bh.includes(k.h) && k.h !== this.cfg.reflection_hour && this.runtime.last_checkin !== key) {
				this.runtime.last_checkin = key
				this.saveRuntime()
				this.#enqueue({ type: 'hourly', hour: k.h === 0 ? 24 : k.h, briefing: true })
			}
		} else if (this.cfg.hourly_checkin && this.#checkinHours().includes(k.h) && k.mi < 10 && this.runtime.last_checkin !== key) {
			this.runtime.last_checkin = key
			this.saveRuntime()
			this.#enqueue({ type: 'hourly', hour: k.h === 0 ? 24 : k.h })
		}
		const w = this.cfg.weekly
		if (w.enabled && k.wd === w.weekday && k.h >= w.hour && this.runtime.last_weekly !== k.date) {
			this.runtime.last_weekly = k.date
			this.saveRuntime()
			this.#enqueue({ type: 'weekly' })
		}
		this.#readInbox()
		await this.actionExecutor.expireActions(now)
		if (!this.dry) {
			const expiredProps = this.haAdmin.expireProposals(now)
			// 승인도 거절도 없이 만료된 제안 = 무시된 제안(학습 신호)
			for (const p of expiredProps) if (p.status === 'expired') try { this.implicitFeedback.onProposalOutcome(p, 'ignored', now) } catch {}
			if (expiredProps.length && this.control.send && this.ha.connected) {
				for (const p of expiredProps) await this.notifier.send(proposalResultPayload(p, { rollback: this.haAdmin.canRollback(p) })).catch(() => {})
			}
		}
		await this.notifier.flushOutbox(now)
		// 하루 한 번 자가개선 작업(실험 후속 조치·회귀 평가·기기 건강·루틴 자동화 제안). 판단(LLM)과 따로 돌고 기다리지 않는다.
		const dailyHour = this.cfg.learning?.daily_hour ?? 19
		if (!this.dry && this.ha.connected && k.h === dailyHour && this.runtime.last_daily_learning !== k.date && this.cfg.learning?.enabled !== false) {
			this.runtime.last_daily_learning = k.date
			this.saveRuntime()
			this.runDailyLearning(now).catch(e => log('하루 자가개선 작업 실패:', e.message))
		}
		await this.#maybeRun()
	}

	#readInbox() {
		let files = []
		try { files = readdirSync(P.inbox).sort() } catch { return }
		for (const f of files) {
			const p = join(P.inbox, f)
			const c = readJson(p, null)
			if (c?.cmd === 'restore' && !this.ha.connected) continue
			try { unlinkSync(p) } catch {}
			if (c?.cmd === 'wake') this.#enqueue({ type: 'manual', reason: String(c.reason || '수동 점검').slice(0, 200), urgent: true })
			else if (c?.cmd === 'say' && c.text) this.#enqueue({ type: 'user', text: String(c.text).slice(0, 500), about: null, urgent: true, at: this.clock() })
			else if (c?.cmd === 'weekly') this.#enqueue({ type: 'weekly', urgent: true })
			else if (c?.cmd === 'weekly-publish') { const r = readWeekly(); if (r) this.#publishWeekly(r.name, r.text) }
			else if (c?.cmd === 'restore') try { this.#restore(String(c.file)) } catch (e) { log('되돌리기 실패:', e.message) }
		}
	}

	#restore(name) {
		const now = this.clock(), keep = this.cfg.limits.keep_snapshots
		const { kind, content } = readSnapshot(name)
		if (kind === 'rules') {
			const rules = (content.rules ?? []).map(r => validateRule(r, this.states)).filter(v => v.ok).map(v => v.rule)
			snapshot('rules', this.rulesDoc, now, keep)
			this.engine.setRules(rules, this.states, now, rules.map(r => r.id))
			this.rulesDoc = { updated: iso(now), rules }
			writeJson(P.rules, this.rulesDoc)
			this.saveRuntime()
		} else {
			snapshot('memory', existsSync(P.memory) ? readFileSync(P.memory, 'utf8') : '', now, keep)
			writeFileSync(P.memory, content)
		}
		log(`이전 판으로 되돌림: ${name}`)
	}

	todayCounters() {
		const d = kst(new Date(this.clock())).date
		if (this.counters?.date !== d) {
			const prev = this.counters?.date
			this.counters = { date: d, runs: 0, alerts: 0, summaries: 0, actions: 0, undos: 0, error_notice: false }
			if (!this.dry) {
				writeJson(P.counters, this.counters)
				if (prev) {
					try {
						writeDaily(prev, 60, { store: this.store })
						rotateLogs()
						this.store?.maintain(this.clock())
					} catch (e) { log('하루 정리 실패:', e.message) }
				}
			}
		}
		this.counters.actions ??= 0
		this.counters.undos ??= 0
		return this.counters
	}
	bump(k) {
		this.todayCounters()[k]++
		if (!this.dry) writeJson(P.counters, this.counters)
	}
	overLimit(reasons = []) {
		const l = this.cfg.limits
		const reserve = reasons.some(r => r.type === 'user' || r.type === 'manual') ? l.user_reserve_runs : 0
		return this.todayCounters().runs >= l.brain_runs_per_day + reserve
	}

	runCycleSerialized(reasons, heldItems = []) {
		const run = this.cycleChain.then(() => this.cycle(reasons, heldItems))
		this.cycleChain = run.catch(() => {})
		return run
	}

	async #maybeRun() {
		if (this.running || !this.ha.connected || !this.queue.length || this.control.paused) return
		const now = this.clock()
		let ready = this.queue.filter(r => (r.notBefore ?? 0) <= now)
		if (!ready.length) return
		const gap = this.cfg.limits.min_gap_minutes * MIN * Math.min(2 ** this.failures, 16)
		if (!ready.some(r => r.urgent) && now - this.lastRunEnd < gap) return
		if (ready.some(r => r.type !== 'weekly')) ready = ready.filter(r => r.type !== 'weekly')
		this.queue = this.queue.filter(r => !ready.includes(r))
		ready = ready.filter(r => r.type !== 'held' || this.held.length)
		if (!ready.length) return this.#saveQueue()
		if (this.overLimit(ready)) {
			for (const r of ready.filter(r => r.type === 'weekly')) this.queue.push({ ...r, urgent: false, notBefore: now + 3600000 })
			this.#saveQueue()
			log(`오늘 판단 한도(${this.cfg.limits.brain_runs_per_day}회)에 닿아 건너뜀:`, ready.map(r => r.type).join(', '))
			await this.notifier.fallback(ready, '오늘 판단 한도에 닿아')
			for (const r of ready.filter(r => r.type === 'user')) {
				await this.notifier.deliver({ kind: 'info', level: 'normal', title: '🤖 오늘은 더 답하지 못해요', message: `오늘 판단 한도를 다 써서 "${String(r.text).slice(0, 80)}"에 답하지 못했어요. 내일 다시 말해 주세요. (한도: config.json의 limits.brain_runs_per_day)`, related_rule_ids: [] }, ready)
			}
			return
		}
		const heldItems = ready.some(r => r.type === 'held') ? [...this.held] : []
		this.inflight = ready
		this.#saveQueue()
		this.running = true
		try {
			const entry = await this.runCycleSerialized(ready, heldItems)
			if (!entry.error && !entry.deferred && heldItems.length) {
				this.held = this.held.filter(h => !heldItems.includes(h))
				writeJson(P.held, this.held)
			}
		} finally {
			this.running = false
			this.lastRunEnd = this.clock()
			this.inflight = []
			this.#saveQueue()
		}
	}

	// ── 한 번의 판단 ──
	async cycle(reasons, heldItems = []) {
		const started = this.clock()
		const weekly = reasons.some(r => r.type === 'weekly')
		const deep = weekly || reasons.some(r => r.type === 'bootstrap' || r.type === 'reflection')
		const forceMeta = weekly || reasons.some(r => r.type === 'manual' || r.type === 'user')
		const entry = { ts: iso(started), reasons: reasons.map(r => r.type + (r.rule_id ? `:${r.rule_id}` : '')), dry: this.dry }
		const rounds = []
		let input = null, mode = null, primary = null
		// 판단 중 도구(ha_control_device·ha_propose_admin)로 한 일. JSON 답의 actions와 같은 한도(per_cycle)를 쓰고 판단 기록에 남긴다.
		const toolLog = { calls: 0, actions: [], proposals: [], rejected: [] }
		try {
			const ctx = await this.#gather(started, { forceMeta })
			const sysDelta = this.#computeSysDelta(ctx)
			const lost = this.#connectionLost(ctx)
			if (!this.dry && lost && reasons.every(r => (r.defers ?? 0) < MAX_DEFERS)) {
				entry.deferred = true
				entry.summary = `HA 연결이 끊겨 자료를 다 받지 못해(${lost}) 다시 연결된 뒤 판단`
				this.queue.push(...reasons.map(r => ({ ...r, defers: (r.defers ?? 0) + 1 })))
				this.#saveQueue()
			} else if (!this.dry && this.#unchangedHourly(reasons, ctx, started, sysDelta)) {
				entry.skipped = true
				entry.summary = '직전 정각 점검 뒤로 달라진 것이 없어 판단을 건너뜀'
			} else {
				if (!this.dry) this.bump('runs')
				const lastReport = this.#writeRunFiles(ctx, sysDelta)
				if (weekly) await this.#writeWeeklyFiles(ctx, started)
				const aoId = this.cfg.away_override_entity
				const aoSt = aoId ? this.states.get(aoId) : null
				const awayOverride = aoSt ? { id: aoId, name: aoSt.attributes?.friendly_name, state: aoSt.state } : null
				const assistHistory = (!this.dry && deep && this.store) ? this.store.recentConversationMessages({ sinceMs: started - DAY, limit: 30 }) : []
				// 하루 돌아보기(reflection) 시 만료 기억 아카이브·중복 병합·기한 도래 실험 평가를 먼저 수행해 최신 상태를 프롬프트에 반영한다.
				const isReflection = reasons.some(r => r.type === 'reflection')
				if (!this.dry && isReflection && this.store && this.cfg.learning?.enabled !== false) {
					if (this.cfg.learning?.auto_consolidate_on_reflection !== false) {
						try { this.memoryMgr.consolidate({ now: started }) } catch (e) { log('기억 통합 실패:', e.message) }
					}
					try { evaluateDueExperiments(this.store, started); await this.applyExperimentVerdicts(started) } catch (e) { log('실험 사후 평가 실패:', e.message) }
				}
				const reasonText = reasons.map(r => r.text ?? r.reason ?? r.description ?? r.rule_id ?? r.type).filter(Boolean).join(' ')
				const reasonEntities = [...new Set(reasons.map(r => r.entity_id).filter(Boolean))]
				const lessonScope = weekly ? 'weekly' : 'cycle'
				const base = {
					now: started, quiet: this.isQuiet(started), reasons,
					rules: this.engine.rules, runtime: this.runtime.rules, schedule: this.schedule,
					memory: await this.memoryMgr.renderForPromptAsync(this.cfg.limits.memory_chars, { contextText: reasonText, entityIds: reasonEntities, now: started, touch: !this.dry }),
					lessons: this.memoryMgr.renderLessons(lessonScope, 1200, { now: started, touch: !this.dry }),
					memoryHygiene: deep ? this.memoryMgr.hygieneHints(started) : null,
					homeProfile: this.memoryMgr.loadHomeProfile(),
					recentNotes: this.journal.notifications({ sinceMs: started - DAY + 1 }),
					feedback: this.journal.feedbackRows({ sinceMs: started - 7 * DAY + 1 }),
					held: heldItems, rejected: readJson(P.rejected, []),
					pendingProposals: this.haAdmin.listProposals({ status: 'pending', limit: 10 }),
					ring: [...this.ring, ...this.noiseRing].sort((a, b) => a.t - b.t),
					weather: ctx.weather, calendar: ctx.calendar,
					actions: this.actionExecutor.actionContext(), metrics: deep ? weekMetrics(started, { store: this.store }) : null, lastReport,
					learningDigest: (deep && this.store && this.cfg.learning?.enabled !== false)
						? this.#learningDigest(started)
						: null,
					assistHistory,
					awayOverride, sysDelta,
					hours: {
						...this.cfg.active_hours,
						briefings: Array.isArray(this.cfg.briefing_hours) && this.cfg.briefing_hours.length ? this.cfg.briefing_hours : null,
						checkins: this.cfg.hourly_checkin ? this.#checkinHours().map(h => (h === 0 ? 24 : h)) : [],
						reflection: this.cfg.reflection_hour,
					},
					noise: this.cfg.noise_entities,
				}
				input = JSON.stringify(base)
				const guide = readFileSync(P.guide, 'utf8')
				primary = brainMode(this.cfg, this.control)
				mode = this.#pickMode(primary, started)
				const bs = brainSettings(this.cfg, mode)
				entry.brain = mode
				if (mode !== primary) entry.failover = true
				const pureHourly = !deep && reasons.length === 1 && reasons[0].type === 'hourly'
				const effort = weekly ? (bs.effort_weekly ?? bs.effort_deep) : deep ? bs.effort_deep : pureHourly ? bs.effort_hourly : bs.effort
				const timeoutSec = weekly ? this.cfg.weekly.timeout_seconds : deep ? bs.timeout_deep_seconds : bs.timeout_seconds
				const model = mode === primary && this.failures >= this.cfg.failover.after_failures && bs.fallback_model ? bs.fallback_model : bs.model
				if (model !== bs.model) entry.model = model
				let infoFiles = [], res, repairFeedback = null, repairedProposals = false, repairedWeeklyDrafts = false
				entry.codex_ms = 0
				this.runAbort = new AbortController()
				const perCycle = this.cfg.actions.per_cycle
				const toolContext = {
					allowDirectRequest: reasons.some(r => r.type === 'user'),
					adminEnabled: Boolean(this.cfg.policy?.admin_enabled),
					source: reasons.map(r => r.type).join('+'),
					executeControl: async (req, opts) => {
						const label = `${req.entity_id} ${req.action}`
						if (toolLog.calls >= perCycle) {
							const error = `행동은 한 번의 판단에 ${perCycle}개까지`
							toolLog.rejected.push({ action: label, error, via: 'tool' })
							return { ok: false, status: 'rejected', error }
						}
						toolLog.calls++
						const r = await this.actionExecutor.executeControlItem(req, opts)
						if (r.ok) toolLog.actions.push(`${r.status}: ${label} (도구)`)
						else toolLog.rejected.push({ action: label, error: r.error, via: 'tool' })
						return r
					},
					proposeAdmin: async req => {
						const r = await this.createAndNotifyProposal(req)
						if (r.ok) toolLog.proposals.push(`${r.proposal.pid}:${r.proposal.title}`)
						else toolLog.rejected.push({ proposal: req.title, error: r.error, via: 'tool' })
						return r
					},
				}
				try {
					for (let round = 1; ; round++) {
						const lastRound = round >= this.cfg.limits.max_rounds
						const prompt = buildPrompt({ ...base, guide, infoFiles, repairFeedback, lastRound })
						const r = await this.llmRouter.run({
							cfg: this.cfg, mode, prompt, effort, timeoutSec, model, signal: this.runAbort.signal,
							...((mode === 'api' || mode === 'gemini') && this.brain === runBrain ? { toolBroker: this.toolBroker, toolContext } : {}),
						})
						rounds.push({ prompt, answer: r.result })
						res = validateResponse(r.result)
						entry.rounds = round
						entry.codex_ms += r.ms ?? 0
						if (r.tokens) entry.tokens = (entry.tokens ?? 0) + r.tokens
						if (r.usage) {
							entry.usage ??= { input: 0, cached: 0, output: 0, reasoning: 0 }
							entry.usage.input += r.usage.input ?? 0
							entry.usage.cached += r.usage.cached ?? 0
							entry.usage.output += r.usage.output ?? 0
							entry.usage.reasoning += r.usage.reasoning ?? 0
						}
						if (res.info_requests.length && !lastRound) {
							const more = await this.#fetchInfo(res.info_requests, infoFiles.length)
							if (more.length) {
								infoFiles = [...infoFiles, ...more]
								continue
							}
						}
						// HA 관리 제안 사전 검증 실패 시 1회 자가 수정(Self-Repair) 라운드
						if (!lastRound && !repairedProposals && this.cfg.limits.proposal_self_repair !== false && this.cfg.policy?.admin_enabled && res.proposals?.length) {
							const preErrors = await this.#precheckProposals(res.proposals)
							if (preErrors.length) {
								repairedProposals = true
								repairFeedback = preErrors
								entry.proposal_repaired = true
								continue
							}
						}
						// 주간 보고서에 새 자동화 초안(YAML)만 쓰고 proposals를 안 냈으면 한 번 더 묻는다. 글 속 초안은 바로 승인할 수 없다.
						if (weekly && !lastRound && !repairedWeeklyDrafts && this.cfg.policy?.admin_enabled && reportHasAutomationDraft(res.report)
							&& !(res.proposals ?? []).some(p => ['automation_upsert', 'script_upsert'].includes(p.kind))) {
							repairedWeeklyDrafts = true
							repairFeedback = [{ title: '주간 보고서의 새 자동화 제안', error: '"새 자동화 제안"에 YAML 초안을 썼지만 proposals(automation_upsert)가 없다. 초안마다 같은 내용을 proposals 항목(kind=automation_upsert, payload.config)으로도 내서 사용자가 알림에서 바로 승인할 수 있게 할 것. report는 그대로 두되 각 초안 제목 옆에 "승인 대기"라고 적는다' }]
							entry.weekly_drafts_repaired = true
							continue
						}
						break
					}
				} finally { this.runAbort = null }
				if (infoFiles.length) entry.info = infoFiles.map(h => `${h.kind}:${h.entity_ids.join(',')}`)
				if (weekly && !res.report) throw new Error('주간 분석인데 report가 비어 있음')
				entry.summary = res.summary
				const failedBefore = this.failures
				this.failures = 0
				this.lastFailedMode = null
				if (mode !== primary && !this.failover) await this.#startFailover(primary, mode, started, failedBefore)
				entry.applied = await this.#apply(res, reasons, toolLog)
				this.#commitSysDelta(ctx)
			}
		} catch (e) {
			entry.error = e.message
			// 판단은 실패했어도 도구로 이미 한 일은 남긴다.
			if (toolLog.actions.length || toolLog.proposals.length) entry.tool_done = { actions: toolLog.actions, proposals: toolLog.proposals }
			this.failures++
			this.lastError = e.message
			if (mode) this.lastFailedMode = mode
			if (mode && mode !== primary) this.failover = null
			if (!this.dry) await this.#onFailure(reasons, e, mode)
		}
		entry.total_ms = this.clock() - started
		if (!entry.skipped && !entry.deferred) this.lastRun = entry
		if (!this.dry) {
			this.journal.decision(entry)
			if (!entry.skipped && !entry.deferred) this.notifier.heartbeat(this.clock(), { force: true })
			if (rounds.length) try { archiveRun({ started, reasons, input, rounds, keep: this.cfg.limits.keep_runs }) } catch (e) { log('판단 원문 보관 실패:', e.message) }
		}
		log(`판단 끝 (${Math.round(entry.total_ms / 1000)}초, 토큰 ${entry.tokens ?? '?'}): ${entry.error ? `실패 ${entry.error}` : entry.summary}`)
		return entry
	}

	// ── HA Assist 위임 메서드 ──
	handleStt(args) { return this.assist.handleStt(args) }
	handleTts(args) { return this.assist.handleTts(args) }
	handleAssist(args) { return this.assist.handleAssist(args) }
	prepareAssist() { return this.assist.prepareAssist() }
	assistDirectory() { return this.assist.assistDirectory() }

	// ── ToolBroker용 조회 헬퍼 ──
	getWeather(entityId = null) { return this.#weather(entityId) }
	getCalendar(days = 2) { return this.#calendar(days) }
	getRecentNotifications(hours = 24, limit = 15) {
		return this.journal.notifications({ sinceMs: this.clock() - hours * 3600000, limit })
	}

	async handleProposalAction(pid, decision) {
		const now = this.clock()
		let res
		if (decision === 'approve') res = await this.haAdmin.approveProposal(pid, now)
		else if (decision === 'reject') res = this.haAdmin.rejectProposal(pid, now)
		else if (decision === 'rollback') res = await this.haAdmin.rollbackProposal(pid, now)
		else return { ok: false, error: `알 수 없는 결정: ${decision}` }

		if (res.proposal && this.ha.connected && this.control.send) {
			await this.notifier.send(proposalResultPayload(res.proposal, {
				rollback: this.haAdmin.canRollback(res.proposal),
			})).catch(() => {})
		}
		return res
	}

	async createAndNotifyProposal(req) {
		if (!this.cfg.policy?.admin_enabled) return { ok: false, error: 'HA 관리 권한(policy.admin_enabled)이 꺼져 있음' }
		const r = await this.haAdmin.createProposal(req, this.clock())
		if (!r.ok) return r
		if (this.control.send && this.ha.connected) {
			await this.notifier.send(proposalApprovalPayload(r.proposal)).catch(e => log('제안 승인 알림 실패:', e.message))
		}
		return r
	}

	async #removePromotedRule(ruleId) {
		const rules = this.engine.rules.filter(r => r.id !== ruleId)
		if (rules.length === this.engine.rules.length) return
		const now = this.clock()
		snapshot('rules', this.rulesDoc, now, this.cfg.limits.keep_snapshots)
		this.engine.setRules(rules, this.states, now, [])
		this.rulesDoc = { updated: iso(now), rules }
		writeJson(P.rules, this.rulesDoc)
		this.saveRuntime()
		log(`승격된 감시 규칙 삭제 완료: ${ruleId}`)
	}

	#failoverTarget(primary) {
		const PAIR = { codex: 'api', api: 'codex', agy: 'gemini', gemini: 'agy' }
		const explicit = this.cfg.failover?.target
		const candidates = [
			explicit && explicit !== primary && MODES.includes(explicit) ? explicit : null,
			PAIR[primary],
			...MODES.filter(m => m !== primary && m !== PAIR[primary] && m !== explicit),
		].filter(Boolean)
		return candidates.find(m => this.canUse(this.cfg, m)) ?? candidates[0] ?? primary
	}

	#pickMode(primary, now) {
		const f = this.cfg.failover
		if (this.dry || !f.enabled) return primary
		const other = this.#failoverTarget(primary)
		const threshold = brainSettings(this.cfg, primary).fallback_model ? f.after_failures + 1 : f.after_failures
		if (this.failover && (this.failover.primary !== primary || now >= this.failover.until)) {
			if (this.failover.primary === primary) this.failures = Math.max(this.failures, threshold - 1)
			this.failover = null
		}
		if (this.failover) return this.failover.mode ?? other
		return this.failures >= threshold && this.lastFailedMode !== other && this.canUse(this.cfg, other) ? other : primary
	}

	async #startFailover(primary, mode, now, failed) {
		const hold = this.cfg.failover.hold_minutes
		this.failover = { primary, mode, until: now + hold * MIN }
		log(`${MODE_LABEL[primary]} 판단이 ${failed}번 연속 실패해 ${MODE_LABEL[mode]}로 넘어감 (${hold}분 동안)`)
		const c = this.todayCounters()
		if (this.dry || c.failover_notice) return
		c.failover_notice = true
		writeJson(P.counters, c)
		const why = String(this.lastError ?? '').replace(/\s+/g, ' ').slice(-140)
		const cost = (mode === 'api' || mode === 'gemini') ? ` ${MODE_LABEL[mode]}는 쓴 토큰만큼 요금이 나가요.` : ''
		await this.notifier.deliver({ kind: 'info', level: 'normal', title: '🤖 판단 방식을 잠시 바꿨어요', message: `${MODE_LABEL[primary]} 판단이 ${failed}번 연속 실패해 ${MODE_LABEL[mode]}로 묻고 있어요.${cost} ${MODE_LABEL[primary]}가 돌아오면 스스로 되돌아가요. 마지막 오류: ${why}`.slice(0, 500), related_rule_ids: [] })
	}

	#unchangedHourly(reasons, ctx, now, sysDelta = null) {
		if (!this.cfg.hourly_skip_unchanged || reasons.length !== 1 || reasons[0].type !== 'hourly') return false
		if (reasons[0].briefing) return false
		const hour = reasons[0].hour
		const rain = f => Number(f.precipitation) > 0 || /rain|pour|snow|hail|lightning/.test(f.condition ?? '')
		const soon = ev => { const t = Date.parse(/^\d{4}-\d\d-\d\d$/.test(ev.start) ? `${ev.start}T00:00:00+09:00` : ev.start); return t > now && t - now < 12 * 3600000 }
		const h6 = (ctx.weather?.hourly ?? []).slice(0, 6)
		const temps = h6.map(f => Number(f.temperature)).filter(Number.isFinite)
		const tempBand = temps.length ? [Math.round(Math.min(...temps) / 3), Math.round(Math.max(...temps) / 3)] : []
		const windy = Number(ctx.weather?.current?.wind_speed) >= 10
		const fp = JSON.stringify([
			h6.some(rain),
			tempBand,
			windy,
			(Array.isArray(ctx.calendar) ? ctx.calendar : []).filter(soon).map(ev => `${ev.start} ${ev.summary}`),
			Object.entries(this.runtime.rules).filter(([, r]) => r.fired).map(([id]) => id).sort(),
			this.held.length, this.schedule.length,
		])
		const last = this.runtime.hourly
		const since = last?.at ?? 0
		const quietHouse = !this.ring.some(c => c.t > since && significantChange(c, this.isNoise)) && !this.journal.feedbackRows({ sinceMs: since + 1, limit: 1 }).length
		const hasSysAlert = Boolean(this.runtime.syslog_seen && (sysDelta?.newErrors?.length || sysDelta?.increasedErrors?.length || sysDelta?.newRepairs?.length))
		const first = hour === this.cfg.active_hours.start || hour === 24
		const skip = !first && !hasSysAlert && last?.fp === fp && quietHouse && now - since < 6 * 3600000
		if (!skip) { this.runtime.hourly = { fp, at: now }; this.saveRuntime() }
		return skip
	}

	#computeSysDelta(ctx) {
		const prevSys = this.runtime.syslog_seen
		const prevRep = this.runtime.repairs_seen
		const newErrors = [], increasedErrors = [], newOther = [], increasedOther = []
		const annotatedSyslog = ctx.syslog.map(x => {
			const k = sysKey(x), prev = prevSys?.[k]
			const isErr = x.level === 'ERROR' || x.level === 'CRITICAL'
			if (!prev) {
				(isErr ? newErrors : newOther).push(x)
				return { ...x, status: 'new' }
			}
			if ((x.count ?? 1) > (prev.count ?? 0) || (x.last && x.last !== prev.last)) {
				const item = { ...x, prev_count: prev.count ?? 0 }
				;(isErr ? increasedErrors : increasedOther).push(item)
				return { ...item, status: 'increased' }
			}
			return { ...x, status: 'unchanged' }
		})
		const newRepairs = ctx.repairs.filter(r => !prevRep || !prevRep.includes(repairKey(r)))
		return { annotatedSyslog, newErrors, increasedErrors, newOther, increasedOther, newRepairs }
	}

	#commitSysDelta(ctx) {
		if (this.dry) return
		let changed = false
		if (!ctx.syslogError) {
			this.runtime.syslog_seen = Object.fromEntries(ctx.syslog.map(x => [sysKey(x), { count: x.count ?? 1, last: x.last ?? null }]))
			changed = true
		}
		if (!ctx.repairsError) {
			this.runtime.repairs_seen = ctx.repairs.map(repairKey)
			changed = true
		}
		if (changed) this.saveRuntime()
	}

	#connectionLost(ctx) {
		if (!this.ha.connected) return '연결 없음'
		const e = [ctx.weather, ctx.calendar].map(x => x?.error).find(m => m && CONN_ERR.test(m))
		return e ?? null
	}

	async #gather(now, { forceMeta = false } = {}) {
		const safe = p => p.catch(e => ({ error: e.message }))
		const [weather, calendar, repairs, syslog] = await Promise.all([
			safe(this.#weather()), safe(this.#calendar()),
			safe(this.ha.call({ type: 'repairs/list_issues' })), safe(this.ha.call({ type: 'system_log/list' })),
		])
		await this.refreshMeta(now, forceMeta)
		return {
			weather, calendar,
			repairsError: !!repairs?.error,
			syslogError: !!syslog?.error,
			repairs: (repairs?.issues ?? []).filter(i => !i.ignored).map(i => ({ domain: i.issue_domain ?? i.domain, id: i.issue_id, severity: i.severity, created: fmt(Date.parse(i.created)), detail: i.translation_placeholders ?? undefined })),
			syslog: (Array.isArray(syslog) ? syslog : []).slice(0, 50).map(x => ({ level: x.level, name: x.name, message: [].concat(x.message ?? []).join(' ').slice(0, 300), count: x.count, last: fmt(x.timestamp * 1000) })),
			states: compactStates(this.states, this.meta.areaOf),
			automations: automationList(this.states, this.meta.autoCfg),
		}
	}

	async refreshMeta(now, force = false) {
		if (!force && this.meta.at && now - this.meta.at < 6 * 3600000) return
		try {
			const [areas, devices, entities] = await Promise.all(['area', 'device', 'entity'].map(k => this.ha.call({ type: `config/${k}_registry/list` })))
			const areaName = new Map(areas.map(a => [a.area_id, a.name]))
			const deviceArea = new Map(devices.map(d => [d.id, d.area_id]))
			const areaOf = new Map(), catOf = new Map()
			for (const e of entities) {
				const name = areaName.get(e.area_id ?? deviceArea.get(e.device_id))
				if (name) areaOf.set(e.entity_id, name)
				if (e.entity_category) catOf.set(e.entity_id, e.entity_category)
			}
			const autoCfg = {}
			const autoIds = [...this.states.keys()].filter(id => id.startsWith('automation.'))
			for (let i = 0; i < autoIds.length; i += 8) {
				await Promise.all(autoIds.slice(i, i + 8).map(async id => {
					try { autoCfg[id] = (await this.ha.call({ type: 'automation/config', entity_id: id }))?.config } catch {}
				}))
			}
			this.meta.at = now
			this.meta.areaOf = areaOf
			this.meta.catOf = catOf
			const prevAutoCfg = this.meta.autoCfg
			this.meta.autoCfg = autoCfg
			if (!this.dry) try { this.#detectAutomationEdits(prevAutoCfg, autoCfg, now) } catch (e) { log('자동화 변경 감지 실패:', e.message) }
		} catch (e) { log('영역·자동화 정보를 가져오지 못함:', e.message) }
		await this.loadScriptFields([...this.tiers.keys()], { now, force })
	}

	// 제어할 수 있는 스크립트가 받는 필드(fields)를 HA에서 받아 둔다(6시간 캐시).
	// 받지 못한 스크립트는 Map에 넣지 않는다 → 정책 엔진이 그 스크립트 실행을 막는다(필드 없이 불러 반대로 동작하는 일 방지).
	async loadScriptFields(ids, { now = this.clock(), force = false } = {}) {
		const cache = this.meta.scriptFields ??= new Map()
		const want = [...new Set(ids)].filter(id => typeof id === 'string' && id.startsWith('script.')
			&& (force || !cache.has(id) || now - cache.get(id).at >= 6 * 3600000))
		await Promise.all(want.map(async id => {
			try {
				const cfg = (await this.ha.call({ type: 'script/config', entity_id: id }))?.config
				if (cfg && typeof cfg === 'object') cache.set(id, { fields: cfg.fields && typeof cfg.fields === 'object' ? cfg.fields : {}, at: now })
			} catch (e) { log(`스크립트 설정을 가져오지 못함(${id}):`, e.message) }
		}))
		return cache
	}

	async #weather(overrideEntity = null) {
		const read = async e => {
			const [h, d] = await Promise.all(['hourly', 'daily'].map(type =>
				this.ha.callService('weather', 'get_forecasts', { data: { type }, target: { entity_id: e }, response: true })))
			const cur = this.states.get(e)
			return {
				entity: e,
				current: cur ? { state: cur.state, temperature: cur.attributes.temperature, humidity: cur.attributes.humidity, wind_speed: cur.attributes.wind_speed, wind_unit: cur.attributes.wind_speed_unit } : null,
				hourly: (h?.response?.[e]?.forecast ?? []).slice(0, 12),
				daily: (d?.response?.[e]?.forecast ?? []).slice(0, 3),
			}
		}
		const primary = (overrideEntity && this.states.has(overrideEntity)) ? overrideEntity : this.cfg.weather_entity
		const fb = overrideEntity ? null : this.cfg.weather_fallback_entity
		try {
			const w = await read(primary)
			if (fb && fb !== primary && !w.hourly.length && !w.daily.length) {
				try { return await read(fb) } catch {}
			}
			return w
		} catch (err) {
			if (!fb || fb === primary || CONN_ERR.test(err.message)) throw err
			return await read(fb)
		}
	}

	async #calendar(days = 2) {
		const ids = [...this.states.keys()].filter(i => i.startsWith('calendar.'))
		if (!ids.length) return []
		const now = this.clock()
		const end = new Date(Date.parse(`${kst(new Date(now)).date}T00:00:00+09:00`) + days * DAY)
		const r = await this.ha.callService('calendar', 'get_events', {
			data: { start_date_time: iso(now), end_date_time: end.toISOString() }, target: { entity_id: ids }, response: true,
		})
		const out = []
		for (const [cal, v] of Object.entries(r?.response ?? {})) {
			for (const ev of v.events ?? []) out.push({ calendar: this.states.get(cal)?.attributes?.friendly_name ?? cal, start: ev.start, end: ev.end, summary: ev.summary, location: ev.location || undefined })
		}
		const t = ev => Date.parse(/^\d{4}-\d\d-\d\d$/.test(ev.start) ? `${ev.start}T00:00:00+09:00` : ev.start)
		return out.sort((a, b) => t(a) - t(b)).slice(0, 30)
	}

	#writeRunFiles(ctx, sysDelta = null) {
		rmSync(P.run, { recursive: true, force: true })
		mkdirSync(P.run, { recursive: true })
		const w = (name, data, pretty = true) => writeFileSync(join(P.run, name), pretty ? JSON.stringify(data, null, 1) : JSON.stringify(data))
		w('states.json', ctx.states, false)
		w('automations.json', ctx.automations)
		w('automation-configs.json', this.meta.autoCfg ?? {})
		w('daily.json', recentDaily(14))
		w('repairs.json', ctx.repairs)
		w('system-log.json', sysDelta ? sysDelta.annotatedSyslog : ctx.syslog)
		const last = readWeekly()
		if (last) writeFileSync(join(P.run, 'weekly-last-report.md'), last.text)
		return last?.name ?? null
	}

	async #writeWeeklyFiles(ctx, now) {
		const period = { from: now - WEEKLY_HOURS * 3600000, to: now }
		const write = async (name, ids, digest) => {
			let data
			try { data = digest(ids.length ? await this.ha.logbook(ids, WEEKLY_HOURS) : []) } catch (e) { data = { error: e.message } }
			writeFileSync(join(P.run, name), JSON.stringify(data, null, 1))
		}
		await write('weekly-automations.json', ctx.automations.map(a => a.id), rows => automationRuns(rows, ctx.automations, period))
		await write('weekly-devices.json', [...this.states.keys()].filter(id => DEVICE_DOMAINS.has(id.split('.')[0])), rows => deviceActivity(rows, this.states, this.meta.areaOf, period))
		try {
			const health = await this.haAdmin.auditHealth()
			writeFileSync(join(P.run, 'weekly-health.json'), JSON.stringify(health, null, 1))
		} catch (e) {
			writeFileSync(join(P.run, 'weekly-health.json'), JSON.stringify({ error: e.message }, null, 1))
		}
	}

	async #fetchInfo(reqs, offset) {
		const files = []
		for (const q of reqs) {
			let data = {}
			const ids = q.kind === 'config_entries' ? ['config_entries'] : q.entity_ids.filter(id => this.states.has(id))
			if (!ids.length) continue
			try {
				if (q.kind === 'traces') {
					const raw = typeof this.ha.traces === 'function' ? await this.ha.traces('automation') : []
					const want = new Set(ids.map(id => this.meta.autoCfg?.[id]?.id ?? id.replace(/^automation\./, '')))
					data = (raw ?? []).filter(t => want.has(t.item_id)).slice(0, 50)
				} else if (q.kind === 'config_entries') {
					data = typeof this.ha.configEntries === 'function' ? await this.ha.configEntries() : []
				} else if (q.kind === 'statistics') {
					data = digestHaData('statistics', await this.ha.statistics(ids, q.hours))
				} else if (q.kind === 'logbook') {
					data = digestHaData('logbook', await this.ha.logbook(ids, q.hours))
				} else {
					data = digestHaData('history', await this.ha.history(ids, q.hours))
				}
			} catch (e) { data = { error: e.message } }
			const file = `run/info-${offset + files.length + 1}-${q.kind}.json`
			writeFileSync(join(P.run, '..', file), JSON.stringify(data, null, 1))
			files.push({ file, kind: q.kind, entity_ids: ids, hours: q.hours })
		}
		return files
	}

	async #precheckProposals(proposals = []) {
		const errs = []
		for (const p of proposals) {
			if (p.kind === 'automation_upsert' || p.kind === 'script_upsert') {
				const cfg = p.payload?.config ?? p.payload
				const v = await this.haAdmin.validateHaConfig(p.kind, cfg)
				if (!v.valid) errs.push({ title: p.title, error: v.errors.join(', ') })
			}
		}
		return errs
	}

	async #apply(res, reasons, toolLog = null) {
		const now = this.clock(), keep = this.cfg.limits.keep_snapshots
		const out = { added: [], changed: [], deleted: [], rejected: [...(toolLog?.rejected ?? [])], wakes: [], memory: res.memory.mode, actions: [], proposals: [...(toolLog?.proposals ?? [])], notifications: [] }
		let rules = [...this.engine.rules]
		for (const id of res.rule_changes.delete) {
			if (rules.some(r => r.id === id)) { rules = rules.filter(r => r.id !== id); out.deleted.push(id) }
		}
		const candidateChanged = []
		for (const raw of res.rule_changes.upsert) {
			const v = validateRule(raw, this.states)
			if (!v.ok) { out.rejected.push({ rule: raw?.id ?? null, error: v.error }); continue }
			const i = rules.findIndex(r => r.id === v.rule.id)
			if (i >= 0) { rules[i] = v.rule; out.changed.push(v.rule.id); candidateChanged.push(v.rule) }
			else if (rules.length >= this.cfg.limits.max_rules) out.rejected.push({ rule: v.rule.id, error: `규칙은 ${this.cfg.limits.max_rules}개까지` })
			else { rules.push(v.rule); out.added.push(v.rule.id); candidateChanged.push(v.rule) }
		}
		const wakes = []
		for (const w of res.next_wakes) {
			const at = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(w.at) ? w.at : `${w.at}+09:00`)
			if (!Number.isFinite(at) || at < now + 60000 || at > now + 48 * 3600000) { out.rejected.push({ wake: w.at, error: '시각은 지금부터 1분~48시간 사이, ISO 형식' }); continue }
			wakes.push({ at: iso(at), reason: w.reason })
		}
		if (this.dry) {
			out.preview = { rules: rules.filter(r => out.added.includes(r.id) || out.changed.includes(r.id)), wakes, memory: res.memory, memory_ops: res.memory_ops, lesson_ops: res.lesson_ops, actions: res.actions, proposals: res.proposals, notifications: res.notifications, report: res.report || undefined }
			return out
		}
		// 사전 백테스트 게이트(Pre-Apply Gate): 새로 만들거나 고친 규칙이 지난 7일 기록에서 과다 발동하면 적용하지 않고 거절한다.
		const backtestResults = new Map()
		const tested = []
		const maxFires = this.cfg.limits.backtest_max_fires ?? 25
		if (this.cfg.rule_backtest && candidateChanged.length && typeof this.ha?.history === 'function') {
			const btRules = candidateChanged.filter(backtestable)
			if (btRules.length) {
				try {
					const hours = 168
					const hist = await this.ha.history([...new Set(btRules.flatMap(r => [r.entity_id, ...(r.also ?? []).map(c => c.entity_id)]))], hours)
					for (const r of btRules) {
						try {
							const b = backtestRule(r, hist, now - hours * 3600000, now)
							if (!b) continue
							if (b.fires > maxFires) {
								out.rejected.push({ rule: r.id, error: `사전 백테스트 과다 발동 차단: 지난 ${b.days}일간 ${b.fires}회(상한 ${maxFires}회). 조건·for_minutes·cooldown을 조정할 것` })
								const prevRule = this.engine.rules.find(x => x.id === r.id)
								if (prevRule) rules = rules.map(x => (x.id === r.id ? prevRule : x))
								else rules = rules.filter(x => x.id !== r.id)
								out.added = out.added.filter(id => id !== r.id)
								out.changed = out.changed.filter(id => id !== r.id)
							} else {
								backtestResults.set(r.id, b)
								tested.push(`${r.id}: 지난 ${b.days}일 기록으로 ${b.fires}회`)
							}
						} catch (e) { log(`규칙 백테스트 실패(${r.id}):`, e.message) }
					}
				} catch (e) { log('규칙 백테스트용 기록을 받지 못함:', e.message) }
			}
		}
		if (out.added.length || out.changed.length || out.deleted.length || !this.rulesDoc) {
			// 7일 검증에서 악화로 나오면 되돌릴 수 있게 바꾸기 전 규칙을 잡아 둔다
			const oldById = new Map(this.engine.rules.map(r => [r.id, r]))
			snapshot('rules', this.rulesDoc, now, keep)
			this.engine.setRules(rules, this.states, now, [...out.added, ...out.changed])
			for (const [rid, b] of backtestResults) {
				if (this.runtime.rules[rid]) this.runtime.rules[rid].backtest = b
			}
			this.rulesDoc = { updated: iso(now), rules }
			writeJson(P.rules, this.rulesDoc)
			this.saveRuntime()
			if (this.store && this.cfg.learning?.enabled !== false) {
				for (const rid of [...out.added, ...out.changed]) {
					const rule = rules.find(r => r.id === rid)
					registerExperiment(this.store, {
						kind: 'rule',
						ref_id: rid,
						scope: { rule_ids: [rid], entity_ids: [...new Set([rule?.entity_id, ...(rule?.also ?? []).map(c => c.entity_id)].filter(Boolean))] },
						revert: { prev_rule: oldById.get(rid) ?? null, new_rule: rule ?? null },
						title: `감시 규칙 ${out.added.includes(rid) ? '추가' : '수정'}: ${rid}`,
						evalDays: this.cfg.learning?.experiment_eval_days ?? 7,
						now,
					})
				}
			}
		}
		if (tested.length) {
			out.backtest = tested
			log('규칙 백테스트:', tested.join(' · '))
		}
		this.schedule = [...this.schedule, ...wakes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, this.cfg.limits.max_pending_wakes)
		writeJson(P.schedule, this.schedule)
		out.wakes = wakes.map(w => fmt(Date.parse(w.at)))
		this.memoryMgr.applyLegacy(res.memory, out, now, { dry: this.dry, max: this.cfg.limits.memory_chars, keepSnapshots: keep })
		if (res.memory_ops?.length) {
			const mSrc = reasons.some(r => r.type === 'user') ? 'user' : 'cycle'
			const mRes = this.memoryMgr.applyOps(res.memory_ops, { source: mSrc, now })
			for (const b of mRes.blocked ?? []) out.rejected.push({ memory_delete: b.key, error: b.error })
		}
		if (res.lesson_ops?.length && this.store) {
			const lSrc = reasons.some(r => r.type === 'user') ? 'user' : 'cycle'
			for (const l of res.lesson_ops) {
				if (l.op === 'delete') {
					const dr = this.store.deleteLesson(l.key, { source: lSrc, now })
					if (dr.protected) out.rejected.push({ lesson_delete: l.key, error: dr.error })
				} else {
					this.store.upsertLesson({ ...l, source: lSrc, now })
					if (this.cfg.learning?.enabled !== false) {
						registerExperiment(this.store, { kind: 'lesson', ref_id: l.key, title: `교훈 등록: ${l.key}`, evalDays: this.cfg.learning?.experiment_eval_days ?? 7, now })
					}
				}
			}
		}
		const notes = [...res.notifications]
		out.actions = [...(toolLog?.actions ?? []), ...await this.actionExecutor.applyActions(res.actions, out, reasons, { used: toolLog?.calls ?? 0 })]
		const rejectedProposals = []
		for (const p of res.proposals ?? []) {
			const pr = await this.createAndNotifyProposal(p)
			if (pr.ok) out.proposals.push(`${pr.proposal.pid}:${pr.proposal.title}`)
			else {
				out.rejected.push({ proposal: p.title, error: pr.error })
				rejectedProposals.push({ title: p.title, error: pr.error })
				this.implicitFeedback.onProposalOutcome(p, 'validation_failed', now, pr.error)
			}
		}
		if (res.report) {
			if (reasons.some(r => r.type === 'weekly')) {
				const sc = this.scorecardNow(now)
				const reportText = (rejectedProposals.length
					? `${res.report}\n\n> ⚠️ 참고: 아래 승인안은 사전 검증을 통과하지 못해 승인 대기 목록에 등록되지 않았어요.\n${rejectedProposals.map(r => `- ${r.title}: ${r.error}`).join('\n')}`
					: res.report) + (sc ? `\n\n## 자기 성능 지표 (자동 집계)\n${renderScorecard(sc)}` : '')
				out.report = saveWeekly(kst(new Date(now)).date, reportText, this.cfg.limits.keep_weekly)
				out.published = await this.#publishWeekly(out.report, reportText)
				if (!notes.length) notes.push({ kind: 'info', level: 'normal', title: '📊 주간 자동화 분석이 나왔어요', message: `${res.summary.slice(0, 300)} ${out.published ? '전문은 HA 앱의 알림(🔔)에서 볼 수 있어요.' : '전문: node src/cli.mjs weekly'}`, related_rule_ids: [] })
			} else out.rejected.push({ report: true, error: 'report는 주간 분석(weekly) 깨움에서만 쓴다' })
		}
		for (const n of notes) out.notifications.push(await this.notifier.deliver(n, reasons))
		writeJson(P.rejected, out.rejected)
		return out
	}

	async #publishWeekly(name, text) {
		if (this.dry || !this.cfg.weekly.publish) return false
		const [domain, service] = PUBLISH_SERVICE.split('.')
		try {
			await this.ha.callService(domain, service, { data: { title: `📊 집 비서 주간 분석 ${String(name).replace('.md', '')}`, message: text, notification_id: 'haagent_weekly' } })
			log(`주간 보고서를 HA 알림 목록에 올림: ${name}`)
			return true
		} catch (e) { log('주간 보고서를 HA에 올리지 못함:', e.message); return false }
	}

	async #refreshStates(now) {
		if (this.dry || !this.ha.connected || now - this.lastRefresh < 5 * MIN) return
		this.lastRefresh = now
		try {
			const list = await this.ha.call({ type: 'get_states' })
			const seen = new Set()
			for (const s of list) {
				seen.add(s.entity_id)
				const cur = this.states.get(s.entity_id)
				if (!cur || Date.parse(s.last_updated) >= Date.parse(cur.last_updated)) this.states.set(s.entity_id, s)
			}
			for (const id of [...this.states.keys()]) if (!seen.has(id)) this.states.delete(id)
		} catch (e) { log('상태 다시 읽기 실패:', e.message) }
	}

	async #onFailure(reasons, e, mode = null) {
		const label = MODE_LABEL[mode ?? brainMode(this.cfg, this.control)]
		log(`${label} 판단 실패:`, e.message)
		const now = this.clock(), gaveUp = []
		for (const r of reasons) {
			if (r.type === 'held') continue
			const attempts = (r.attempts ?? 0) + 1
			if (attempts < this.#maxAttempts(r)) this.queue.push({ ...r, attempts, notBefore: now + 5 * MIN * attempts })
			else gaveUp.push(r)
		}
		this.#saveQueue()
		await this.notifier.fallback(gaveUp, '판단이 실패해')
		const c = this.todayCounters()
		if (this.failures >= 3 && !c.error_notice) {
			c.error_notice = true
			writeJson(P.counters, c)
			const why = e.message.replace(/\s+/g, ' ').slice(-160)
			await this.notifier.deliver({ kind: 'info', level: 'normal', title: '🤖 집 비서가 판단을 못 하고 있어요', message: `${label} 판단이 ${this.failures}번 연속 실패했어요. 마지막 오류: ${why}`, related_rule_ids: [] }, reasons)
		}
	}

	// ── 자가개선 루프 ──

	// 사용자가 HA에서 자동화를 직접 만들거나 고치거나 지운 것을 찾는다(집 비서가 적용·롤백한 것은 뺀다).
	// 집 비서가 제안해 만든 자동화를 사용자가 고쳤다면 그 제안이 조금 틀렸다는 신호이고, 고친 내용은 선호로 기억한다.
	#detectAutomationEdits(prevCfg, autoCfg, now) {
		const prev = this.runtime.auto_cfg
		const since = this.runtime.auto_cfg_at ?? 0
		const hashes = {}
		const autoIds = [...this.states.keys()].filter(id => id.startsWith('automation.'))
		for (const eid of new Set([...autoIds, ...Object.keys(autoCfg)])) {
			const c = autoCfg[eid]
			if (c) hashes[eid] = { id: c.id ?? null, alias: c.alias ?? eid, hash: cfgHash(c) }
			// 설정을 못 받은 자동화는 지난 값을 그대로 두고, 처음 보는 것이면 "내용 모름"(hash null)으로 둔다.
			// HA가 잠깐 설정을 못 내줘도 모든 자동화를 사용자가 새로 만들거나 지운 것으로 오인하지 않게 한다.
			else hashes[eid] = prev?.[eid] ?? { id: null, alias: this.states.get(eid)?.attributes?.friendly_name ?? eid, hash: null }
		}
		this.runtime.auto_cfg = hashes
		this.runtime.auto_cfg_at = now
		this.saveRuntime()
		if (!prev) return []
		const props = this.haAdmin.listProposals({ limit: 300 })
		const mine = new Set(props.filter(p => (p.applied_at ?? 0) >= since || (p.rollback_at ?? 0) >= since || p.status === 'applying').map(p => p.payload?.config_id).filter(Boolean))
		const changes = []
		for (const [eid, h] of Object.entries(hashes)) {
			if (h.id && mine.has(h.id)) continue
			const old = prev[eid]
			if (!old) { if (h.hash) changes.push({ eid, change: 'created', ...h, fields: [] }) }
			else if (old.hash && h.hash && old.hash !== h.hash) changes.push({ eid, change: 'modified', ...h, fields: automationChangeSummary(prevCfg?.[eid], autoCfg[eid]) })
		}
		for (const [eid, old] of Object.entries(prev)) if (!hashes[eid] && old.hash && !(old.id && mine.has(old.id))) changes.push({ eid, change: 'deleted', ...old, fields: [] })
		const verb = { created: '만듦', modified: '고침', deleted: '지움' }
		for (const ch of changes) {
			this.store?.recordImplicitFeedback({ ts: now, kind: 'automation_user_edited', entity_id: ch.eid, ref_id: ch.id, score: 0, detail: { change: ch.change, alias: ch.alias, fields: ch.fields } })
			const made = props.find(p => p.status === 'applied' && ch.id && p.payload?.config_id === ch.id)
			if (made && ch.change !== 'created') {
				this.implicitFeedback.onProposalOutcome(made, ch.change === 'deleted' ? 'deleted_by_user' : 'edited_by_user', now, ch.fields.join(', '))
				this.memoryMgr.applyOps([{
					op: 'upsert', category: 'preference', key: `auto_edit_${ch.id}`.slice(0, 80), ttl_days: 180, entity_ids: [ch.eid],
					content: `사용자가 집 비서가 만든 자동화 "${ch.alias}"를 직접 ${verb[ch.change]}${ch.fields.length ? `(${ch.fields.join(', ')})` : ''}. 비슷한 제안을 할 때 이 수정을 따를 것.`,
				}], { source: 'user_edit', now })
			}
			log(`사용자가 자동화를 직접 ${verb[ch.change]}: ${ch.alias}${ch.fields.length ? ` (${ch.fields.join(', ')})` : ''}${made ? ' — 집 비서 제안으로 만든 자동화' : ''}`)
		}
		return changes
	}

	#learningDigest(now) {
		const parts = [buildLearningDigest({ store: this.store, rules: this.engine.rules, runtime: this.runtime.rules, cfg: this.cfg, states: this.states, now, isNoise: this.isNoise })]
		const sc = this.scorecardNow(now)
		if (sc) {
			const t = sc.trends.filter(x => x.latest != null).map(x => `${x.label} ${x.latest}${x.previous != null ? `(전주 ${x.previous}${x.better === true ? ' ▲' : x.better === false ? ' ▼' : ''})` : ''}`)
			if (t.length) parts.push(`- 자기 성능 지표(최근 7일): ${t.join(', ')}`)
		}
		const routineProps = this.haAdmin.listProposals({ limit: 100 }).filter(p => String(p.payload?.config_id ?? '').startsWith('haagent_routine_'))
		if (routineProps.length) parts.push(`- 생활 루틴 자동화 제안(코드가 백테스트로 이미 올림, 같은 것을 다시 제안하지 말 것): ${routineProps.slice(0, 6).map(p => `[${p.status}] ${p.title}`).join(' / ')}`)
		return parts.filter(Boolean).join('\n')
	}

	scorecardNow(now = this.clock()) {
		if (!this.store) return null
		return buildScorecard({ store: this.store, now, regression: this.runtime.last_regression ?? null })
	}

	// 지금 설정으로 빠른 경로 회귀 평가
	regressionNow() {
		const index = directoryIndexFor({ policy: this.policy, states: this.states, meta: this.meta, cfg: this.cfg })
		return runFastPathRegression({ index, cases: fastPathCases() })
	}

	async suggestAutomationsNow({ dry = true, now = this.clock() } = {}) {
		if (!this.meta.autoCfg && this.ha.connected) await this.refreshMeta(now, true)
		return suggestAutomations({
			store: this.store, ha: this.ha, states: this.states, meta: this.meta, policy: this.policy, cfg: this.cfg, isNoise: this.isNoise,
			proposals: this.haAdmin.listProposals({ limit: 500 }),
			propose: this.cfg.policy?.admin_enabled ? req => this.createAndNotifyProposal(req) : null,
			now, dry,
		})
	}

	// 새로 생긴 기기 문제(응답 없음·배터리·신호)만 알린다. 조용한 시간이면 다음 날 다시 본다.
	async checkDeviceHealth(now = this.clock()) {
		const report = scanDeviceHealth({ states: this.states, meta: this.meta, now, isNoise: this.isNoise, cfg: this.cfg })
		const lines = newHealthIssues(report, this.runtime.health_seen ?? [])
		if (lines.length && this.isQuiet(now)) return { report, notified: 0, deferred: lines.length }
		this.runtime.health_seen = healthIssueKeys(report)
		this.saveRuntime()
		if (lines.length) {
			await this.notifier.deliver({ kind: 'info', level: 'normal', title: '🔧 기기 점검이 필요해요', message: `${lines.slice(0, 6).join('\n')}${lines.length > 6 ? `\n외 ${lines.length - 6}건` : ''}`.slice(0, 450), related_rule_ids: [] })
		}
		return { report, notified: lines.length }
	}

	// 판정이 난 실험의 후속 조치: 악화 → 규칙 원복 / 제안 롤백 묻기 / 약해진 교훈 끄기, 개선 → 규칙에 검증 표시
	async applyExperimentVerdicts(now = this.clock()) {
		if (!this.store || this.dry) return []
		const done = []
		for (const exp of this.store.unactionedExperiments()) {
			let note = '조치 없음'
			try {
				if (exp.status === 'regressed') {
					if (exp.kind === 'rule') note = await this.#revertRegressedRule(exp, now)
					else if (String(exp.kind).startsWith('proposal:')) note = await this.#offerRollback(exp)
					else if (exp.kind === 'lesson') note = this.#retireWeakLesson(exp, now)
				} else if (exp.status === 'improved') {
					if (exp.kind === 'rule' && this.runtime.rules[exp.ref_id]) {
						this.runtime.rules[exp.ref_id].validated_at = now
						this.saveRuntime()
						note = '검증됨 표시(HA 자동화 승격 후보)'
					} else note = '유지'
				}
			} catch (e) { note = `조치 실패: ${e.message}` }
			this.store.markExperimentActioned(exp.eid, now, note)
			done.push({ eid: exp.eid, kind: exp.kind, ref_id: exp.ref_id, verdict: exp.status, note })
			log(`실험 후속 조치 [${exp.status}] ${exp.title}: ${note}`)
		}
		return done
	}

	async #revertRegressedRule(exp, now) {
		const rid = exp.ref_id
		const rv = exp.baseline_metrics?.revert
		if (!rv) return '되돌릴 이전 판 기록이 없음'
		const cur = this.engine.rules.find(r => r.id === rid)
		if (!cur) return '규칙이 이미 없음'
		if (rv.new_rule && canonical(cur) !== canonical(rv.new_rule)) return '그 뒤 규칙이 다시 바뀌어 되돌리지 않음'
		const rules = rv.prev_rule ? this.engine.rules.map(r => (r.id === rid ? rv.prev_rule : r)) : this.engine.rules.filter(r => r.id !== rid)
		snapshot('rules', this.rulesDoc, now, this.cfg.limits.keep_snapshots)
		this.engine.setRules(rules, this.states, now, rv.prev_rule ? [rid] : [])
		this.rulesDoc = { updated: iso(now), rules }
		writeJson(P.rules, this.rulesDoc)
		this.saveRuntime()
		const how = rv.prev_rule ? '이전 판으로 되돌렸어요' : '추가 전으로 되돌렸어요(규칙 삭제)'
		const why = String(exp.notes ?? '').replace(/ \(악화 감지[^)]*\)/, '')
		await this.notifier.deliver({ kind: 'info', level: 'normal', title: '📉 감시 규칙을 되돌렸어요', message: `${cur.description ?? rid}: 바꾼 뒤 7일 검증에서 나빠져(${why}) ${how}.`.slice(0, 450), related_rule_ids: [] }).catch(() => {})
		return rv.prev_rule ? '이전 판으로 원복' : '새 규칙 삭제'
	}

	async #offerRollback(exp) {
		const p = this.haAdmin.getProposal(exp.ref_id)
		if (!p || !this.haAdmin.canRollback(p)) return '롤백할 수 없는 제안이라 기록만 남김'
		if (this.control.send && this.ha.connected) await this.notifier.send(experimentRegressedPayload(p, exp)).catch(() => {})
		return '롤백 버튼과 함께 되돌릴지 물음'
	}

	#retireWeakLesson(exp, now) {
		const l = this.store.getLesson(exp.ref_id)
		if (!l) return '교훈이 이미 없음'
		if (l.confidence >= 0.35) return `신뢰도를 ${l.confidence}로 낮춤`
		const r = this.store.deleteLesson(exp.ref_id, { source: 'experiment', now })
		return r.ok ? `신뢰도 ${l.confidence}로 낮아 교훈을 끔` : (r.error ?? '교훈을 끄지 못함')
	}

	// 하루 한 번: 실험 평가·후속 조치 → 빠른 경로 회귀 평가 → 기기 건강 → 루틴 자동화 제안
	async runDailyLearning(now = this.clock()) {
		if (this.dry || !this.store || this.dailyRunning) return null
		this.dailyRunning = true
		const out = {}
		try {
			try { evaluateDueExperiments(this.store, now); out.experiments = await this.applyExperimentVerdicts(now) } catch (e) { out.experiments_error = e.message }
			try {
				const reg = this.regressionNow()
				this.runtime.last_regression = { at: iso(now), passed: reg.passed, total: reg.total, failed: reg.failed.slice(0, 5) }
				out.regression = this.runtime.last_regression
			} catch (e) { out.regression_error = e.message }
			try {
				const h = await this.checkDeviceHealth(now)
				out.health = { notified: h.notified, unavailable: h.report.unavailable.length, low_battery: h.report.low_battery.length, weak_signal: h.report.weak_signal.length }
			} catch (e) { out.health_error = e.message }
			if (this.cfg.policy?.admin_enabled && this.ha.connected) {
				try {
					const sg = await this.suggestAutomationsNow({ dry: false, now })
					out.suggest = { candidates: sg.candidates.length, eligible: sg.candidates.filter(c => ['eligible', 'proposed'].includes(c.status)).length, created: sg.created.map(p => p.title) }
				} catch (e) { out.suggest_error = e.message }
			}
			this.saveRuntime()
		} finally { this.dailyRunning = false }
		log(`하루 자가개선 작업: ${JSON.stringify(out).slice(0, 400)}`)
		return out
	}

	saveRuntime() { if (!this.dry) writeJson(P.runtime, this.runtime) }
}
