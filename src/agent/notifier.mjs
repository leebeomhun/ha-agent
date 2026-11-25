// 알림 전달, 재전송 아웃박스, HA 연결 감시, 하트비트, urgent 에스컬레이션
import { buildPayload, recoveredPayload, tagFor } from '../notify.mjs'
import { brainMode, MODES } from '../brain.mjs'
import { P, writeJson, kst, fmt, newId, log } from '../util.mjs'

const MIN = 60000
const SUMMARY_RETRY_MS = 60 * MIN
const iso = ms => new Date(ms).toISOString()

export class Notifier {
	constructor(agent) {
		this.agent = agent
	}

	ruleAlert(r, level, tail) {
		const name = this.agent.states.get(r.entity_id)?.attributes?.friendly_name ?? r.entity_id
		return { kind: 'alert', level, title: `⚠️ ${r.description}`.slice(0, 60), message: `${name}: 지금 ${r.value}. ${tail}`, related_rule_ids: [r.rule_id] }
	}

	async deliver(n, reasons = []) {
		const a = this.agent
		a.liveControl?.()
		const now = a.clock(), nid = newId()
		const c = a.todayCounters()
		const summary = n.kind === 'hourly_summary'
		const midnightGrace = summary && reasons.some(r => r.type === 'reflection')
		const userReplyGrace = reasons.some(r => r.type === 'user' || r.type === 'manual')
		const rec = { nid, ts: iso(now), ...n, tag: tagFor(n, nid) }
		if (a.isQuiet(now) && !midnightGrace && !userReplyGrace && n.level !== 'urgent') {
			rec.status = 'held'
			a.held.push({ type: 'notification', ...rec })
			writeJson(P.held, a.held)
		} else if (summary && c.summaries >= a.cfg.limits.summaries_per_day) rec.status = 'over_limit'
		else if (!summary && n.level !== 'urgent' && c.alerts >= a.cfg.limits.alerts_per_day) rec.status = 'over_limit'
		else if (!a.control.send) rec.status = 'test_mode'
		// 일시정지 중에는 긴급(urgent) 규칙 알림만 보낸다. 집 안전 알림은 판단을 멈춰도 막지 않는다.
		else if (a.control.paused && n.level !== 'urgent') rec.status = 'paused'
		else {
			try {
				await this.send(buildPayload(n, nid, { reply: a.cfg.reply_button }), { allowPaused: n.level === 'urgent' })
				rec.status = 'sent'
				a.bump(summary ? 'summaries' : 'alerts')
				if (summary) this.dropQueuedSummaries('replaced')
			} catch (e) {
				rec.error = e.message
				rec.status = 'queued'
				if (summary) this.dropQueuedSummaries('replaced')
				a.outbox.push({ nid, n, ts: now, next: now + MIN })
				writeJson(P.outbox, a.outbox)
				if (n.level === 'urgent') this.oobSend(n.title, n.message)
			}
		}
		a.journal.notification(rec)
		if (n.kind === 'alert' && ['sent', 'queued'].includes(rec.status)) this.trackAlert(nid, n.related_rule_ids ?? [], now)
		log(`알림 ${rec.status}: [${n.level}] ${n.title} — ${n.message}`)
		return `${rec.status}: ${n.title}`
	}

	// 규칙 알림 뒤 사람이 관련 기기를 만지는지 지켜본다(알림이 쓸모 있었는지 = 알림 정밀도 신호).
	// 관련 기기: 규칙이 보는 엔티티들 + 그 엔티티와 같은 방의 제어 기기(예: 화장실 습도 알림 → 화장실 환풍기)
	trackAlert(nid, ruleIds, now) {
		const a = this.agent
		if (!ruleIds.length || !a.implicitFeedback?.trackAlert) return
		const rules = a.engine.rules.filter(r => ruleIds.includes(r.id))
		const ids = new Set(rules.flatMap(r => [r.entity_id, ...(r.also ?? []).map(c => c.entity_id)]).filter(Boolean))
		const areas = new Set([...ids].map(id => a.meta.areaOf?.get(id)).filter(Boolean))
		if (areas.size && a.meta.areaOf) {
			for (const [id, area] of a.meta.areaOf) {
				if (areas.has(area) && /^(light|switch|fan|cover|climate|humidifier|media_player|input_boolean)\./.test(id)) ids.add(id)
				if (ids.size >= 30) break
			}
		}
		a.implicitFeedback.trackAlert({ nid, rule_ids: ruleIds, entity_ids: [...ids], ts: now })
	}

