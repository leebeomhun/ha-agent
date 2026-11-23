// 운영 기록(알림·피드백·행동·상태 변화)의 쓰기·읽기 창구.
// 원본은 SQLite(Store)다. JSONL은 사람이 읽거나 하루·주간 보고서·CLI가 쓰는 내보내기로만 남긴다(실패해도 동작에 영향 없음).
// 버튼 처리·답장·판단 프롬프트처럼 동작을 정하는 읽기는 모두 여기(=SQLite)를 거친다.
// Store가 없을 때(dry 미리보기 등)만 JSONL을 읽는다.
import { P, appendJsonl, readJsonlCached, latestBy, log } from '../util.mjs'

const MAX_ROWS = 5000

export class Journal {
	constructor({ store = null } = {}) {
		this.store = store
		this.exportWarnAt = 0
	}

	#export(path, obj) {
		try { appendJsonl(path, obj) } catch (e) {
			const now = Date.now()
			if (now - this.exportWarnAt >= 60000) { this.exportWarnAt = now; log('JSONL 내보내기 실패(동작에는 영향 없음):', e.message) }
		}
	}

	// ── 쓰기: SQLite 먼저(실패하면 던짐), 그다음 JSONL 내보내기 ──
	notification(rec) {
		this.store?.upsertNotification(rec)
		this.#export(P.notifications, rec)
	}
	feedback(rec) {
		this.store?.recordFeedback(rec)
		this.#export(P.feedback, rec)
	}
	action(rec) {
		this.store?.upsertAction(rec)
		this.#export(P.actions, rec)
	}
	event(c, isNoise = false) {
		this.store?.recordEvent({ ...c, isNoise })
		this.#export(P.events, c)
	}

	// ── 읽기 ──
	notifications({ sinceMs = 0, limit = MAX_ROWS } = {}) {
		if (this.store) return this.store.recentNotifications({ sinceMs, limit })
		return latestBy(readJsonlCached(P.notifications), 'nid').filter(n => Date.parse(n.ts) >= sinceMs).slice(-limit)
	}
	// nid가 맞는 것, 없으면 같은 tag의 가장 최근 것
	findNotification({ nid = null, tag = null } = {}) {
		if (this.store) return (nid && this.store.getNotification(nid)) || (tag && this.store.latestNotificationByTag(tag)) || null
		const list = latestBy(readJsonlCached(P.notifications), 'nid').reverse()
		return (nid && list.find(r => r.nid === nid)) || (tag && list.find(r => r.tag === tag)) || null
	}
	feedbackRows({ sinceMs = 0, limit = MAX_ROWS } = {}) {
		if (this.store) return this.store.recentFeedback({ sinceMs, limit })
		return readJsonlCached(P.feedback).filter(f => Date.parse(f.ts) >= sinceMs).slice(-limit)
	}
	hasFeedback(nid, kind) {
		if (this.store) return this.store.hasFeedback(nid, kind)
		return readJsonlCached(P.feedback).some(f => f.nid === nid && f.kind === kind)
	}
	getAction(aid) {
		if (this.store) return this.store.getAction(aid)
		return latestBy(readJsonlCached(P.actions), 'aid').find(a => a.aid === aid) ?? null
	}
	actions({ sinceMs = 0, limit = 50 } = {}) {
		if (this.store) return this.store.recentActions({ sinceMs, limit })
		return latestBy(readJsonlCached(P.actions), 'aid').filter(a => Date.parse(a.ts) >= sinceMs).slice(-limit)
	}
	pendingActions() {
		if (this.store) return this.store.pendingActions()
		return latestBy(readJsonlCached(P.actions), 'aid').filter(a => a.status === 'pending')
	}
	recentEvents({ limit = MAX_ROWS } = {}) {
		if (this.store) return this.store.recentEvents({ sinceMs: 0, limit }).map(({ is_noise, ...c }) => c)
		return readJsonlCached(P.events).slice(-limit)
	}
}
