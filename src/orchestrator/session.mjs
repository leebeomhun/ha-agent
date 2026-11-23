// 멀티턴 대화 세션 관리자 (SQLite conversations/messages + 메모리 폴백)
import { newId } from '../util.mjs'

const SESSION_TIMEOUT_MS = 2 * 3600000

export class SessionManager {
	constructor({ store = null, maxTurns = 10, timeoutMs = SESSION_TIMEOUT_MS } = {}) {
		this.store = store
		this.maxTurns = maxTurns
		this.timeoutMs = timeoutMs
		this.mem = new Map()
	}

	ensure(conversationId = null, { channel = 'ha_assist', metadata = null, now = Date.now() } = {}) {
		const sid = (typeof conversationId === 'string' && conversationId.trim()) ? conversationId.trim().slice(0, 80) : `conv_${newId()}`
		if (this.store) {
			this.store.ensureConversation(sid, channel, metadata, now)
		} else if (!this.mem.has(sid)) {
			this.mem.set(sid, [])
		}
		return sid
	}

	append(sessionId, role, text, meta = null, now = Date.now()) {
		if (this.store) {
			this.store.appendMessage(sessionId, role, text, meta, now)
			return
		}
		const list = this.mem.get(sessionId) ?? []
		list.push({ ts: now, role, text, meta })
		if (list.length > 40) list.shift()
		this.mem.set(sessionId, list)
	}

	history(sessionId, now = Date.now()) {
		const sinceMs = now - this.timeoutMs
		const limit = this.maxTurns * 2
		if (this.store) {
			return this.store.recentMessages(sessionId, { limit, sinceMs })
		}
		return (this.mem.get(sessionId) ?? []).filter(m => m.ts >= sinceMs).slice(-limit)
	}
}