	async flushOutbox(now) {
		const a = this.agent
		if (a.flushing || !a.outbox.length || !a.ha.connected || !(a.liveControl?.() ?? a.control).send) return
		a.flushing = true
		try {
			for (const item of [...a.outbox]) {
				if (!a.outbox.includes(item)) continue
				const summary = item.n.kind === 'hourly_summary'
				let status = null
				if (now - item.ts > (item.n.level === 'urgent' ? 6 * 3600000 : summary ? SUMMARY_RETRY_MS : 2 * 3600000)) status = 'expired'
				else if (a.control.paused && item.n.level !== 'urgent') continue
				else if (item.next <= now) {
					try { await this.send(buildPayload(item.n, item.nid, { reply: a.cfg.reply_button }), { allowPaused: item.n.level === 'urgent' }); status = 'sent' } catch { item.next = now + MIN }
				}
				if (!status) continue
				a.outbox = a.outbox.filter(x => x !== item)
				this.closeQueued(item, status)
				if (status === 'sent') a.bump(summary ? 'summaries' : 'alerts')
			}
			writeJson(P.outbox, a.outbox)
		} finally { a.flushing = false }
	}

	closeQueued(item, status) {
		const rec = { nid: item.nid, ts: iso(item.ts), ...item.n, tag: tagFor(item.n, item.nid), status }
		this.agent.journal.notification(rec)
		log(`알림 ${{ sent: '다시 보냄', expired: '끝내 못 보냄', replaced: '새 요약으로 대신함' }[status]}: ${item.n.title}`)
	}

	dropQueuedSummaries(status) {
		const a = this.agent
		const old = a.outbox.filter(x => x.n.kind === 'hourly_summary')
		if (!old.length) return
		a.outbox = a.outbox.filter(x => !old.includes(x))
		for (const item of old) this.closeQueued(item, status)
		writeJson(P.outbox, a.outbox)
	}

	// 휴대폰 알림의 마지막 관문. 운영 모드를 지금 파일에서 다시 읽고, 시험 모드면 보내지 않고, 일시정지면 긴급 알림만 보낸다.
	// reply: 사용자가 누른 버튼·답장에 대한 확인 문구(일시정지 안내 포함)라 운영 모드와 상관없이 보낸다.
	async send(payload, { allowPaused = false, reply = false } = {}) {
		const c = this.agent.liveControl?.() ?? this.agent.control
		if (!reply && !c.send) throw new Error('시험 모드라 알림을 보내지 않음')
		if (!reply && c.paused && !allowPaused) throw new Error('일시정지 중이라 알림을 보내지 않음')
		let ok = 0, last = null
		for (const t of this.agent.cfg.notify_targets) {
			try { await this.agent.ha.callService('notify', t, { data: payload }); ok++ } catch (e) { last = e; log(`알림 발송 실패(${t}):`, e.message) }
		}
		if (!ok) throw last ?? new Error('알림 대상이 없음')
	}

	oobSend(title, message) {
		const a = this.agent
		Promise.resolve().then(() => a.oob(a.cfg, title, message)).then(sent => { if (sent) log(`비상 알림 보냄: ${title}`) }).catch(e => log('비상 알림 실패:', e.message))
	}

	watchHa(now) {
		const a = this.agent
		if (a.dry) return
		if (a.ha.connected) {
			if (a.downNotified) this.oobSend('✅ 집 비서: HA 다시 연결됨', `${fmt(a.downSince)}부터 끊겼던 연결이 돌아왔어요.`)
			a.downSince = null
			a.downNotified = false
			return
		}
		a.downSince ??= now
		const limit = a.cfg.oob.ha_down_minutes * MIN
		if (!a.downNotified && now - a.downSince >= limit) {
			a.downNotified = true
			log(`HA에 ${a.cfg.oob.ha_down_minutes}분 넘게 연결하지 못함`)
			this.oobSend('⚠️ 집 비서: HA에 연결하지 못해요', `${fmt(a.downSince)}부터 Home Assistant에 닿지 않아요. 집 감시와 휴대폰 알림이 멈춰 있어요.`)
		}
	}

