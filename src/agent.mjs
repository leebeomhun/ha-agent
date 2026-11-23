// 집 비서 본체: HA 실시간 감시(규칙·이상탐지), Assist 대화 서버, PolicyEngine, ToolBroker, HaAdmin, LLM 라우터를 통합 조율한다.
import { readdirSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { HA } from './ha.mjs'
import { RuleEngine, validateRule } from './rules.mjs'
import { compactStates, automationList, notableChange, significantChange, buildPrompt } from './context.mjs'
import { runBrain, brainMode, brainSettings, validateResponse, selfCheck, normalizeMode, MODES, MODE_LABEL } from './brain.mjs'
import { feedbackPayload, proposalApprovalPayload, proposalResultPayload, ACTION_RE, REPLY_ACTION, TAG_PREFIX } from './notify.mjs'
import { PolicyEngine } from './core/policy.mjs'
import { Store } from './core/store.mjs'
import { MemoryManager } from './core/memory.mjs'
import { AnomalyEngine } from './engine/anomaly.mjs'
import { HaAdmin } from './admin/ha-admin.mjs'
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
import { P, DAY, readJson, writeJson, appendJsonl, readJsonlAll, readJsonlCached, latestBy, kst, fmt, newId, log, expandHome, globs } from './util.mjs'
import { loadConfig, loadControl } from './config.mjs'

const MIN = 60000
const iso = ms => new Date(ms).toISOString()
// HA 연결이 끊겨서 난 오류(src/ha.mjs가 끊길 때 대기 중인 호출을 이 이유로 거절한다). 자료를 다 못 받은 판단은 다시 연결된 뒤로 미룬다.
const CONN_ERR = /^(HA 연결 없음|응답 없음|연결 (끊김|실패|오류|시간 초과)|초기화 실패|인증 실패)/
const MAX_DEFERS = 3
const sysKey = x => `${x.level ?? ''}|${x.name ?? ''}|${x.message ?? ''}`
const repairKey = r => `${r.domain ?? ''}:${r.id ?? ''}`
export const PUBLISH_SERVICE = 'persistent_notification.create'

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
		this.ha = ha ?? new HA({
			url: this.cfg.ha_ws_url, tokenFile: expandHome(this.cfg.token_file), notifyTargets: this.cfg.notify_targets,
			actionEntities: [...this.tiers.keys()],
			services: this.cfg.weekly.publish ? [PUBLISH_SERVICE] : [],
			policy: this.policy,
		})
		this.states = new Map()
		const initEvents = dry ? [] : readJsonlAll(P.events)
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
		this.pendingActs = dry ? [] : latestBy(readJsonlAll(P.actions), 'aid').filter(a => a.status === 'pending')
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
		this.lastRun = dry ? null : readJsonlAll(P.decisions).at(-1) ?? null
		this.preAt = new Map()
		this.meta = { at: 0, areaOf: null, catOf: null, autoCfg: null }
		this.lastBeat = 0
		this.lastRefresh = 0
		this.downSince = null
		this.downNotified = false
		this.startupProblem = null
		this.sessionLocks = new Map()
		this.cycleChain = Promise.resolve()

		this.memoryMgr = new MemoryManager({ store: this.store })
		this.anomaly = new AnomalyEngine({ store: this.store, isNoise: this.isNoise })
		this.sessions = new SessionManager({ store: this.store })
		this.llmRouter = new LlmRouter({ cfg: this.cfg, brainFn: this.brain, canUse: this.canUse })
		this.haAdmin = new HaAdmin({
			cfg: this.cfg, ha: this.ha, store: this.store, states: this.states, meta: this.meta, memory: this.memoryMgr,
			onRulePromoted: async ruleId => this.#removePromotedRule(ruleId),
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
	}
	start() {
		this.attach()
		this.ha.start()
		if (this.assistServer) this.assistServer.start().catch(e => log('Assist 서버 시작 실패:', e.message))
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
			last_run: this.lastRun ? { ts: this.lastRun.ts, summary: this.lastRun.summary, error: this.lastRun.error } : null,
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
			const isNoise = this.isNoise(c.id)
			const bucket = isNoise ? this.noiseRing : this.ring
			bucket.push(c)
			if (bucket.length > 300) bucket.shift()
			appendJsonl(P.events, c)
			this.store?.recordEvent({ ...c, isNoise })
		}
		if (n) this.anomaly.onNumericState(id, n, now)
		const fired = this.engine.onState(id, n, now, this.states)
		if (fired.length) { this.saveRuntime(); this.#handleFired(fired) }
	}

	#notes() { return latestBy(readJsonlCached(P.notifications), 'nid') }

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
		const rec = this.#notes().reverse().find(r => r.nid === nid)
		if (!rec) return log('버튼: 알림 기록을 찾지 못함', nid)
		const now = this.clock()
		const muted = []
		if (kind === 'MUTE') {
			for (const id of rec.related_rule_ids ?? []) if (this.engine.mute(id, now + this.cfg.limits.mute_days * DAY)) muted.push(id)
			this.saveRuntime()
		}
		const dup = readJsonlCached(P.feedback).some(f => f.nid === nid && f.kind === kind.toLowerCase())
		if (!dup) {
			const fbRec = { ts: iso(now), nid, kind: kind.toLowerCase(), title: rec.title, ...(kind === 'LESS' ? { message: String(rec.message ?? '').slice(0, 300) } : {}), rules: rec.related_rule_ids ?? [], muted }
			appendJsonl(P.feedback, fbRec)
			this.store?.recordFeedback(fbRec)
		}
		log(`버튼 ${kind}: ${rec.title}${muted.length ? ` (규칙 쉼: ${muted.join(', ')})` : ''}`)
		const descs = muted.map(id => this.engine.rules.find(r => r.id === id)?.description).filter(Boolean)
		await this.notifier.send(feedbackPayload(rec, kind, descs, this.cfg.limits.mute_days))
	}

	async #onReply(d) {
		const text = String(d.reply_text ?? '').trim().slice(0, 500)
		const nid = d.action_data?.nid, tag = typeof d.tag === 'string' ? d.tag : null
		const rec = this.#notes().reverse().find(r => (nid && r.nid === nid) || (tag && r.tag === tag))
		if (!text || !(rec || tag?.startsWith(TAG_PREFIX))) return
		if (!this.dry) this.control = loadControl()
		if (this.control.paused) {
			log(`일시정지 중이라 답장을 처리하지 않음: "${text}"`)
			if (rec) await this.notifier.send(feedbackPayload(rec, 'PAUSED')).catch(() => {})
			return
		}
		const now = this.clock()
		const fbRec = { ts: iso(now), nid: rec?.nid ?? null, kind: 'reply', title: rec?.title ?? '', text, rules: rec?.related_rule_ids ?? [] }
		appendJsonl(P.feedback, fbRec)
		this.store?.recordFeedback(fbRec)
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
			if (expiredProps.length && this.control.send && this.ha.connected) {
				for (const p of expiredProps) await this.notifier.send(proposalResultPayload(p)).catch(() => {})
			}
		}
		await this.notifier.flushOutbox(now)
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
						writeDaily(prev)
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
				const base = {
					now: started, quiet: this.isQuiet(started), reasons,
					rules: this.engine.rules, runtime: this.runtime.rules, schedule: this.schedule,
					memory: this.memoryMgr.renderForPrompt(this.cfg.limits.memory_chars),
					homeProfile: this.memoryMgr.loadHomeProfile(),
					recentNotes: this.#notes().filter(n => started - Date.parse(n.ts) < DAY),
					feedback: readJsonlCached(P.feedback).filter(f => started - Date.parse(f.ts) < 7 * DAY),
					held: heldItems, rejected: readJson(P.rejected, []),
					pendingProposals: this.haAdmin.listProposals({ status: 'pending', limit: 10 }),
					ring: [...this.ring, ...this.noiseRing].sort((a, b) => a.t - b.t),
					weather: ctx.weather, calendar: ctx.calendar,
					actions: this.actionExecutor.actionContext(), metrics: deep ? weekMetrics(started) : null, lastReport,
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
				let infoFiles = [], res
				entry.codex_ms = 0
				this.runAbort = new AbortController()
				const toolContext = {
					allowDirectRequest: reasons.some(r => r.type === 'user'),
					adminEnabled: Boolean(this.cfg.policy?.admin_enabled),
					source: reasons.map(r => r.type).join('+'),
				}
				try {
					for (let round = 1; ; round++) {
						const lastRound = round >= this.cfg.limits.max_rounds
						const prompt = buildPrompt({ ...base, guide, infoFiles, lastRound })
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
						if (!res.info_requests.length || lastRound) break
						const more = await this.#fetchInfo(res.info_requests, infoFiles.length)
						if (!more.length) break
						infoFiles = [...infoFiles, ...more]
					}
				} finally { this.runAbort = null }
				if (infoFiles.length) entry.info = infoFiles.map(h => `${h.kind}:${h.entity_ids.join(',')}`)
				if (weekly && !res.report) throw new Error('주간 분석인데 report가 비어 있음')
				entry.summary = res.summary
				const failedBefore = this.failures
				this.failures = 0
				this.lastFailedMode = null
				if (mode !== primary && !this.failover) await this.#startFailover(primary, mode, started, failedBefore)
				entry.applied = await this.#apply(res, reasons)
				this.#commitSysDelta(ctx)
			}
		} catch (e) {
			entry.error = e.message
			this.failures++
			this.lastError = e.message
			if (mode) this.lastFailedMode = mode
			if (mode && mode !== primary) this.failover = null
			if (!this.dry) await this.#onFailure(reasons, e, mode)
		}
		entry.total_ms = this.clock() - started
		this.lastRun = entry
		if (!this.dry) {
			appendJsonl(P.decisions, entry)
			this.store?.recordDecision(entry)
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
		const sinceMs = this.clock() - hours * 3600000
		if (this.store) return this.store.recentNotifications({ sinceMs, limit })
		return latestBy(readJsonlCached(P.notifications), 'nid').filter(n => Date.parse(n.ts) >= sinceMs).slice(-limit)
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
				rollback: res.proposal.status === 'applied' && this.haAdmin.isRollbackable(res.proposal),
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
		const quietHouse = !this.ring.some(c => c.t > since && significantChange(c, this.isNoise)) && !readJsonlCached(P.feedback).some(f => Date.parse(f.ts) > since)
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
			this.meta.autoCfg = autoCfg
		} catch (e) { log('영역·자동화 정보를 가져오지 못함:', e.message) }
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

	async #apply(res, reasons) {
		const now = this.clock(), keep = this.cfg.limits.keep_snapshots
		const out = { added: [], changed: [], deleted: [], rejected: [], wakes: [], memory: res.memory.mode, actions: [], proposals: [], notifications: [] }
		let rules = [...this.engine.rules]
		for (const id of res.rule_changes.delete) {
			if (rules.some(r => r.id === id)) { rules = rules.filter(r => r.id !== id); out.deleted.push(id) }
		}
		for (const raw of res.rule_changes.upsert) {
			const v = validateRule(raw, this.states)
			if (!v.ok) { out.rejected.push({ rule: raw?.id ?? null, error: v.error }); continue }
			const i = rules.findIndex(r => r.id === v.rule.id)
			if (i >= 0) { rules[i] = v.rule; out.changed.push(v.rule.id) }
			else if (rules.length >= this.cfg.limits.max_rules) out.rejected.push({ rule: v.rule.id, error: `규칙은 ${this.cfg.limits.max_rules}개까지` })
			else { rules.push(v.rule); out.added.push(v.rule.id) }
		}
		const wakes = []
		for (const w of res.next_wakes) {
			const at = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(w.at) ? w.at : `${w.at}+09:00`)
			if (!Number.isFinite(at) || at < now + 60000 || at > now + 48 * 3600000) { out.rejected.push({ wake: w.at, error: '시각은 지금부터 1분~48시간 사이, ISO 형식' }); continue }
			wakes.push({ at: iso(at), reason: w.reason })
		}
		if (this.dry) {
			out.preview = { rules: rules.filter(r => out.added.includes(r.id) || out.changed.includes(r.id)), wakes, memory: res.memory, memory_ops: res.memory_ops, actions: res.actions, proposals: res.proposals, notifications: res.notifications, report: res.report || undefined }
			return out
		}
		if (out.added.length || out.changed.length || out.deleted.length || !this.rulesDoc) {
			snapshot('rules', this.rulesDoc, now, keep)
			this.engine.setRules(rules, this.states, now, [...out.added, ...out.changed])
			this.rulesDoc = { updated: iso(now), rules }
			writeJson(P.rules, this.rulesDoc)
			this.saveRuntime()
		}
		this.schedule = [...this.schedule, ...wakes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, this.cfg.limits.max_pending_wakes)
		writeJson(P.schedule, this.schedule)
		out.wakes = wakes.map(w => fmt(Date.parse(w.at)))
		this.memoryMgr.applyLegacy(res.memory, out, now, { dry: this.dry, max: this.cfg.limits.memory_chars, keepSnapshots: keep })
		if (res.memory_ops?.length) this.memoryMgr.applyOps(res.memory_ops, { source: 'cycle', now })
		const notes = [...res.notifications]
		out.actions = await this.actionExecutor.applyActions(res.actions, out, reasons)
		const rejectedProposals = []
		for (const p of res.proposals ?? []) {
			const pr = await this.createAndNotifyProposal(p)
			if (pr.ok) out.proposals.push(`${pr.proposal.pid}:${pr.proposal.title}`)
			else {
				out.rejected.push({ proposal: p.title, error: pr.error })
				rejectedProposals.push({ title: p.title, error: pr.error })
			}
		}
		if (res.report) {
			if (reasons.some(r => r.type === 'weekly')) {
				const reportText = rejectedProposals.length
					? `${res.report}\n\n> ⚠️ 참고: 아래 승인안은 사전 검증을 통과하지 못해 승인 대기 목록에 등록되지 않았어요.\n${rejectedProposals.map(r => `- ${r.title}: ${r.error}`).join('\n')}`
					: res.report
				out.report = saveWeekly(kst(new Date(now)).date, reportText, this.cfg.limits.keep_weekly)
				out.published = await this.#publishWeekly(out.report, reportText)
				if (!notes.length) notes.push({ kind: 'info', level: 'normal', title: '📊 주간 자동화 분석이 나왔어요', message: `${res.summary.slice(0, 300)} ${out.published ? '전문은 HA 앱의 알림(🔔)에서 볼 수 있어요.' : '전문: node src/cli.mjs weekly'}`, related_rule_ids: [] })
			} else out.rejected.push({ report: true, error: 'report는 주간 분석(weekly) 깨움에서만 쓴다' })
		}
		for (const n of notes) out.notifications.push(await this.notifier.deliver(n, reasons))
		writeJson(P.rejected, out.rejected)
		const tested = await this.#backtest([...out.added, ...out.changed], now)
		if (tested.length) out.backtest = tested
		return out
	}

	async #backtest(ids, now) {
		if (!this.cfg.rule_backtest || !ids.length) return []
		const rules = this.engine.rules.filter(r => ids.includes(r.id) && backtestable(r))
		if (!rules.length) return []
		const hours = 168
		let hist
		try { hist = await this.ha.history([...new Set(rules.flatMap(r => [r.entity_id, ...(r.also ?? []).map(c => c.entity_id)]))], hours) } catch (e) { log('규칙 백테스트용 기록을 받지 못함:', e.message); return [] }
		const out = []
		for (const r of rules) {
			try {
				const b = backtestRule(r, hist, now - hours * 3600000, now)
				if (!b || !this.runtime.rules[r.id]) continue
				this.runtime.rules[r.id].backtest = b
				out.push(`${r.id}: 지난 ${b.days}일 기록으로 ${b.fires}회`)
			} catch (e) { log(`규칙 백테스트 실패(${r.id}):`, e.message) }
		}
		if (out.length) { this.saveRuntime(); log('규칙 백테스트:', out.join(' · ')) }
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

	saveRuntime() { if (!this.dry) writeJson(P.runtime, this.runtime) }
}
