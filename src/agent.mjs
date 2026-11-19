// 집 비서 본체: HA를 실시간으로 보고(규칙), 필요할 때 AI(Codex 또는 API)를 깨워 판단을 받고, 검사한 뒤 적용한다.
import { readdirSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { HA } from './ha.mjs'
import { RuleEngine, validateRule } from './rules.mjs'
import { compactStates, automationList, notableChange, significantChange, buildPrompt } from './context.mjs'
import { runBrain, brainMode, brainSettings, validateResponse, selfCheck, MODES, MODE_LABEL } from './brain.mjs'
import { buildPayload, feedbackPayload, approvalPayload, actionResultPayload, recoveredPayload, tagFor, ACTION_RE, REPLY_ACTION, TAG_PREFIX } from './notify.mjs'
import { actionTiers, checkAction, opposite, reached } from './actions.mjs'
import { sendOob } from './oob.mjs'
import { archiveRun, snapshot, readSnapshot, writeDaily, recentDaily, weekMetrics, rotateLogs, saveWeekly, readWeekly } from './records.mjs'
import { automationRuns, deviceActivity, DEVICE_DOMAINS, WEEKLY_HOURS } from './weekly.mjs'
import { backtestRule, backtestable } from './backtest.mjs'
import { P, DAY, readJson, writeJson, appendJsonl, readJsonl, latestBy, kst, fmt, newId, log, expandHome, globs } from './util.mjs'
import { loadConfig, loadControl } from './config.mjs'

const MIN = 60000
const iso = ms => new Date(ms).toISOString()
// HA 연결이 끊겨서 난 오류(src/ha.mjs가 끊길 때 대기 중인 호출을 이 이유로 거절한다). 자료를 다 못 받은 판단은 다시 연결된 뒤로 미룬다.
const CONN_ERR = /^(HA 연결 없음|응답 없음|연결 (끊김|실패|오류|시간 초과)|초기화 실패|인증 실패)/
// 연결 때문에 판단을 미루는 것은 깨움마다 이 횟수까지. 그 뒤에는 받은 자료만으로 판단한다(끝없이 미루지 않게).
const MAX_DEFERS = 3
// 보내지 못한 정각 요약은 이 시간까지만 다시 보낸다. 그 뒤에는 낡은 내용이라 버린다.
const SUMMARY_RETRY_MS = 60 * MIN
const round2 = v => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
// 주간 보고서 전문을 HA 알림 목록(🔔)에 올릴 때 쓰는 서비스. 이것 말고 HA에 글을 쓰는 서비스는 허용하지 않는다.
export const PUBLISH_SERVICE = 'persistent_notification.create'

export class Agent {
	// ha·brain·oob·clock·canUse는 시험에서 가짜로 바꿔 끼운다.
	constructor({ dry = false, cfg, ha, brain, oob, clock, beat, canUse } = {}) {
		this.cfg = cfg ?? loadConfig()
		this.control = loadControl()
		this.dry = dry
		this.clock = clock ?? Date.now
		this.brain = brain ?? runBrain
		this.oob = oob ?? sendOob
		this.beat = beat ?? (() => {})
		// 판단 방식을 쓸 수 있는지(Codex 실행 파일·API 키). 다른 방식으로 넘어갈 수 있는지 볼 때 쓴다.
		this.canUse = canUse ?? ((c, mode) => !selfCheck(c, mode))
		this.isNoise = globs(this.cfg.noise_entities)
		this.tiers = actionTiers(this.cfg)
		this.ha = ha ?? new HA({
			url: this.cfg.ha_ws_url, tokenFile: expandHome(this.cfg.token_file), notifyTargets: this.cfg.notify_targets, actionEntities: [...this.tiers.keys()],
			services: this.cfg.weekly.publish ? [PUBLISH_SERVICE] : [],
		})
		this.states = new Map()
		this.ring = dry ? [] : readJsonl(P.events).slice(-300)
		this.rulesDoc = readJson(P.rules, null)
		this.runtime = readJson(P.runtime, { rules: {}, last_checkin: null })
		this.runtime.rules ??= {}
		this.engine = new RuleEngine(this.rulesDoc?.rules ?? [], this.runtime.rules)
		this.schedule = readJson(P.schedule, [])
		this.held = readJson(P.held, [])
		this.counters = readJson(P.counters, null)
		this.outbox = dry ? [] : readJson(P.outbox, [])
		this.pendingActs = dry ? [] : latestBy(readJsonl(P.actions), 'aid').filter(a => a.status === 'pending')
		// 대기열은 파일에 남는다. 꺼질 때 돌던 판단(inflight)은 시도 횟수를 하나 올려 다시 넣는다.
		const saved = dry ? {} : readJson(P.queue, {})
		this.queue = [...(saved.inflight ?? []).map(r => ({ ...r, attempts: (r.attempts ?? 0) + 1 })), ...(saved.queue ?? [])]
			.filter(r => (r.attempts ?? 0) < this.#maxAttempts(r))
		this.inflight = []
		this.running = false
		this.lastRunEnd = 0
		this.failures = 0
		this.failover = null // 다른 판단 방식으로 넘어가 있는 동안 { primary, until }
		this.lastFailedMode = null
		this.lastRun = dry ? null : readJsonl(P.decisions).at(-1) ?? null
		this.preAt = new Map()
		this.meta = { at: 0, areaOf: null, autoCfg: null }
		this.lastBeat = 0
		this.lastRefresh = 0
		this.downSince = null
		this.downNotified = false
		this.startupProblem = null
	}

	attach() {
		this.ha.on('ready', list => this.#onReady(list))
		this.ha.on('state', d => this.#onState(d))
		this.ha.on('action', d => this.#onAction(d).catch(e => log('버튼 처리 실패:', e.message)))
	}
	start() {
		this.attach()
		this.ha.start()
		if (!this.dry) this.timer = setInterval(() => this.tick().catch(e => log('tick 오류:', e.stack)), 15000)
	}
	stop() { clearInterval(this.timer); this.ha.stop() }
	waitReady() { return new Promise(res => this.ha.once('ready', () => setImmediate(res))) }

	// ── HA 이벤트 ──
	#onReady(list) {
		this.states.clear()
		for (const s of list) this.states.set(s.entity_id, s)
		this.lastRefresh = this.clock()
		log(`HA 연결됨: 엔티티 ${list.length}개, 규칙 ${this.engine.rules.length}개`)
		if (this.dry) return
		const fired = this.engine.initAll(this.states, this.clock())
		this.#saveRuntime()
		this.#handleFired(fired)
		if (!this.rulesDoc && !this.queue.some(r => r.type === 'bootstrap')) this.#enqueue({ type: 'bootstrap' })
		if (this.startupProblem) {
			const message = `시작 점검에서 문제가 보여요: ${this.startupProblem}`.slice(0, 400)
			this.startupProblem = null
			this.#deliver({ kind: 'info', level: 'normal', title: '🤖 집 비서 설정 문제', message, related_rule_ids: [] }).catch(e => log('알림 실패:', e.message))
		}
	}

	#onState(d) {
		const id = d.entity_id, n = d.new_state
		if (n) this.states.set(id, n)
		else this.states.delete(id)
		if (this.dry) return
		const c = notableChange(d)
		if (c) {
			this.ring.push(c)
			if (this.ring.length > 300) this.ring.shift()
			appendJsonl(P.events, c)
		}
		const fired = this.engine.onState(id, n, this.clock(), this.states)
		if (fired.length) { this.#saveRuntime(); this.#handleFired(fired) }
	}

	#notes() { return latestBy(readJsonl(P.notifications), 'nid') }

	async #onAction(d) {
		if (this.dry) return
		const a = d?.action ?? ''
		if (a === REPLY_ACTION) return this.#onReply(d)
		const m = ACTION_RE.exec(a)
		if (!m) return
		const [, kind, nid] = m
		if (kind === 'DO' || kind === 'NO' || kind === 'UNDO') return this.#onActionButton(kind, nid)
		const rec = this.#notes().reverse().find(r => r.nid === nid)
		if (!rec) return log('버튼: 알림 기록을 찾지 못함', nid)
		const now = this.clock()
		const muted = []
		if (kind === 'MUTE') {
			for (const id of rec.related_rule_ids ?? []) if (this.engine.mute(id, now + this.cfg.limits.mute_days * DAY)) muted.push(id)
			this.#saveRuntime()
		}
		const dup = readJsonl(P.feedback).some(f => f.nid === nid && f.kind === kind.toLowerCase())
		// [줄여 줘]는 요약에 단다. 무엇이 과했는지 돌아보기가 따질 수 있게 그 요약의 내용도 남긴다.
		if (!dup) appendJsonl(P.feedback, { ts: iso(now), nid, kind: kind.toLowerCase(), title: rec.title, ...(kind === 'LESS' ? { message: String(rec.message ?? '').slice(0, 300) } : {}), rules: rec.related_rule_ids ?? [], muted })
		log(`버튼 ${kind}: ${rec.title}${muted.length ? ` (규칙 쉼: ${muted.join(', ')})` : ''}`)
		const descs = muted.map(id => this.engine.rules.find(r => r.id === id)?.description).filter(Boolean)
		await this.#send(feedbackPayload(rec, kind, descs, this.cfg.limits.mute_days))
	}

	// 알림의 [답장]으로 온 말. REPLY는 다른 자동화도 쓸 수 있는 이름이라, 우리 알림에 단 답장만 받는다.
	async #onReply(d) {
		const text = String(d.reply_text ?? '').trim().slice(0, 500)
		const nid = d.action_data?.nid, tag = typeof d.tag === 'string' ? d.tag : null
		const rec = this.#notes().reverse().find(r => (nid && r.nid === nid) || (tag && r.tag === tag))
		if (!text || !(rec || tag?.startsWith(TAG_PREFIX))) return
		const now = this.clock()
		appendJsonl(P.feedback, { ts: iso(now), nid: rec?.nid ?? null, kind: 'reply', title: rec?.title ?? '', text, rules: rec?.related_rule_ids ?? [] })
		log(`답장: "${text}"${rec ? ` ← ${rec.title}` : ''}`)
		this.#enqueue({ type: 'user', text, about: rec?.title ?? null, urgent: true, at: now })
		if (rec) await this.#send(feedbackPayload(rec, 'REPLY'))
	}

	// ── 규칙 발동과 깨움 대기열 ──
	#quiet(now = this.clock()) {
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
			else if (this.#quiet(now)) {
				this.held = this.held.filter(h => !(h.type === 'rule' && h.rule_id === r.rule_id))
				this.held.push(r)
				writeJson(P.held, this.held)
			} else this.#enqueue({ ...r, notBefore: now + this.cfg.limits.rule_batch_seconds * 1000 })
		}
	}

	// urgent 규칙은 Codex를 기다리지 않고 규칙 설명을 바로 보낸다. Codex의 후속 알림은 같은 tag라 이 알림을 덮어쓴다.
	#preNotify(r, now) {
		if (now - (this.preAt.get(r.rule_id) ?? 0) < 10 * MIN) return false
		this.preAt.set(r.rule_id, now)
		this.#deliver(this.#ruleAlert(r, 'urgent', '집 비서가 상황을 확인하고 있어요.')).catch(e => log('긴급 알림 실패:', e.message))
		return true
	}

	#ruleAlert(r, level, tail) {
		const name = this.states.get(r.entity_id)?.attributes?.friendly_name ?? r.entity_id
		return { kind: 'alert', level, title: `⚠️ ${r.description}`.slice(0, 60), message: `${name}: 지금 ${r.value}. ${tail}`, related_rule_ids: [r.rule_id] }
	}

	#maxAttempts(r) { return ['rule', 'user'].includes(r.type) ? this.cfg.limits.max_attempts : 2 }

	#saveQueue() { if (!this.dry) writeJson(P.queue, { queue: this.queue, inflight: this.inflight }) }

	#enqueue(r) {
		if (r.type === 'rule' && this.queue.some(q => q.type === 'rule' && q.rule_id === r.rule_id)) return
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
		this.#todayCounters()
		if (this.ha.connected) {
			const fired = this.engine.tick(this.states, now)
			if (fired.length) { this.#saveRuntime(); this.#handleFired(fired) }
		}
		this.#watchHa(now)
		this.#heartbeat(now)
		await this.#remindUrgent(now)
		if (!this.#quiet(now) && this.held.length && !this.#overLimit() && !this.inflight.some(r => r.type === 'held')) this.#enqueue({ type: 'held' })
		const due = this.schedule.filter(w => Date.parse(w.at) <= now)
		if (due.length) {
			// 대기열(파일)에 먼저 넣고 예약에서 뺀다. 그 사이에 꺼져도 잃지 않는다.
			for (const w of due) this.#enqueue({ type: 'scheduled', reason: w.reason, at: Date.parse(w.at) })
			this.schedule = this.schedule.filter(w => Date.parse(w.at) > now)
			writeJson(P.schedule, this.schedule)
		}
		// 정각 점검은 활동 시간 안의 매시, 하루 돌아보기는 reflection_hour에(활동 시간 밖이어도) 돈다.
		const key = `${k.date}T${String(k.h).padStart(2, '0')}`
		const reflect = k.h === this.cfg.reflection_hour
		if ((reflect || (this.cfg.hourly_checkin && this.#checkinHours().includes(k.h))) && k.mi < 10 && this.runtime.last_checkin !== key) {
			this.runtime.last_checkin = key
			this.#saveRuntime()
			this.#enqueue({ type: reflect ? 'reflection' : 'hourly', hour: k.h === 0 ? 24 : k.h })
		}
		// 주간 분석: 정한 요일의 정한 시각부터 그날 안에 한 번. 그 시각에 꺼져 있었어도 그날 다시 켜지면 돈다.
		const w = this.cfg.weekly
		if (w.enabled && k.wd === w.weekday && k.h >= w.hour && this.runtime.last_weekly !== k.date) {
			this.runtime.last_weekly = k.date
			this.#saveRuntime()
			this.#enqueue({ type: 'weekly' })
		}
		this.#readInbox()
		await this.#expireActions(now)
		await this.#flushOutbox(now)
		await this.#refreshStates(now)
		await this.#maybeRun()
	}

	#readInbox() {
		let files = []
		try { files = readdirSync(P.inbox).sort() } catch { return }
		for (const f of files) {
			const p = join(P.inbox, f)
			const c = readJson(p, null)
			// 이전 판 되돌리기는 엔티티 목록이 있어야 검사할 수 있으니 HA에 연결된 뒤에 한다.
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
			this.#saveRuntime()
		} else {
			snapshot('memory', existsSync(P.memory) ? readFileSync(P.memory, 'utf8') : '', now, keep)
			writeFileSync(P.memory, content)
		}
		log(`이전 판으로 되돌림: ${name}`)
	}

	#todayCounters() {
		const d = kst(new Date(this.clock())).date
		if (this.counters?.date !== d) {
			const prev = this.counters?.date
			this.counters = { date: d, runs: 0, alerts: 0, summaries: 0, actions: 0, error_notice: false }
			if (!this.dry) {
				writeJson(P.counters, this.counters)
				// 날짜가 바뀌면 전날 하루 요약을 남기고 커진 기록 파일을 정리한다.
				if (prev) try { writeDaily(prev); rotateLogs() } catch (e) { log('하루 정리 실패:', e.message) }
			}
		}
		this.counters.actions ??= 0
		return this.counters
	}
	#bump(k) {
		this.#todayCounters()[k]++
		if (!this.dry) writeJson(P.counters, this.counters)
	}
	// 하루 판단 한도. 사용자가 직접 한 말·수동 깨움에는 한도 뒤에도 조금 더 답한다(user_reserve_runs).
	#overLimit(reasons = []) {
		const l = this.cfg.limits
		const reserve = reasons.some(r => r.type === 'user' || r.type === 'manual') ? l.user_reserve_runs : 0
		return this.#todayCounters().runs >= l.brain_runs_per_day + reserve
	}

	async #maybeRun() {
		if (this.running || !this.ha.connected || !this.queue.length || this.control.paused) return
		const now = this.clock()
		let ready = this.queue.filter(r => (r.notBefore ?? 0) <= now)
		if (!ready.length) return
		// 판단이 연달아 실패하면 간격을 늘린다(3분 → 6 → 12 … 최대 48분). 급한 깨움은 기다리지 않는다.
		const gap = this.cfg.limits.min_gap_minutes * MIN * Math.min(2 ** this.failures, 16)
		if (!ready.some(r => r.urgent) && now - this.lastRunEnd < gap) return
		// 주간 분석은 오래 걸리므로 다른 깨움과 섞지 않는다. 다른 것부터 하고 다음 차례에 혼자 돈다.
		if (ready.some(r => r.type !== 'weekly')) ready = ready.filter(r => r.type !== 'weekly')
		this.queue = this.queue.filter(r => !ready.includes(r))
		ready = ready.filter(r => r.type !== 'held' || this.held.length)
		if (!ready.length) return this.#saveQueue()
		if (this.#overLimit(ready)) {
			// 주간 분석은 한 주에 한 번뿐이라 버리지 않고 한 시간 뒤로 미룬다.
			for (const r of ready.filter(r => r.type === 'weekly')) this.queue.push({ ...r, urgent: false, notBefore: now + 3600000 })
			this.#saveQueue()
			log(`오늘 판단 한도(${this.cfg.limits.brain_runs_per_day}회)에 닿아 건너뜀:`, ready.map(r => r.type).join(', '))
			await this.#fallback(ready, '오늘 판단 한도에 닿아')
			// 사용자가 한 말을 말없이 버리지 않는다.
			for (const r of ready.filter(r => r.type === 'user')) {
				await this.#deliver({ kind: 'info', level: 'normal', title: '🤖 오늘은 더 답하지 못해요', message: `오늘 판단 한도를 다 써서 "${String(r.text).slice(0, 80)}"에 답하지 못했어요. 내일 다시 말해 주세요. (한도: config.json의 limits.brain_runs_per_day)`, related_rule_ids: [] }, ready)
			}
			return
		}
		// 밤사이 보류분은 판단이 성공한 뒤에만 지운다.
		const heldItems = ready.some(r => r.type === 'held') ? [...this.held] : []
		this.inflight = ready
		this.#saveQueue()
		this.running = true
		try {
			const entry = await this.cycle(ready, heldItems)
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
		const entry = { ts: iso(started), reasons: reasons.map(r => r.type + (r.rule_id ? `:${r.rule_id}` : '')), dry: this.dry }
		const rounds = []
		let input = null, mode = null, primary = null
		try {
			const ctx = await this.#gather(started)
			const lost = this.#connectionLost(ctx)
			if (!this.dry && lost && reasons.every(r => (r.defers ?? 0) < MAX_DEFERS)) {
				// 판단 실패가 아니다: 시도 횟수를 올리지 않고 그대로 다시 넣는다. #maybeRun은 연결된 뒤에만 돈다.
				entry.deferred = true
				entry.summary = `HA 연결이 끊겨 자료를 다 받지 못해(${lost}) 다시 연결된 뒤 판단`
				this.queue.push(...reasons.map(r => ({ ...r, defers: (r.defers ?? 0) + 1 })))
				this.#saveQueue()
			} else if (!this.dry && this.#unchangedHourly(reasons, ctx, started)) {
				entry.skipped = true
				entry.summary = '직전 정각 점검 뒤로 달라진 것이 없어 판단을 건너뜀'
			} else {
				if (!this.dry) this.#bump('runs')
				const lastReport = this.#writeRunFiles(ctx)
				if (weekly) await this.#writeWeeklyFiles(ctx, started)
				const base = {
					now: started, quiet: this.#quiet(started), reasons,
					rules: this.engine.rules, runtime: this.runtime.rules, schedule: this.schedule,
					memory: existsSync(P.memory) ? readFileSync(P.memory, 'utf8') : '',
					// "오늘"이 아니라 최근 24시간: 00시 돌아보기와 아침 첫 점검이 전날 알림을 볼 수 있어야 한다.
					recentNotes: this.#notes().filter(n => started - Date.parse(n.ts) < DAY),
					feedback: readJsonl(P.feedback).filter(f => started - Date.parse(f.ts) < 7 * DAY),
					held: heldItems, rejected: readJson(P.rejected, []), ring: this.ring, weather: ctx.weather, calendar: ctx.calendar,
					actions: this.#actionContext(), metrics: deep ? weekMetrics(started) : null, lastReport,
					hours: { ...this.cfg.active_hours, checkins: this.cfg.hourly_checkin ? this.#checkinHours().map(h => (h === 0 ? 24 : h)) : [], reflection: this.cfg.reflection_hour },
					noise: this.cfg.noise_entities,
				}
				input = JSON.stringify(base)
				const guide = readFileSync(P.guide, 'utf8')
				// 판단 방식(codex·api)은 판단을 시작할 때 정하고, 추가 자료를 받아 다시 물을 때도 그대로 쓴다.
				// 고른 방식이 연달아 실패했으면 다른 방식으로 넘어간다(#pickMode).
				primary = brainMode(this.cfg, this.control)
				mode = this.#pickMode(primary, started)
				const bs = brainSettings(this.cfg, mode)
				entry.brain = mode
				if (mode !== primary) entry.failover = true
				const effort = deep ? bs.effort_deep : bs.effort
				const timeoutSec = weekly ? this.cfg.weekly.timeout_seconds : deep ? bs.timeout_deep_seconds : bs.timeout_seconds
				const model = mode === primary && this.failures >= 2 && bs.fallback_model ? bs.fallback_model : bs.model
				if (model !== bs.model) entry.model = model
				let infoFiles = [], res
				entry.codex_ms = 0
				for (let round = 1; ; round++) {
					const lastRound = round >= this.cfg.limits.max_rounds
					const prompt = buildPrompt({ ...base, guide, infoFiles, lastRound })
					const r = await this.brain({ cfg: this.cfg, mode, prompt, effort, timeoutSec, model })
					rounds.push({ prompt, answer: r.result })
					res = validateResponse(r.result)
					entry.rounds = round
					entry.codex_ms += r.ms ?? 0
					if (r.tokens) entry.tokens = (entry.tokens ?? 0) + r.tokens
					if (!res.info_requests.length || lastRound) break
					const more = await this.#fetchInfo(res.info_requests, infoFiles.length)
					if (!more.length) break
					infoFiles = [...infoFiles, ...more]
				}
				if (infoFiles.length) entry.info = infoFiles.map(h => `${h.kind}:${h.entity_ids.join(',')}`)
				// 보고서 없이 끝난 주간 분석은 실패로 보고 다시 시도한다.
				if (weekly && !res.report) throw new Error('주간 분석인데 report가 비어 있음')
				entry.summary = res.summary
				const failedBefore = this.failures
				this.failures = 0
				this.lastFailedMode = null
				if (mode !== primary && !this.failover) await this.#startFailover(primary, mode, started, failedBefore)
				entry.applied = await this.#apply(res, reasons)
			}
		} catch (e) {
			entry.error = e.message
			this.failures++
			this.lastError = e.message
			if (mode) this.lastFailedMode = mode
			// 넘어간 쪽도 실패하면 거기에 머물지 않는다(다음에는 원래 방식부터 다시 본다).
			if (mode && mode !== primary) this.failover = null
			if (!this.dry) await this.#onFailure(reasons, e, mode)
		}
		entry.total_ms = this.clock() - started
		this.lastRun = entry
		if (!this.dry) {
			appendJsonl(P.decisions, entry)
			if (rounds.length) try { archiveRun({ started, reasons, input, rounds, keep: this.cfg.limits.keep_runs }) } catch (e) { log('판단 원문 보관 실패:', e.message) }
		}
		log(`판단 끝 (${Math.round(entry.total_ms / 1000)}초, 토큰 ${entry.tokens ?? '?'}): ${entry.error ? `실패 ${entry.error}` : entry.summary}`)
		return entry
	}

	// 고른 방식이 after_failures번 연속 실패하면 다른 방식(codex↔api)으로 넘어가 hold_minutes 동안 그쪽에 묻는다.
	// 그 시간이 지나면 원래 방식을 다시 써 보고, 한 번이라도 실패하면 곧바로 다시 넘어간다.
	// 둘 다 실패하는 동안에는 번갈아 시도한다(한쪽이 돌아오면 잡을 수 있게).
	#pickMode(primary, now) {
		const f = this.cfg.failover
		if (this.dry || !f.enabled) return primary
		const other = MODES.find(m => m !== primary)
		if (this.failover && (this.failover.primary !== primary || now >= this.failover.until)) {
			if (this.failover.primary === primary) this.failures = Math.max(this.failures, f.after_failures - 1)
			this.failover = null
		}
		if (this.failover) return other
		return this.failures >= f.after_failures && this.lastFailedMode !== other && this.canUse(this.cfg, other) ? other : primary
	}

	// 다른 방식으로 넘어가 판단에 성공했다. 한동안 그쪽에 묻고, 요금이 달라질 수 있으니 하루에 한 번 알린다.
	async #startFailover(primary, mode, now, failed) {
		const hold = this.cfg.failover.hold_minutes
		this.failover = { primary, until: now + hold * MIN }
		log(`${MODE_LABEL[primary]} 판단이 ${failed}번 연속 실패해 ${MODE_LABEL[mode]}로 넘어감 (${hold}분 동안)`)
		const c = this.#todayCounters()
		if (this.dry || c.failover_notice) return
		c.failover_notice = true
		writeJson(P.counters, c)
		const why = String(this.lastError ?? '').replace(/\s+/g, ' ').slice(-140)
		const cost = mode === 'api' ? ' API는 쓴 토큰만큼 요금이 나가요.' : ''
		await this.#deliver({ kind: 'info', level: 'normal', title: '🤖 판단 방식을 잠시 바꿨어요', message: `${MODE_LABEL[primary]} 판단이 ${failed}번 연속 실패해 ${MODE_LABEL[mode]}로 묻고 있어요.${cost} ${MODE_LABEL[primary]}가 돌아오면 스스로 되돌아가요. 마지막 오류: ${why}`.slice(0, 500), related_rule_ids: [] })
	}

	// 정각 점검만 깨웠고, 직전 점검 뒤로 집 상태·날씨·일정·피드백이 그대로면 건너뛴다.
	#unchangedHourly(reasons, ctx, now) {
		if (!this.cfg.hourly_skip_unchanged || reasons.length !== 1 || reasons[0].type !== 'hourly') return false
		const hour = reasons[0].hour
		const rain = f => Number(f.precipitation) > 0 || /rain|pour|snow|hail|lightning/.test(f.condition ?? '')
		const soon = ev => { const t = Date.parse(/^\d{4}-\d\d-\d\d$/.test(ev.start) ? `${ev.start}T00:00:00+09:00` : ev.start); return t > now && t - now < 3 * 3600000 }
		const fp = JSON.stringify([
			(ctx.weather?.hourly ?? []).slice(0, 6).some(rain),
			(Array.isArray(ctx.calendar) ? ctx.calendar : []).filter(soon).map(ev => `${ev.start} ${ev.summary}`),
			Object.entries(this.runtime.rules).filter(([, r]) => r.fired).map(([id]) => id).sort(),
			this.held.length, this.schedule.length,
		])
		const last = this.runtime.hourly
		const since = last?.at ?? 0
		// 소음 엔티티(noise_entities)와 TV·셋톱의 재생↔일시정지 같은 출렁임은 달라진 것으로 치지 않는다.
		const quietHouse = !this.ring.some(c => c.t > since && significantChange(c, this.isNoise)) && !readJsonl(P.feedback).some(f => Date.parse(f.ts) > since)
		const first = hour === this.cfg.active_hours.start || hour === 24
		const skip = !first && last?.fp === fp && quietHouse && now - since < 6 * 3600000
		if (!skip) { this.runtime.hourly = { fp, at: now }; this.#saveRuntime() }
		return skip
	}

	// 자료를 받는 사이 HA 연결이 끊겼는지. 끊겼으면 그 이유, 아니면 null.
	// 2026-11-14 23시 돌아보기가 끊긴 연결로 일정을 못 받은 채 판단해 "일정을 불러오지 못했다"고 알렸다.
	#connectionLost(ctx) {
		if (!this.ha.connected) return '연결 없음'
		const e = [ctx.weather, ctx.calendar].map(x => x?.error).find(m => m && CONN_ERR.test(m))
		return e ?? null
	}

	async #gather(now) {
		const safe = p => p.catch(e => ({ error: e.message }))
		const [weather, calendar, repairs, syslog] = await Promise.all([
			safe(this.#weather()), safe(this.#calendar()),
			safe(this.ha.call({ type: 'repairs/list_issues' })), safe(this.ha.call({ type: 'system_log/list' })),
		])
		await this.#refreshMeta(now)
		return {
			weather, calendar,
			repairs: (repairs?.issues ?? []).filter(i => !i.ignored).map(i => ({ domain: i.issue_domain ?? i.domain, id: i.issue_id, severity: i.severity, created: fmt(Date.parse(i.created)), detail: i.translation_placeholders ?? undefined })),
			syslog: (Array.isArray(syslog) ? syslog : []).slice(0, 50).map(x => ({ level: x.level, name: x.name, message: [].concat(x.message ?? []).join(' ').slice(0, 300), count: x.count, last: fmt(x.timestamp * 1000) })),
			states: compactStates(this.states, this.meta.areaOf),
			automations: automationList(this.states, this.meta.autoCfg),
		}
	}

	// 방(영역) 정보와 자동화 설정은 잘 안 바뀌므로 6시간에 한 번만 가져온다.
	async #refreshMeta(now) {
		if (this.meta.at && now - this.meta.at < 6 * 3600000) return
		try {
			const [areas, devices, entities] = await Promise.all(['area', 'device', 'entity'].map(k => this.ha.call({ type: `config/${k}_registry/list` })))
			const areaName = new Map(areas.map(a => [a.area_id, a.name]))
			const deviceArea = new Map(devices.map(d => [d.id, d.area_id]))
			const areaOf = new Map()
			for (const e of entities) {
				const name = areaName.get(e.area_id ?? deviceArea.get(e.device_id))
				if (name) areaOf.set(e.entity_id, name)
			}
			const autoCfg = {}
			for (const id of this.states.keys()) {
				if (!id.startsWith('automation.')) continue
				try { autoCfg[id] = (await this.ha.call({ type: 'automation/config', entity_id: id }))?.config } catch {}
			}
			this.meta = { at: now, areaOf, autoCfg }
		} catch (e) { log('영역·자동화 정보를 가져오지 못함:', e.message) }
	}

	async #weather() {
		const e = this.cfg.weather_entity
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

	async #calendar() {
		const ids = [...this.states.keys()].filter(i => i.startsWith('calendar.'))
		if (!ids.length) return []
		const now = this.clock()
		const end = new Date(Date.parse(`${kst(new Date(now)).date}T00:00:00+09:00`) + 2 * DAY)
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

	#writeRunFiles(ctx) {
		rmSync(P.run, { recursive: true, force: true })
		mkdirSync(P.run, { recursive: true })
		const w = (name, data, pretty = true) => writeFileSync(join(P.run, name), pretty ? JSON.stringify(data, null, 1) : JSON.stringify(data))
		w('states.json', ctx.states, false)
		w('automations.json', ctx.automations)
		w('automation-configs.json', this.meta.autoCfg ?? {})
		w('daily.json', recentDaily(14))
		w('repairs.json', ctx.repairs)
		w('system-log.json', ctx.syslog)
		// 지난 주간 분석 보고서: 제안을 되풀이하지 않고, 사용자가 보고서에 대해 물을 때 답할 수 있게 한다.
		const last = readWeekly()
		if (last) writeFileSync(join(P.run, 'weekly-last-report.md'), last.text)
		return last?.name ?? null
	}

	// 주간 분석 자료: 7일치 활동 기록에서 자동화 실행과 기기 조작을 간추려 run/에 쓴다.
	async #writeWeeklyFiles(ctx, now) {
		const period = { from: now - WEEKLY_HOURS * 3600000, to: now }
		const write = async (name, ids, digest) => {
			let data
			try { data = digest(ids.length ? await this.ha.logbook(ids, WEEKLY_HOURS) : []) } catch (e) { data = { error: e.message } }
			writeFileSync(join(P.run, name), JSON.stringify(data, null, 1))
		}
		await write('weekly-automations.json', ctx.automations.map(a => a.id), rows => automationRuns(rows, ctx.automations, period))
		await write('weekly-devices.json', [...this.states.keys()].filter(id => DEVICE_DOMAINS.has(id.split('.')[0])), rows => deviceActivity(rows, this.states, this.meta.areaOf, period))
	}

	// Codex가 요청한 추가 자료(상태 기록·통계·활동 기록)를 파일로 써 준다.
	async #fetchInfo(reqs, offset) {
		const files = []
		for (const q of reqs) {
			const ids = q.entity_ids.filter(id => this.states.has(id))
			if (!ids.length) continue
			let data = {}
			try {
				if (q.kind === 'statistics') {
					const raw = await this.ha.statistics(ids, q.hours)
					for (const [id, rows] of Object.entries(raw ?? {})) {
						data[id] = rows.map(x => ({ t: fmt(x.start), mean: round2(x.mean) ?? undefined, min: round2(x.min) ?? undefined, max: round2(x.max) ?? undefined, state: round2(x.state) ?? undefined })).slice(-400)
					}
				} else if (q.kind === 'logbook') {
					const raw = await this.ha.logbook(ids, q.hours)
					data = (raw ?? []).map(x => ({ t: fmt(x.when * 1000), id: x.entity_id, name: x.name, state: x.state, message: x.message, by: x.context_name ?? x.context_entity_id_name ?? x.source })).slice(-300)
				} else {
					const raw = await this.ha.history(ids, q.hours)
					for (const [id, rows] of Object.entries(raw ?? {})) data[id] = rows.map(x => [fmt((x.lu ?? x.lc) * 1000), x.s]).slice(-300)
				}
			} catch (e) { data = { error: e.message } }
			const file = `run/info-${offset + files.length + 1}-${q.kind}.json`
			writeFileSync(join(P.run, '..', file), JSON.stringify(data, null, 1))
			files.push({ file, kind: q.kind, entity_ids: ids, hours: q.hours })
		}
		return files
	}

	// ── 답 적용: 규칙·예약·메모·행동·알림을 검사한 뒤 반영 ──
	async #apply(res, reasons) {
		const now = this.clock(), keep = this.cfg.limits.keep_snapshots
		const out = { added: [], changed: [], deleted: [], rejected: [], wakes: [], memory: res.memory.mode, actions: [], notifications: [] }
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
			out.preview = { rules: rules.filter(r => out.added.includes(r.id) || out.changed.includes(r.id)), wakes, memory: res.memory, actions: res.actions, notifications: res.notifications, report: res.report || undefined }
			return out
		}
		if (out.added.length || out.changed.length || out.deleted.length || !this.rulesDoc) {
			snapshot('rules', this.rulesDoc, now, keep)
			this.engine.setRules(rules, this.states, now, [...out.added, ...out.changed])
			this.rulesDoc = { updated: iso(now), rules }
			writeJson(P.rules, this.rulesDoc)
			this.#saveRuntime()
		}
		this.schedule = [...this.schedule, ...wakes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, this.cfg.limits.max_pending_wakes)
		writeJson(P.schedule, this.schedule)
		out.wakes = wakes.map(w => fmt(Date.parse(w.at)))
		this.#applyMemory(res.memory, out, now)
		const notes = [...res.notifications]
		if (res.report) {
			if (reasons.some(r => r.type === 'weekly')) {
				out.report = saveWeekly(kst(new Date(now)).date, res.report, this.cfg.limits.keep_weekly)
				// 전문을 HA 알림 목록(🔔)에 올려 휴대폰에서 읽을 수 있게 한다.
				out.published = await this.#publishWeekly(out.report, res.report)
				// 보고서가 나왔는데 알림이 없으면 사용자가 모르고 지나가니 기본 알림을 보낸다.
				if (!notes.length) notes.push({ kind: 'info', level: 'normal', title: '📊 주간 자동화 분석이 나왔어요', message: `${res.summary.slice(0, 300)} ${out.published ? '전문은 HA 앱의 알림(🔔)에서 볼 수 있어요.' : '전문: node src/cli.mjs weekly'}`, related_rule_ids: [] })
			} else out.rejected.push({ report: true, error: 'report는 주간 분석(weekly) 깨움에서만 쓴다' })
		}
		out.actions = await this.#applyActions(res.actions, out, reasons)
		for (const n of notes) out.notifications.push(await this.#deliver(n, reasons))
		writeJson(P.rejected, out.rejected)
		// 알림을 다 보낸 뒤에 한다(기록을 받아 오는 데 시간이 걸릴 수 있다).
		const tested = await this.#backtest([...out.added, ...out.changed], now)
		if (tested.length) out.backtest = tested
		return out
	}

	// 새로 만들거나 고친 규칙을 지난 7일의 상태 기록에 돌려 본다. 결과는 규칙 목록에 붙어 다음 판단부터 AI가 본다.
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
		if (out.length) { this.#saveRuntime(); log('규칙 백테스트:', out.join(' · ')) }
		return out
	}

	// 주간 보고서 전문을 HA 알림 목록에 올린다(같은 id라 지난 보고서를 덮어쓴다). 올렸으면 true.
	async #publishWeekly(name, text) {
		if (this.dry || !this.cfg.weekly.publish) return false
		const [domain, service] = PUBLISH_SERVICE.split('.')
		try {
			await this.ha.callService(domain, service, { data: { title: `📊 집 비서 주간 분석 ${String(name).replace('.md', '')}`, message: text, notification_id: 'haagent_weekly' } })
			log(`주간 보고서를 HA 알림 목록에 올림: ${name}`)
			return true
		} catch (e) { log('주간 보고서를 HA에 올리지 못함:', e.message); return false }
	}

	#applyMemory(m, out, now) {
		const max = this.cfg.limits.memory_chars
		const old = existsSync(P.memory) ? readFileSync(P.memory, 'utf8') : ''
		let cur = old
		if (m.mode === 'append' && m.text) {
			const day = kst(new Date(now)).date.slice(5)
			const add = m.text.split('\n').map(l => l.trim().replace(/^[-*]\s*/, '')).filter(Boolean).map(l => `- (${day}) ${l}`).join('\n')
			const next = `${cur.trimEnd()}\n${add}`.trim() + '\n'
			if (next.length > max) out.rejected.push({ memory: 'append', error: `메모가 ${max}자를 넘는다. replace로 정리할 것` })
			else cur = next
		} else if (m.mode === 'replace' && m.text) {
			if (m.text.length > max) out.rejected.push({ memory: 'replace', error: `메모는 ${max}자까지` })
			else cur = m.text.trim() + '\n'
		}
		if (cur === old) return
		snapshot('memory', old, now, this.cfg.limits.keep_snapshots)
		writeFileSync(P.memory, cur)
	}

	// ── 알림 ──
	async #deliver(n, reasons = []) {
		const now = this.clock(), nid = newId()
		const c = this.#todayCounters()
		const k = kst(new Date(now))
		const summary = n.kind === 'hourly_summary'
		// 하루 돌아보기의 요약만은 그 시각 30분 안에는 조용한 시간이어도 보낸다(소리 없는 요약). 다른 알림은 아침까지 보류.
		const midnightGrace = summary && k.h === this.cfg.reflection_hour && k.mi < 30 && reasons.some(r => r.type === 'reflection')
		const rec = { nid, ts: iso(now), ...n, tag: tagFor(n, nid) }
		if (this.#quiet(now) && !midnightGrace && n.level !== 'urgent') {
			rec.status = 'held'
			this.held.push({ type: 'notification', ...rec })
			writeJson(P.held, this.held)
		} else if (summary && c.summaries >= this.cfg.limits.summaries_per_day) rec.status = 'over_limit'
		else if (!summary && n.level !== 'urgent' && c.alerts >= this.cfg.limits.alerts_per_day) rec.status = 'over_limit'
		else if (!this.control.send) rec.status = 'test_mode'
		else {
			try {
				await this.#send(buildPayload(n, nid, { reply: this.cfg.reply_button }))
				rec.status = 'sent'
				this.#bump(summary ? 'summaries' : 'alerts')
				// 새 요약이 나갔으니 다시 보내려던 낡은 요약은 버린다(같은 자리를 덮어써 새것을 가리지 않게).
				if (summary) this.#dropQueuedSummaries('replaced')
			} catch (e) {
				rec.error = e.message
				// 보낼 때까지 다시 시도한다. 요약은 한 시간까지만(23시 마감 요약은 다음 요약이 아침이라 버리면 안 된다).
				rec.status = 'queued'
				if (summary) this.#dropQueuedSummaries('replaced')
				this.outbox.push({ nid, n, ts: now, next: now + MIN })
				writeJson(P.outbox, this.outbox)
				if (n.level === 'urgent') this.#oobSend(n.title, n.message)
			}
		}
		appendJsonl(P.notifications, rec)
		log(`알림 ${rec.status}: [${n.level}] ${n.title} — ${n.message}`)
		return `${rec.status}: ${n.title}`
	}

	// 못 보낸 알림을 다시 보낸다. urgent는 6시간, 정각 요약은 1시간, 나머지는 2시간까지.
	async #flushOutbox(now) {
		if (this.flushing || !this.outbox.length || !this.ha.connected || !this.control.send) return
		this.flushing = true
		try {
			for (const item of [...this.outbox]) {
				if (!this.outbox.includes(item)) continue
				const summary = item.n.kind === 'hourly_summary'
				let status = null
				if (now - item.ts > (item.n.level === 'urgent' ? 6 * 3600000 : summary ? SUMMARY_RETRY_MS : 2 * 3600000)) status = 'expired'
				else if (item.next <= now) {
					try { await this.#send(buildPayload(item.n, item.nid, { reply: this.cfg.reply_button })); status = 'sent' } catch { item.next = now + MIN }
				}
				if (!status) continue
				this.outbox = this.outbox.filter(x => x !== item)
				this.#closeQueued(item, status)
				if (status === 'sent') this.#bump(summary ? 'summaries' : 'alerts')
			}
			writeJson(P.outbox, this.outbox)
		} finally { this.flushing = false }
	}

	#closeQueued(item, status) {
		appendJsonl(P.notifications, { nid: item.nid, ts: iso(item.ts), ...item.n, tag: tagFor(item.n, item.nid), status })
		log(`알림 ${{ sent: '다시 보냄', expired: '끝내 못 보냄', replaced: '새 요약으로 대신함' }[status]}: ${item.n.title}`)
	}

	// 다시 보내려던 정각 요약을 버린다(새 요약이 나왔거나 새로 넣을 때).
	#dropQueuedSummaries(status) {
		const old = this.outbox.filter(x => x.n.kind === 'hourly_summary')
		if (!old.length) return
		this.outbox = this.outbox.filter(x => !old.includes(x))
		for (const item of old) this.#closeQueued(item, status)
		writeJson(P.outbox, this.outbox)
	}

	// 대상이 여럿이면 하나라도 가면 성공으로 본다.
	async #send(payload) {
		let ok = 0, last = null
		for (const t of this.cfg.notify_targets) {
			try { await this.ha.callService('notify', t, { data: payload }); ok++ } catch (e) { last = e; log(`알림 발송 실패(${t}):`, e.message) }
		}
		if (!ok) throw last ?? new Error('알림 대상이 없음')
	}

	#oobSend(title, message) {
		Promise.resolve().then(() => this.oob(this.cfg, title, message)).then(sent => { if (sent) log(`비상 알림 보냄: ${title}`) }).catch(e => log('비상 알림 실패:', e.message))
	}

	// HA에 오래 연결하지 못하면 HA 밖의 길로 알린다(휴대폰 알림은 HA를 거치므로 쓸 수 없다).
	#watchHa(now) {
		if (this.dry) return
		if (this.ha.connected) {
			if (this.downNotified) this.#oobSend('✅ 집 비서: HA 다시 연결됨', `${fmt(this.downSince)}부터 끊겼던 연결이 돌아왔어요.`)
			this.downSince = null
			this.downNotified = false
			return
		}
		this.downSince ??= now
		const limit = this.cfg.oob.ha_down_minutes * MIN
		if (!this.downNotified && now - this.downSince >= limit) {
			this.downNotified = true
			log(`HA에 ${this.cfg.oob.ha_down_minutes}분 넘게 연결하지 못함`)
			this.#oobSend('⚠️ 집 비서: HA에 연결하지 못해요', `${fmt(this.downSince)}부터 Home Assistant에 닿지 않아요. 집 감시와 휴대폰 알림이 멈춰 있어요.`)
		}
	}

	#heartbeat(now) {
		const h = this.cfg.heartbeat
		if (this.dry || !h.enabled || !this.ha.connected || now - this.lastBeat < h.interval_seconds * 1000) return
		this.lastBeat = now
		const c = this.#todayCounters()
		// ha/status-sensors.yaml의 센서들이 이 값을 읽어 대시보드에 보여 준다.
		const last = this.lastRun
		const data = {
			ts: iso(now), rules: this.engine.rules.length, rules_true: Object.values(this.runtime.rules).filter(r => r.fired).length,
			runs_today: c.runs, alerts_today: c.alerts, summaries_today: c.summaries, actions_today: c.actions,
			failures: this.failures, paused: this.control.paused, send: this.control.send,
			brain: this.failover ? MODES.find(m => m !== this.failover.primary) : brainMode(this.cfg, this.control), failover: !!this.failover,
			queue: this.queue.length, held: this.held.length, pending_actions: this.pendingActs.length,
			last_run: last ? fmt(Date.parse(last.ts)) : null, last_ok: last ? !last.error : null,
			last_summary: last ? String(last.error ? `실패: ${last.error}` : last.summary ?? '').replace(/\s+/g, ' ').slice(0, 200) : null,
		}
		Promise.resolve().then(() => this.ha.heartbeat(data))
			.then(() => this.#beatDelivered(now))
			.catch(e => { if (!this.beatWarned) { this.beatWarned = true; log('heartbeat를 보내지 못함:', e.message) } })
	}

	// heartbeat가 HA에 닿은 시각을 남긴다(재시작해도 이어지게 runtime에). 직전 신호와의 사이가 HA 경고 시간보다 길면
	// HA가 '응답하지 않아요'를 보냈을 것이니, 같은 tag로 '다시 연결됐어요'를 보내 그 경고를 바꿔 놓는다.
	async #beatDelivered(now) {
		const prev = this.runtime.last_beat_ok
		this.runtime.last_beat_ok = now
		this.#saveRuntime()
		const gap = this.cfg.heartbeat.alert_minutes * MIN
		if (!prev || now - prev < gap || !this.control.send) return
		try {
			await this.#send(recoveredPayload(prev, now, fmt))
			appendJsonl(P.notifications, { nid: newId(), ts: iso(now), kind: 'system', level: 'quiet', title: '✅ 집 비서가 다시 연결됐어요', message: `${fmt(prev)}부터 ${Math.round((now - prev) / MIN)}분 동안 HA와 신호가 끊겼었어요.`, related_rule_ids: [], tag: 'haagent-heartbeat', status: 'sent' })
			log(`다시 연결 알림: ${fmt(prev)}부터 ${Math.round((now - prev) / MIN)}분 끊겼었음`)
		} catch (e) { log('다시 연결 알림 실패:', e.message) }
	}

	// urgent 규칙이 발동한 뒤 상황이 그대로이고 사용자의 반응(도움됐어요·이건 그만·답장)도 없으면 다시 알린다.
	// max_reminders번까지, oob_from번째부터는 비상 알림 길로도 보낸다. 상황이 풀리거나 규칙이 바뀌면 멈춘다.
	async #remindUrgent(now) {
		const e = this.cfg.escalation
		if (this.dry || !e.enabled || !this.ha.connected || this.control.paused) return
		let fb = null, touched = false
		for (const r of this.engine.rules) {
			const rt = this.runtime.rules[r.id]
			if (r.priority !== 'urgent' || !rt?.fired || !rt.open || rt.waiting) continue
			if (rt.remind?.open !== rt.open) rt.remind = { open: rt.open, n: 0, at: rt.open }
			const m = rt.remind
			if (m.done || m.n >= e.max_reminders || now - m.at < e.remind_minutes * MIN) continue
			touched = true
			fb ??= readJsonl(P.feedback)
			if ((rt.muted_until && now < rt.muted_until) || fb.some(f => (f.rules ?? []).includes(r.id) && Date.parse(f.ts) >= rt.open)) { m.done = true; continue }
			m.n++
			m.at = now
			const st = this.states.get(r.entity_id)
			const alert = this.#ruleAlert({ rule_id: r.id, description: r.description, entity_id: r.entity_id, value: r.attribute ? st?.attributes?.[r.attribute] : st?.state }, 'urgent',
				`${Math.round((now - rt.open) / MIN)}분째 그대로예요(다시 알림 ${m.n}/${e.max_reminders}). 확인하셨으면 [도움됐어요]를 눌러 주세요.`)
			log(`urgent 다시 알림 ${m.n}/${e.max_reminders}: ${r.id}`)
			await this.#deliver(alert).catch(err => log('다시 알림 실패:', err.message))
			if (m.n >= e.oob_from) this.#oobSend(alert.title, alert.message)
		}
		if (touched) this.#saveRuntime()
	}

	// 값이 그대로인 센서의 last_reported는 이벤트로 오지 않으므로(stale 규칙이 본다) 5분마다 전체 상태를 다시 읽는다.
	async #refreshStates(now) {
		if (this.dry || !this.ha.connected || now - this.lastRefresh < 5 * MIN) return
		this.lastRefresh = now
		try {
			for (const s of await this.ha.call({ type: 'get_states' })) {
				const cur = this.states.get(s.entity_id)
				if (!cur || Date.parse(s.last_updated) >= Date.parse(cur.last_updated)) this.states.set(s.entity_id, s)
			}
		} catch (e) { log('상태 다시 읽기 실패:', e.message) }
	}

	// Codex를 못 쓰는 상황(실패가 이어짐·하루 한도): 규칙 설명을 그대로 보낸다. 이미 긴급 알림이 나간 것은 뺀다.
	async #fallback(reasons, why) {
		for (const r of reasons.filter(r => r.type === 'rule' && !r.pre_notified)) {
			await this.#deliver(this.#ruleAlert(r, r.urgent ? 'urgent' : 'normal', `(${why} 집 비서 판단 없이 규칙 내용을 그대로 보내요)`), reasons)
		}
	}

	async #onFailure(reasons, e, mode = null) {
		const label = MODE_LABEL[mode ?? brainMode(this.cfg, this.control)]
		log(`${label} 판단 실패:`, e.message)
		const now = this.clock(), gaveUp = []
		for (const r of reasons) {
			if (r.type === 'held') continue // 보류분은 지우지 않았으니 다음 tick에 다시 들어온다
			const attempts = (r.attempts ?? 0) + 1
			if (attempts < this.#maxAttempts(r)) this.queue.push({ ...r, attempts, notBefore: now + 5 * MIN * attempts })
			else gaveUp.push(r)
		}
		this.#saveQueue()
		await this.#fallback(gaveUp, '판단이 실패해')
		const c = this.#todayCounters()
		if (this.failures >= 3 && !c.error_notice) {
			c.error_notice = true
			writeJson(P.counters, c)
			const why = e.message.replace(/\s+/g, ' ').slice(-160)
			await this.#deliver({ kind: 'info', level: 'normal', title: '🤖 집 비서가 판단을 못 하고 있어요', message: `${label} 판단이 ${this.failures}번 연속 실패했어요. 마지막 오류: ${why}`, related_rule_ids: [] }, reasons)
		}
	}

	// ── 행동(기기 켜기/끄기) ──
	#actionContext() {
		if (!this.tiers.size) return null
		const c = this.#todayCounters(), since = this.clock() - 7 * DAY
		return {
			today: c.actions, perDay: this.cfg.actions.per_day, onRequest: !!this.cfg.actions.on_request,
			tiers: [...this.tiers].map(([id, tier]) => ({ id, tier, name: this.states.get(id)?.attributes?.friendly_name, state: this.states.get(id)?.state ?? '없음' })),
			recent: latestBy(readJsonl(P.actions), 'aid').filter(a => Date.parse(a.ts) >= since).slice(-10),
		}
	}

	async #applyActions(list, out, reasons = []) {
		const a = this.cfg.actions, results = []
		// 사용자가 답장·say로 직접 시킨 행동(requested)은 승인을 다시 묻지 않고, 조용한 시간에도 한다. 사용자 말로 깨어난 판단에서만 인정한다.
		const byUser = a.on_request && reasons.some(r => r.type === 'user')
		for (const [i, x] of list.entries()) {
			const label = `${x.entity_id} ${x.action}`
			if (i >= a.per_cycle) { out.rejected.push({ action: label, error: `행동은 한 번에 ${a.per_cycle}개까지` }); continue }
			const direct = byUser && x.requested === true
			const v = checkAction(x, { tiers: this.tiers, states: this.states, quiet: direct ? false : this.#quiet(), usedToday: this.#todayCounters().actions, perDay: a.per_day, pending: this.pendingActs })
			if (!v.ok) { out.rejected.push({ action: label, error: v.error }); continue }
			if (v.noop) { results.push(`noop: ${label} (이미 그 상태)`); continue }
			const st = this.states.get(x.entity_id)
			const rec = { aid: newId(), ts: iso(this.clock()), entity_id: x.entity_id, name: st.attributes?.friendly_name ?? x.entity_id, action: x.action, reason: x.reason, tier: v.tier, prev: st.state }
			if (direct) rec.requested = true
			if (!this.control.send) { rec.status = 'test_mode'; appendJsonl(P.actions, rec) }
			else if (v.tier === 'auto' || direct) await this.#execute(rec)
			else await this.#askApproval(rec)
			results.push(`${rec.status}: ${label}`)
		}
		return results
	}

	// 실행한 뒤 상태가 실제로 바뀌었는지 확인하고 결과를 알린다([되돌리기] 버튼 포함).
	async #execute(rec, { undo = false } = {}) {
		try {
			await this.ha.callService(rec.entity_id.split('.')[0], rec.action, { target: { entity_id: rec.entity_id } })
			rec.status = (await this.#waitState(rec.entity_id, rec.action)) ? 'done' : 'unverified'
			this.#bump('actions')
		} catch (e) { rec.status = 'error'; rec.error = e.message }
		rec.done_at = iso(this.clock())
		appendJsonl(P.actions, rec)
		log(`행동 ${rec.status}: ${rec.name} ${rec.action} — ${rec.reason}`)
		const shown = undo && rec.status === 'done' ? { ...rec, status: 'undone' } : rec
		await this.#send(actionResultPayload(shown, { undo: !undo && rec.status !== 'error' })).catch(() => {})
		return rec
	}

	async #waitState(id, action) {
		const until = Date.now() + this.cfg.actions.verify_seconds * 1000
		for (;;) {
			if (reached(action, this.states.get(id)?.state)) return true
			if (Date.now() >= until) return false
			await new Promise(r => setTimeout(r, 250))
		}
	}

	async #askApproval(rec) {
		const minutes = this.cfg.actions.approval_minutes
		rec.expires = this.clock() + minutes * MIN
		if (this.#todayCounters().alerts >= this.cfg.limits.alerts_per_day) { rec.status = 'error'; rec.error = '오늘 알림 한도에 닿아 승인 요청을 못 보냄' }
		else {
			try {
				await this.#send(approvalPayload(rec, minutes))
				rec.status = 'pending'
				this.pendingActs.push(rec)
				this.#bump('alerts')
			} catch (e) { rec.status = 'error'; rec.error = e.message }
		}
		appendJsonl(P.actions, rec)
		log(`행동 승인 요청 ${rec.status}: ${rec.name} ${rec.action} — ${rec.reason}`)
	}

	async #onActionButton(kind, aid) {
		const now = this.clock()
		const rec = latestBy(readJsonl(P.actions), 'aid').find(a => a.aid === aid)
		if (!rec) return log('버튼: 행동 기록을 찾지 못함', aid)
		const close = async (status, extra = {}) => {
			const r = { ...rec, ...extra, status, decided_at: iso(now) }
			appendJsonl(P.actions, r)
			log(`행동 ${status}: ${rec.name} ${rec.action}`)
			await this.#send(actionResultPayload(r)).catch(() => {})
		}
		if (kind === 'UNDO') {
			if (!['done', 'unverified'].includes(rec.status) || rec.undo_of) return
			if (!this.tiers.has(rec.entity_id)) return log('되돌리기: 허용 목록에서 빠진 엔티티', rec.entity_id)
			appendJsonl(P.actions, { ...rec, status: 'undone', decided_at: iso(now) })
			await this.#execute({ aid: newId(), ts: iso(now), entity_id: rec.entity_id, name: rec.name, action: opposite(rec.action), reason: `되돌리기: ${rec.reason}`.slice(0, 200), tier: rec.tier, undo_of: aid }, { undo: true })
			return
		}
		if (rec.status !== 'pending') return
		this.pendingActs = this.pendingActs.filter(p => p.aid !== aid)
		if (kind === 'NO') return close('declined')
		if (now > rec.expires) return close('expired')
		// 승인을 기다리는 사이 설정이나 기기 상태가 바뀌었을 수 있으니 다시 검사한다.
		const v = checkAction(rec, { tiers: this.tiers, states: this.states, quiet: false, usedToday: this.#todayCounters().actions, perDay: this.cfg.actions.per_day })
		if (!v.ok) return close('error', { error: v.error })
		if (v.noop) return close('done')
		await this.#execute({ ...rec })
	}

	async #expireActions(now) {
		const old = this.pendingActs.filter(p => now > p.expires)
		if (this.dry || !old.length) return
		this.pendingActs = this.pendingActs.filter(p => !old.includes(p))
		for (const p of old) {
			const r = { ...p, status: 'expired', decided_at: iso(now) }
			appendJsonl(P.actions, r)
			log(`행동 승인 시간 지남: ${p.name} ${p.action}`)
			if (this.ha.connected) await this.#send(actionResultPayload(r)).catch(() => {})
		}
	}

	#saveRuntime() { if (!this.dry) writeJson(P.runtime, this.runtime) }
}