	heartbeat(now, { force = false } = {}) {
		const a = this.agent
		const h = a.cfg.heartbeat
		if (a.dry || !h.enabled || !a.ha.connected || (!force && now - a.lastBeat < h.interval_seconds * 1000)) return
		a.lastBeat = now
		const c = a.todayCounters()
		const last = a.lastRun
		const lastAssist = a.lastAssist
		const brain = a.failover
			? (a.failover.mode ?? MODES.find(m => m !== a.failover.primary))
			: brainMode(a.cfg, a.control)
		const data = {
			ts: iso(now), rules: a.engine.rules.length, rules_true: Object.values(a.runtime.rules).filter(r => r.fired).length,
			runs_today: c.runs, alerts_today: c.alerts, summaries_today: c.summaries, actions_today: c.actions,
			failures: a.failures, paused: a.control.paused, send: a.control.send,
			brain, failover: !!a.failover,
			queue: a.queue.length, held: a.held.length, pending_actions: a.pendingActs.length,
			pending_proposals: a.haAdmin.listProposals({ status: 'pending' }).length,
			last_run: last ? fmt(Date.parse(last.ts)) : null, last_ok: last ? !last.error : null,
			last_summary: last ? String(last.error ? `실패: ${last.error}` : last.summary ?? '').replace(/\s+/g, ' ').slice(0, 200) : null,
			last_assist_run: lastAssist ? fmt(Date.parse(lastAssist.ts)) : null,
			last_assist_summary: lastAssist ? String(lastAssist.error ? `실패: ${lastAssist.error}` : lastAssist.summary ?? '').replace(/\s+/g, ' ').slice(0, 200) : null,
		}
		Promise.resolve().then(() => a.ha.heartbeat(data))
			.then(() => this.beatDelivered(now))
			.catch(e => { if (!a.beatWarned) { a.beatWarned = true; log('heartbeat를 보내지 못함:', e.message) } })
	}

	async beatDelivered(now) {
		const a = this.agent
		a.beatWarned = false
		const prev = a.runtime.last_beat_ok
		a.runtime.last_beat_ok = now
		a.saveRuntime()
		const gap = a.cfg.heartbeat.alert_minutes * MIN
		if (!prev || now - prev < gap || !a.control.send || a.control.paused) return
		try {
			await this.send(recoveredPayload(prev, now, fmt))
			const rec = { nid: newId(), ts: iso(now), kind: 'system', level: 'quiet', title: '✅ 집 비서가 다시 연결됐어요', message: `${fmt(prev)}부터 ${Math.round((now - prev) / MIN)}분 동안 HA와 신호가 끊겼었어요.`, related_rule_ids: [], tag: 'haagent-heartbeat', status: 'sent' }
			a.journal.notification(rec)
			log(`다시 연결 알림: ${fmt(prev)}부터 ${Math.round((now - prev) / MIN)}분 끊겼었음`)
		} catch (e) { log('다시 연결 알림 실패:', e.message) }
	}

	async remindUrgent(now) {
		const a = this.agent
		const e = a.cfg.escalation
		if (a.dry || !e.enabled || !a.ha.connected || a.control.paused) return
		let touched = false
		for (const r of a.engine.rules) {
			const rt = a.runtime.rules[r.id]
			if (r.priority !== 'urgent' || !rt?.fired || !rt.open || rt.waiting) continue
			if (rt.remind?.open !== rt.open) rt.remind = { open: rt.open, n: 0, at: rt.open }
			const m = rt.remind
			if (m.done || m.n >= e.max_reminders || now - m.at < e.remind_minutes * MIN) continue
			touched = true
			const fb = a.journal.feedbackRows({ sinceMs: rt.open })
			if ((rt.muted_until && now < rt.muted_until) || fb.some(f => (f.rules ?? []).includes(r.id))) { m.done = true; continue }
			m.n++
			m.at = now
			const st = a.states.get(r.entity_id)
			const alert = this.ruleAlert({ rule_id: r.id, description: r.description, entity_id: r.entity_id, value: r.attribute ? st?.attributes?.[r.attribute] : st?.state }, 'urgent',
				`${Math.round((now - rt.open) / MIN)}분째 그대로예요(다시 알림 ${m.n}/${e.max_reminders}). 확인하셨으면 [도움됐어요]를 눌러 주세요.`)
			log(`urgent 다시 알림 ${m.n}/${e.max_reminders}: ${r.id}`)
			const res = await this.deliver(alert).catch(err => { log('다시 알림 실패:', err.message); return '' })
			// 시험 모드에서는 비상 길로도 보내지 않는다(기록만).
			if (m.n >= e.oob_from && !/^(queued|test_mode|paused):/.test(String(res))) this.oobSend(alert.title, alert.message)
		}
		if (touched) a.saveRuntime()
	}

	async fallback(reasons, why) {
		for (const r of reasons.filter(r => r.type === 'rule' && !r.pre_notified)) {
			await this.deliver(this.ruleAlert(r, r.urgent ? 'urgent' : 'normal', `(${why} 집 비서 판단 없이 규칙 내용을 그대로 보내요)`), reasons)
		}
	}
}
