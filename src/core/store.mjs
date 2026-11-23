// SQLite 영속 저장소 (Node 22 내장 node:sqlite, WAL 모드). 기존 JSONL 기록이 있으면 최초 1회 자동 이관한다.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { P, readJsonlAll } from '../util.mjs'

const jsonOrNull = v => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v))
const parseJson = (s, fallback = null) => {
	if (s == null || s === '') return fallback
	try { return JSON.parse(s) } catch { return fallback }
}

export class Store {
	constructor(dbPath = P.db) {
		this.dbPath = dbPath
		if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
		this.db = new DatabaseSync(dbPath)
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA busy_timeout = 5000;

			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				entity_id TEXT NOT NULL,
				name TEXT,
				old_state TEXT,
				new_state TEXT,
				is_noise INTEGER DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
			CREATE INDEX IF NOT EXISTS idx_events_entity_ts ON events(entity_id, ts);

			CREATE TABLE IF NOT EXISTS sensor_samples (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				entity_id TEXT NOT NULL,
				value REAL NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_samples_entity_ts ON sensor_samples(entity_id, ts);

			CREATE TABLE IF NOT EXISTS decisions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				reasons TEXT NOT NULL,
				brain TEXT,
				model TEXT,
				effort TEXT,
				total_ms INTEGER,
				tokens INTEGER,
				usage TEXT,
				summary TEXT,
				applied TEXT,
				error TEXT,
				skipped INTEGER DEFAULT 0,
				deferred INTEGER DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);

			CREATE TABLE IF NOT EXISTS actions (
				aid TEXT PRIMARY KEY,
				ts INTEGER NOT NULL,
				entity_id TEXT NOT NULL,
				domain TEXT,
				service TEXT,
				service_data TEXT,
				reason TEXT,
				tier TEXT,
				requested INTEGER DEFAULT 0,
				prev_snapshot TEXT,
				status TEXT NOT NULL,
				error TEXT,
				expires INTEGER,
				decided_at INTEGER,
				done_at INTEGER,
				undo_of TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(ts);

			CREATE TABLE IF NOT EXISTS proposals (
				pid TEXT PRIMARY KEY,
				ts INTEGER NOT NULL,
				kind TEXT NOT NULL,
				title TEXT NOT NULL,
				summary TEXT NOT NULL,
				target_id TEXT,
				payload TEXT,
				diff_text TEXT,
				pre_snapshot TEXT,
				validation TEXT,
				status TEXT NOT NULL,
				decided_at INTEGER,
				applied_at INTEGER,
				rollback_at INTEGER,
				error TEXT,
				expires INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_proposals_status_ts ON proposals(status, ts);

			CREATE TABLE IF NOT EXISTS memory_items (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				category TEXT NOT NULL,
				key TEXT NOT NULL UNIQUE,
				content TEXT NOT NULL,
				source TEXT,
				confidence REAL DEFAULT 1.0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				expires_at INTEGER,
				active INTEGER DEFAULT 1
			);
			CREATE INDEX IF NOT EXISTS idx_memory_cat_active ON memory_items(category, active);

			CREATE TABLE IF NOT EXISTS conversations (
				session_id TEXT PRIMARY KEY,
				channel TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				metadata TEXT
			);

			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				ts INTEGER NOT NULL,
				role TEXT NOT NULL,
				text TEXT NOT NULL,
				meta TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts);

			CREATE TABLE IF NOT EXISTS baselines (
				entity_id TEXT NOT NULL,
				weekday_type TEXT NOT NULL,
				hour INTEGER NOT NULL,
				avg REAL NOT NULL,
				stddev REAL NOT NULL,
				min_val REAL NOT NULL,
				max_val REAL NOT NULL,
				sample_count INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY(entity_id, weekday_type, hour)
			);

			CREATE TABLE IF NOT EXISTS notifications (
				nid TEXT PRIMARY KEY,
				ts INTEGER NOT NULL,
				kind TEXT NOT NULL,
				level TEXT,
				title TEXT,
				message TEXT,
				tag TEXT,
				related_rule_ids TEXT,
				status TEXT NOT NULL,
				error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts);

			CREATE TABLE IF NOT EXISTS feedback (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				nid TEXT,
				kind TEXT NOT NULL,
				title TEXT,
				message TEXT,
				text TEXT,
				rules TEXT,
				muted TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(ts);
			CREATE INDEX IF NOT EXISTS idx_feedback_nid_kind ON feedback(nid, kind);
		`)
	}

	close() {
		try { this.db?.close() } catch {}
		this.db = null
	}

	migrateFromLegacyFiles({ eventsPath = P.events, actionsPath = P.actions, decisionsPath = P.decisions, notificationsPath = P.notifications, feedbackPath = P.feedback } = {}) {
		const countOf = table => Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
		if (countOf('events') === 0) {
			const rows = readJsonlAll(eventsPath)
			if (rows.length) {
				const ins = this.db.prepare('INSERT INTO events (ts, entity_id, name, old_state, new_state, is_noise) VALUES (?, ?, ?, ?, ?, 0)')
				this.db.exec('BEGIN')
				try {
					for (const r of rows) {
						if (!r?.id || !Number.isFinite(r.t)) continue
						ins.run(r.t, r.id, r.name ?? null, r.from ?? null, r.to ?? null)
					}
					this.db.exec('COMMIT')
				} catch (e) { this.db.exec('ROLLBACK'); throw e }
			}
		}
		if (countOf('actions') === 0) {
			const rows = readJsonlAll(actionsPath)
			if (rows.length) {
				const map = new Map()
				for (const r of rows) if (r?.aid) map.set(r.aid, r)
				this.db.exec('BEGIN')
				try {
					for (const r of map.values()) this.upsertAction(r)
					this.db.exec('COMMIT')
				} catch (e) { this.db.exec('ROLLBACK'); throw e }
			}
		}
		if (countOf('decisions') === 0) {
			const rows = readJsonlAll(decisionsPath)
			if (rows.length) {
				this.db.exec('BEGIN')
				try {
					for (const r of rows) this.recordDecision(r)
					this.db.exec('COMMIT')
				} catch (e) { this.db.exec('ROLLBACK'); throw e }
			}
		}
		if (countOf('notifications') === 0) {
			const rows = readJsonlAll(notificationsPath)
			if (rows.length) {
				const map = new Map()
				for (const r of rows) if (r?.nid) map.set(r.nid, r)
				this.db.exec('BEGIN')
				try {
					for (const r of map.values()) this.upsertNotification(r)
					this.db.exec('COMMIT')
				} catch (e) { this.db.exec('ROLLBACK'); throw e }
			}
		}
		if (countOf('feedback') === 0) {
			const rows = readJsonlAll(feedbackPath)
			if (rows.length) {
				this.db.exec('BEGIN')
				try {
					for (const r of rows) this.recordFeedback(r)
					this.db.exec('COMMIT')
				} catch (e) { this.db.exec('ROLLBACK'); throw e }
			}
		}
	}

	recordEvent({ t, id, name = null, from = null, to = null, isNoise = false }) {
		this.db.prepare('INSERT INTO events (ts, entity_id, name, old_state, new_state, is_noise) VALUES (?, ?, ?, ?, ?, ?)')
			.run(t, id, name, from, to, isNoise ? 1 : 0)
	}

	recentEvents({ sinceMs = 0, entityId = null, limit = 500 } = {}) {
		if (entityId) {
			return this.db.prepare('SELECT ts AS t, entity_id AS id, name, old_state AS "from", new_state AS "to", is_noise FROM events WHERE ts >= ? AND entity_id = ? ORDER BY ts DESC LIMIT ?')
				.all(sinceMs, entityId, limit).reverse()
		}
		return this.db.prepare('SELECT ts AS t, entity_id AS id, name, old_state AS "from", new_state AS "to", is_noise FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?')
			.all(sinceMs, limit).reverse()
	}

	recordSensorSample(entityId, value, ts) {
		this.db.prepare('INSERT INTO sensor_samples (ts, entity_id, value) VALUES (?, ?, ?)').run(ts, entityId, value)
	}

	getRecentSensorSamples(sinceMs, entityId = null) {
		if (entityId) {
			return this.db.prepare('SELECT ts, entity_id, value FROM sensor_samples WHERE ts >= ? AND entity_id = ? ORDER BY ts ASC').all(sinceMs, entityId)
		}
		return this.db.prepare('SELECT ts, entity_id, value FROM sensor_samples WHERE ts >= ? ORDER BY ts ASC').all(sinceMs)
	}

	pruneSensorSamples(beforeMs) {
		this.db.prepare('DELETE FROM sensor_samples WHERE ts < ?').run(beforeMs)
	}

	upsertBaseline({ entity_id, weekday_type, hour, avg, stddev, min_val, max_val, sample_count, updated_at }) {
		this.db.prepare(`
			INSERT INTO baselines (entity_id, weekday_type, hour, avg, stddev, min_val, max_val, sample_count, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(entity_id, weekday_type, hour) DO UPDATE SET
				avg = excluded.avg, stddev = excluded.stddev, min_val = excluded.min_val,
				max_val = excluded.max_val, sample_count = excluded.sample_count, updated_at = excluded.updated_at
		`).run(entity_id, weekday_type, hour, avg, stddev, min_val, max_val, sample_count, updated_at)
	}

	getBaseline(entityId, weekdayType, hour) {
		return this.db.prepare('SELECT * FROM baselines WHERE entity_id = ? AND weekday_type = ? AND hour = ?').get(entityId, weekdayType, hour) ?? null
	}

	listBaselines() {
		return this.db.prepare('SELECT * FROM baselines').all()
	}

	replaceBaselines(rows = []) {
		const ins = this.db.prepare(`
			INSERT INTO baselines (entity_id, weekday_type, hour, avg, stddev, min_val, max_val, sample_count, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		this.db.exec('BEGIN')
		try {
			this.db.exec('DELETE FROM baselines')
			for (const r of rows) {
				ins.run(r.entity_id, r.weekday_type, r.hour, r.avg, r.stddev, r.min_val, r.max_val, r.sample_count, r.updated_at)
			}
			this.db.exec('COMMIT')
		} catch (e) { this.db.exec('ROLLBACK'); throw e }
	}

	recordDecision(entry) {
		const ts = typeof entry.ts === 'number' ? entry.ts : (Date.parse(entry.ts) || Date.now())
		this.db.prepare(`
			INSERT INTO decisions (ts, reasons, brain, model, effort, total_ms, tokens, usage, summary, applied, error, skipped, deferred)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			ts,
			JSON.stringify(entry.reasons ?? []),
			entry.brain ?? null,
			entry.model ?? null,
			entry.effort ?? null,
			entry.total_ms ?? null,
			entry.tokens ?? null,
			jsonOrNull(entry.usage),
			entry.summary ?? null,
			jsonOrNull(entry.applied),
			entry.error ?? null,
			entry.skipped ? 1 : 0,
			entry.deferred ? 1 : 0,
		)
	}

	upsertAction(rec) {
		const ts = typeof rec.ts === 'number' ? rec.ts : (Date.parse(rec.ts) || Date.now())
		const decidedAt = rec.decided_at == null ? null : (typeof rec.decided_at === 'number' ? rec.decided_at : Date.parse(rec.decided_at) || null)
		const doneAt = rec.done_at == null ? null : (typeof rec.done_at === 'number' ? rec.done_at : Date.parse(rec.done_at) || null)
		const domain = rec.domain ?? rec.entity_id?.split?.('.')[0] ?? null
		const service = rec.service ?? rec.action ?? null
		this.db.prepare(`
			INSERT INTO actions (aid, ts, entity_id, domain, service, service_data, reason, tier, requested, prev_snapshot, status, error, expires, decided_at, done_at, undo_of)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(aid) DO UPDATE SET
				status = excluded.status, error = excluded.error, decided_at = COALESCE(excluded.decided_at, actions.decided_at),
				done_at = COALESCE(excluded.done_at, actions.done_at), prev_snapshot = COALESCE(excluded.prev_snapshot, actions.prev_snapshot)
		`).run(
			rec.aid, ts, rec.entity_id, domain, service,
			jsonOrNull(rec.service_data), rec.reason ?? null, rec.tier ?? null,
			rec.requested ? 1 : 0, jsonOrNull(rec.prev_snapshot ?? (rec.prev != null ? { state: rec.prev } : null)),
			rec.status, rec.error ?? null, rec.expires ?? null, decidedAt, doneAt, rec.undo_of ?? null,
		)
	}

	getAction(aid) {
		const r = this.db.prepare('SELECT * FROM actions WHERE aid = ?').get(aid)
		return r ? this.#mapAction(r) : null
	}

	recentActions({ sinceMs = 0, limit = 20 } = {}) {
		return this.db.prepare('SELECT * FROM actions WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(sinceMs, limit).reverse().map(r => this.#mapAction(r))
	}

	#mapAction(r) {
		return {
			aid: r.aid, ts: new Date(r.ts).toISOString(), entity_id: r.entity_id, domain: r.domain,
			action: r.service, service: r.service, service_data: parseJson(r.service_data, null),
			reason: r.reason, tier: r.tier, requested: !!r.requested,
			prev_snapshot: parseJson(r.prev_snapshot, null), status: r.status, error: r.error,
			expires: r.expires, decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null,
			done_at: r.done_at ? new Date(r.done_at).toISOString() : null, undo_of: r.undo_of,
		}
	}

	upsertProposal(p) {
		this.db.prepare(`
			INSERT INTO proposals (pid, ts, kind, title, summary, target_id, payload, diff_text, pre_snapshot, validation, status, decided_at, applied_at, rollback_at, error, expires)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(pid) DO UPDATE SET
				status = excluded.status, decided_at = COALESCE(excluded.decided_at, proposals.decided_at),
				applied_at = COALESCE(excluded.applied_at, proposals.applied_at),
				rollback_at = COALESCE(excluded.rollback_at, proposals.rollback_at),
				error = excluded.error, pre_snapshot = COALESCE(excluded.pre_snapshot, proposals.pre_snapshot),
				validation = COALESCE(excluded.validation, proposals.validation)
		`).run(
			p.pid, p.ts, p.kind, p.title, p.summary, p.target_id ?? null,
			jsonOrNull(p.payload), p.diff_text ?? null, jsonOrNull(p.pre_snapshot), jsonOrNull(p.validation),
			p.status, p.decided_at ?? null, p.applied_at ?? null, p.rollback_at ?? null, p.error ?? null, p.expires ?? null,
		)
	}

	getProposal(pid) {
		const r = this.db.prepare('SELECT * FROM proposals WHERE pid = ?').get(pid)
		return r ? this.#mapProposal(r) : null
	}

	listProposals({ status = null, limit = 50 } = {}) {
		const rows = status
			? this.db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY ts DESC LIMIT ?').all(status, limit)
			: this.db.prepare('SELECT * FROM proposals ORDER BY ts DESC LIMIT ?').all(limit)
		return rows.map(r => this.#mapProposal(r))
	}

	expirePendingProposals(now = Date.now()) {
		const rows = this.db.prepare("SELECT * FROM proposals WHERE status = 'pending' AND expires IS NOT NULL AND expires < ?").all(now)
		if (!rows.length) return []
		this.db.prepare("UPDATE proposals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires IS NOT NULL AND expires < ?").run(now, now)
		return rows.map(r => this.#mapProposal({ ...r, status: 'expired', decided_at: now }))
	}

	#mapProposal(r) {
		return {
			...r,
			payload: parseJson(r.payload, null),
			pre_snapshot: parseJson(r.pre_snapshot, null),
			validation: parseJson(r.validation, null),
		}
	}

	upsertMemory({ category, key, content, source = 'agent', confidence = 1.0, expiresAt = null, now = Date.now() }) {
		this.db.prepare(`
			INSERT INTO memory_items (category, key, content, source, confidence, created_at, updated_at, expires_at, active)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
			ON CONFLICT(key) DO UPDATE SET
				category = excluded.category, content = excluded.content, source = excluded.source,
				confidence = excluded.confidence, updated_at = excluded.updated_at,
				expires_at = excluded.expires_at, active = 1
		`).run(category, key, content, source, confidence, now, now, expiresAt)
	}

	deleteMemory(key) {
		const r = this.db.prepare('UPDATE memory_items SET active = 0, updated_at = ? WHERE key = ? AND active = 1').run(Date.now(), key)
		return (r?.changes ?? 0) > 0
	}

	listMemory({ category = null, includeExpired = false, now = Date.now() } = {}) {
		const clauses = ['active = 1']
		const params = []
		if (!includeExpired) {
			clauses.push('(expires_at IS NULL OR expires_at > ?)')
			params.push(now)
		}
		if (category) {
			clauses.push('category = ?')
			params.push(category)
		}
		return this.db.prepare(`SELECT * FROM memory_items WHERE ${clauses.join(' AND ')} ORDER BY category ASC, updated_at DESC`).all(...params)
	}

	searchMemory(query, { category = null, limit = 20, now = Date.now() } = {}) {
		const q = `%${String(query ?? '').trim()}%`
		const clauses = ['active = 1', '(expires_at IS NULL OR expires_at > ?)', '(key LIKE ? OR content LIKE ?)']
		const params = [now, q, q]
		if (category) {
			clauses.push('category = ?')
			params.push(category)
		}
		params.push(limit)
		return this.db.prepare(`SELECT * FROM memory_items WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...params)
	}

	ensureConversation(sessionId, channel = 'ha_assist', metadata = null, now = Date.now()) {
		this.db.prepare(`
			INSERT INTO conversations (session_id, channel, created_at, updated_at, metadata)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at
		`).run(sessionId, channel, now, now, jsonOrNull(metadata))
	}

	appendMessage(sessionId, role, text, meta = null, now = Date.now()) {
		this.db.prepare('INSERT INTO messages (session_id, ts, role, text, meta) VALUES (?, ?, ?, ?, ?)')
			.run(sessionId, now, role, text, jsonOrNull(meta))
		this.db.prepare('UPDATE conversations SET updated_at = ? WHERE session_id = ?').run(now, sessionId)
	}

	recentMessages(sessionId, { limit = 20, sinceMs = 0 } = {}) {
		return this.db.prepare('SELECT ts, role, text, meta FROM messages WHERE session_id = ? AND ts >= ? ORDER BY id DESC LIMIT ?')
			.all(sessionId, sinceMs, limit).reverse().map(r => ({ ...r, meta: parseJson(r.meta, null) }))
	}

	recentConversationMessages({ sinceMs = 0, limit = 30 } = {}) {
		return this.db.prepare('SELECT session_id, ts, role, text, meta FROM messages WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT ?')
			.all(sinceMs, limit).reverse().map(r => ({ ...r, meta: parseJson(r.meta, null) }))
	}

	upsertNotification(rec) {
		const ts = typeof rec.ts === 'number' ? rec.ts : (Date.parse(rec.ts) || Date.now())
		this.db.prepare(`
			INSERT INTO notifications (nid, ts, kind, level, title, message, tag, related_rule_ids, status, error)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(nid) DO UPDATE SET
				status = excluded.status, error = excluded.error
		`).run(
			rec.nid, ts, rec.kind ?? 'info', rec.level ?? null,
			rec.title ?? null, rec.message ?? null, rec.tag ?? null,
			jsonOrNull(rec.related_rule_ids ?? []), rec.status ?? 'sent', rec.error ?? null,
		)
	}

	recentNotifications({ sinceMs = 0, limit = 50 } = {}) {
		return this.db.prepare('SELECT * FROM notifications WHERE ts >= ? ORDER BY ts DESC LIMIT ?')
			.all(sinceMs, limit).reverse().map(r => ({
				...r,
				ts: new Date(r.ts).toISOString(),
				related_rule_ids: parseJson(r.related_rule_ids, []),
			}))
	}

	recordFeedback(rec) {
		const ts = typeof rec.ts === 'number' ? rec.ts : (Date.parse(rec.ts) || Date.now())
		this.db.prepare(`
			INSERT INTO feedback (ts, nid, kind, title, message, text, rules, muted)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			ts, rec.nid ?? null, rec.kind, rec.title ?? null, rec.message ?? null,
			rec.text ?? null, jsonOrNull(rec.rules ?? []), jsonOrNull(rec.muted ?? []),
		)
	}

	recentFeedback({ sinceMs = 0, limit = 50 } = {}) {
		return this.db.prepare('SELECT * FROM feedback WHERE ts >= ? ORDER BY ts DESC LIMIT ?')
			.all(sinceMs, limit).reverse().map(r => ({
				...r,
				ts: new Date(r.ts).toISOString(),
				rules: parseJson(r.rules, []),
				muted: parseJson(r.muted, []),
			}))
	}

	maintain(now = Date.now(), { eventDays = 60, sampleDays = 30, decisionDays = 90, messageDays = 90, notificationDays = 90, feedbackDays = 180 } = {}) {
		const DAY = 86400000
		const del = (sql, cutoff) => Number(this.db.prepare(sql).run(cutoff)?.changes ?? 0)
		const deleted = {
			events: del('DELETE FROM events WHERE ts < ?', now - eventDays * DAY),
			sensor_samples: del('DELETE FROM sensor_samples WHERE ts < ?', now - sampleDays * DAY),
			decisions: del('DELETE FROM decisions WHERE ts < ?', now - decisionDays * DAY),
			messages: del('DELETE FROM messages WHERE ts < ?', now - messageDays * DAY),
			notifications: del('DELETE FROM notifications WHERE ts < ?', now - notificationDays * DAY),
			feedback: del('DELETE FROM feedback WHERE ts < ?', now - feedbackDays * DAY),
		}
		deleted.conversations = Number(
			this.db.prepare('DELETE FROM conversations WHERE updated_at < ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = conversations.session_id)')
				.run(now - messageDays * DAY)?.changes ?? 0,
		)
		this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
		return deleted
	}

	stats() {
		const c = t => Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n)
		return {
			events: c('events'),
			sensor_samples: c('sensor_samples'),
			decisions: c('decisions'),
			actions: c('actions'),
			proposals: c('proposals'),
			proposals_pending: Number(this.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'").get().n),
			memory_items: Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_items WHERE active = 1').get().n),
			conversations: c('conversations'),
			notifications: c('notifications'),
			feedback: c('feedback'),
		}
	}
}
