// SQLite 영속 저장소 (Node 22 내장 node:sqlite, WAL 모드). 기존 JSONL 기록이 있으면 최초 1회 자동 이관한다.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { P, DAY, kst, readJsonlAll } from '../util.mjs'
import {
	localEmbed, cosineSimilarity, lexicalSimilarity, tokenize,
	packEmbedding, unpackEmbedding, DEFAULT_SEMANTIC_THRESHOLD,
} from './embeddings.mjs'

const jsonOrNull = v => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v))
const parseJson = (s, fallback = null) => {
	if (s == null || s === '') return fallback
	try { return JSON.parse(s) } catch { return fallback }
}

export const MEMORY_CAT_RANK_SQL = `CASE category
	WHEN 'standing_order' THEN 1
	WHEN 'preference' THEN 2
	WHEN 'rejection' THEN 3
	WHEN 'pattern' THEN 4
	WHEN 'incident' THEN 5
	ELSE 6
END`

export const MEMORY_DEFAULT_PRIORITY = {
	standing_order: 5,
	preference: 4,
	rejection: 4,
	pattern: 3,
	incident: 2,
}

// 기억을 바꾸고 지울 수 있는 권한은 출처에 따라 세 단계로 나뉜다.
// 1) 사용자 직접 조작(콘솔·CLI·알림 답장 판단의 user): 무엇이든 바꿀 수 있다.
// 2) 사용자에게서 나온 것(Assist 대화의 기억 도구·대화 직후 추출기·제안 거절·사용자의 자동화 직접 수정): 1)이 만든 것과 고정된 것은 못 바꾼다.
// 3) 백그라운드 자동(cycle·agent·tool·정리 등): 1)·2)가 만든 것과 고정된 것은 못 바꾼다.
export const USER_SOURCES = new Set(['user', 'cli', 'console'])
export const CONVERSATION_SOURCES = new Set(['assist_user', 'extractor', 'user_rejection', 'user_edit'])

// 이 출처(source)가 기존 기억(prev)을 바꾸거나 지울 수 없으면 그 까닭을, 할 수 있으면 null을 돌려준다.
export function memoryWriteBlock(prev, source, { force = false } = {}) {
	if (!prev || force || USER_SOURCES.has(source)) return null
	const key = prev.key
	if (prev.pinned) return `고정(pinned)된 기억(${key})은 자동으로 바꾸거나 지울 수 없다. 웹 콘솔(메모리 관리)이나 CLI(node src/cli.mjs memory)에서 사용자가 직접 바꿔야 한다.`
	if (USER_SOURCES.has(prev.source)) return `사용자가 직접 등록한 기억(${key})은 자동으로 바꾸거나 지울 수 없다. 웹 콘솔이나 CLI에서 바꿔야 한다.`
	if (CONVERSATION_SOURCES.has(prev.source) && !CONVERSATION_SOURCES.has(source)) return `사용자 대화에서 저장한 기억(${key})은 백그라운드 판단이 바꾸거나 지울 수 없다. 사용자와의 대화나 웹 콘솔에서 바꿔야 한다.`
	return null
}

const normalizeEntityIds = v => {
	if (!v) return []
	const arr = Array.isArray(v) ? v : typeof v === 'string' ? parseJson(v, v.split(',')) : []
	return [...new Set((Array.isArray(arr) ? arr : []).map(s => String(s ?? '').trim()).filter(Boolean))].slice(0, 16)
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
			CREATE INDEX IF NOT EXISTS idx_notifications_tag_ts ON notifications(tag, ts);
			CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);

			CREATE TABLE IF NOT EXISTS memory_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				memory_key TEXT NOT NULL,
				op TEXT NOT NULL,
				prev_category TEXT,
				prev_content TEXT,
				prev_meta TEXT,
				new_category TEXT,
				new_content TEXT,
				new_meta TEXT,
				source TEXT,
				ts INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_mem_hist_key_ts ON memory_history(memory_key, ts);

			CREATE TABLE IF NOT EXISTS implicit_feedback (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				kind TEXT NOT NULL,
				entity_id TEXT,
				ref_id TEXT,
				score REAL DEFAULT 0,
				detail TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_impl_fb_ts ON implicit_feedback(ts);
			CREATE INDEX IF NOT EXISTS idx_impl_fb_kind_ts ON implicit_feedback(kind, ts);

			CREATE TABLE IF NOT EXISTS lessons (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				key TEXT NOT NULL UNIQUE,
				scope TEXT NOT NULL DEFAULT 'all',
				condition_text TEXT NOT NULL,
				rule_text TEXT NOT NULL,
				evidence TEXT,
				evidence_count INTEGER DEFAULT 1,
				confidence REAL DEFAULT 0.7,
				active INTEGER DEFAULT 1,
				pinned INTEGER DEFAULT 0,
				source TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_used_at INTEGER,
				use_count INTEGER DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_lessons_scope_active ON lessons(scope, active);

			CREATE TABLE IF NOT EXISTS experiments (
				eid TEXT PRIMARY KEY,
				ts INTEGER NOT NULL,
				kind TEXT NOT NULL,
				ref_id TEXT,
				title TEXT NOT NULL,
				baseline_metrics TEXT,
				eval_after_ts INTEGER NOT NULL,
				evaluated_at INTEGER,
				after_metrics TEXT,
				verdict TEXT,
				notes TEXT,
				status TEXT NOT NULL DEFAULT 'active'
			);
			CREATE INDEX IF NOT EXISTS idx_experiments_status_eval ON experiments(status, eval_after_ts);

			CREATE TABLE IF NOT EXISTS daily_rollups (
				date TEXT PRIMARY KEY,
				weekday TEXT,
				runs INTEGER DEFAULT 0,
				failed INTEGER DEFAULT 0,
				skipped INTEGER DEFAULT 0,
				noop INTEGER DEFAULT 0,
				tokens INTEGER DEFAULT 0,
				alerts INTEGER DEFAULT 0,
				infos INTEGER DEFAULT 0,
				summaries INTEGER DEFAULT 0,
				feedback_json TEXT,
				actions_json TEXT,
				entities_json TEXT,
				sensor_stats_json TEXT,
				created_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS monthly_rollups (
				month TEXT PRIMARY KEY,
				days INTEGER DEFAULT 0,
				runs INTEGER DEFAULT 0,
				failed INTEGER DEFAULT 0,
				noop INTEGER DEFAULT 0,
				tokens INTEGER DEFAULT 0,
				alerts INTEGER DEFAULT 0,
				summaries INTEGER DEFAULT 0,
				sensor_stats_json TEXT,
				top_entities_json TEXT,
				updated_at INTEGER NOT NULL
			);
		`)
		this.#addColumn('actions', 'name', 'TEXT')
		// 상태 변화를 일으킨 쪽(user·device·automation·agent)과 그 주체(자동화 entity_id 등). 예전 기록은 NULL.
		this.#addColumn('events', 'origin', 'TEXT')
		this.#addColumn('events', 'actor', 'TEXT')
		// 실험 판정 뒤 후속 조치(규칙 원복·롤백 알림·교훈 비활성화)를 했는지
		this.#addColumn('experiments', 'actioned_at', 'INTEGER')
		this.#addColumn('sensor_samples', 'context', 'TEXT')
		this.#addColumn('memory_items', 'priority', 'INTEGER DEFAULT 3')
		this.#addColumn('memory_items', 'pinned', 'INTEGER DEFAULT 0')
		this.#addColumn('memory_items', 'entity_ids', 'TEXT')
		this.#addColumn('memory_items', 'last_accessed_at', 'INTEGER')
		this.#addColumn('memory_items', 'hit_count', 'INTEGER DEFAULT 0')
		this.#addColumn('memory_items', 'embedding', 'TEXT')
		this.#addColumn('memory_items', 'evidence_count', 'INTEGER DEFAULT 1')
		this.hasFts5 = false
		try {
			this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(key, content, entity_ids, tokenize='unicode61');")
			this.hasFts5 = true
			this.#syncFtsIfEmpty()
		} catch {
			this.hasFts5 = false
		}
	}

	#syncFtsIfEmpty() {
		if (!this.hasFts5) return
		const ftsCount = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_fts').get().n)
		const memCount = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_items WHERE active = 1').get().n)
		if (memCount > 0 && ftsCount === 0) this.rebuildMemoryFts()
	}

	rebuildMemoryFts() {
		if (!this.hasFts5) return
		this.db.exec('DELETE FROM memory_fts')
		const ins = this.db.prepare('INSERT INTO memory_fts (key, content, entity_ids) VALUES (?, ?, ?)')
		for (const r of this.db.prepare('SELECT key, content, entity_ids FROM memory_items WHERE active = 1').all()) {
			const eids = normalizeEntityIds(r.entity_ids).join(' ')
			ins.run(r.key, r.content, eids)
		}
	}

	// 예전 판 DB에 없는 칼럼을 더한다(이미 있으면 그대로).
	#addColumn(table, column, type) {
		const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
		if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
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
		// name 칼럼이 생기기 전에 들어간 행동 기록은 JSONL에서 이름을 채운다(한 번만, 빈 것만).
		if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM actions WHERE name IS NULL').get().n) > 0) {
			const names = new Map()
			for (const r of readJsonlAll(actionsPath)) if (r?.aid && r.name) names.set(r.aid, r.name)
			if (names.size) {
				const upd = this.db.prepare('UPDATE actions SET name = ? WHERE aid = ? AND name IS NULL')
				for (const [aid, name] of names) upd.run(name, aid)
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

	recordEvent({ t, id, name = null, from = null, to = null, isNoise = false, origin = null, actor = null }) {
		this.db.prepare('INSERT INTO events (ts, entity_id, name, old_state, new_state, is_noise, origin, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
			.run(t, id, name, from, to, isNoise ? 1 : 0, origin, actor)
	}

	recentEvents({ sinceMs = 0, entityId = null, limit = 500 } = {}) {
		if (entityId) {
			return this.db.prepare('SELECT ts AS t, entity_id AS id, name, old_state AS "from", new_state AS "to", is_noise, origin, actor FROM events WHERE ts >= ? AND entity_id = ? ORDER BY ts DESC LIMIT ?')
				.all(sinceMs, entityId, limit).reverse()
		}
		return this.db.prepare('SELECT ts AS t, entity_id AS id, name, old_state AS "from", new_state AS "to", is_noise, origin, actor FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?')
			.all(sinceMs, limit).reverse()
	}

	recordSensorSample(entityId, value, ts, context = null) {
		this.db.prepare('INSERT INTO sensor_samples (ts, entity_id, value, context) VALUES (?, ?, ?, ?)').run(ts, entityId, value, context)
	}

	// 여러 표본을 한 트랜잭션으로. rows: [{ entity_id, value, ts, context? }]
	recordSensorSamples(rows = []) {
		if (!rows.length) return 0
		const ins = this.db.prepare('INSERT INTO sensor_samples (ts, entity_id, value, context) VALUES (?, ?, ?, ?)')
		this.db.exec('BEGIN')
		try {
			for (const r of rows) ins.run(r.ts, r.entity_id, r.value, r.context ?? null)
			this.db.exec('COMMIT')
		} catch (e) { this.db.exec('ROLLBACK'); throw e }
		return rows.length
	}

	getRecentSensorSamples(sinceMs, entityId = null) {
		if (entityId) {
			return this.db.prepare('SELECT ts, entity_id, value, context FROM sensor_samples WHERE ts >= ? AND entity_id = ? ORDER BY ts ASC').all(sinceMs, entityId)
		}
		return this.db.prepare('SELECT ts, entity_id, value, context FROM sensor_samples WHERE ts >= ? ORDER BY ts ASC').all(sinceMs)
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
			INSERT INTO actions (aid, ts, entity_id, domain, service, service_data, reason, tier, requested, prev_snapshot, status, error, expires, decided_at, done_at, undo_of, name)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(aid) DO UPDATE SET
				status = excluded.status, error = excluded.error, decided_at = COALESCE(excluded.decided_at, actions.decided_at),
				done_at = COALESCE(excluded.done_at, actions.done_at), prev_snapshot = COALESCE(excluded.prev_snapshot, actions.prev_snapshot),
				expires = COALESCE(excluded.expires, actions.expires), name = COALESCE(excluded.name, actions.name)
		`).run(
			rec.aid, ts, rec.entity_id, domain, service,
			jsonOrNull(rec.service_data), rec.reason ?? null, rec.tier ?? null,
			rec.requested ? 1 : 0, jsonOrNull(rec.prev_snapshot ?? (rec.prev != null ? { state: rec.prev } : null)),
			rec.status, rec.error ?? null, rec.expires ?? null, decidedAt, doneAt, rec.undo_of ?? null, rec.name ?? null,
		)
	}

	pendingActions() {
		return this.db.prepare("SELECT * FROM actions WHERE status = 'pending' ORDER BY ts ASC").all().map(r => this.#mapAction(r))
	}

	getAction(aid) {
		const r = this.db.prepare('SELECT * FROM actions WHERE aid = ?').get(aid)
		return r ? this.#mapAction(r) : null
	}

	recentActions({ sinceMs = 0, limit = 20 } = {}) {
		return this.db.prepare('SELECT * FROM actions WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(sinceMs, limit).reverse().map(r => this.#mapAction(r))
	}

	#mapAction(r) {
		const prevSnapshot = parseJson(r.prev_snapshot, null)
		const serviceData = parseJson(r.service_data, null)
		const out = {
			aid: r.aid, ts: new Date(r.ts).toISOString(), entity_id: r.entity_id, name: r.name ?? r.entity_id, domain: r.domain,
			action: r.service, service: r.service,
			reason: r.reason, tier: r.tier, requested: !!r.requested,
			prev: prevSnapshot?.state ?? null, prev_snapshot: prevSnapshot, status: r.status, error: r.error,
			expires: r.expires, decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null,
			done_at: r.done_at ? new Date(r.done_at).toISOString() : null, undo_of: r.undo_of,
		}
		if (serviceData && Object.keys(serviceData).length) out.service_data = serviceData
		return out
	}

	upsertProposal(p) {
		this.db.prepare(`
			INSERT INTO proposals (pid, ts, kind, title, summary, target_id, payload, diff_text, pre_snapshot, validation, status, decided_at, applied_at, rollback_at, error, expires)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(pid) DO UPDATE SET
				status = excluded.status, decided_at = COALESCE(excluded.decided_at, proposals.decided_at),
				payload = COALESCE(excluded.payload, proposals.payload),
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

	// 제안 상태를 from일 때만 to로 바꾼다(원자적 비교 후 교체). 데몬과 CLI가 같은 DB를 함께 쓰므로 프로세스 사이에서도 안전하다.
	// 바뀌었으면 바뀐 제안을, 그사이 다른 쪽이 먼저 처리했으면 null을 돌려준다.
	transitionProposal(pid, from, to, { decidedAt = null, error } = {}) {
		const r = this.db.prepare(`
			UPDATE proposals SET status = ?, decided_at = COALESCE(?, decided_at)${error !== undefined ? ', error = ?' : ''}
			WHERE pid = ? AND status = ?
			RETURNING *
		`).get(...[to, decidedAt, ...(error !== undefined ? [error] : []), pid, from])
		return r ? this.#mapProposal(r) : null
	}

	expirePendingProposals(now = Date.now()) {
		return this.db.prepare(`
			UPDATE proposals SET status = 'expired', decided_at = ?
			WHERE status = 'pending' AND expires IS NOT NULL AND expires < ?
			RETURNING *
		`).all(now, now).map(r => this.#mapProposal(r))
	}

	// 적용 도중 프로세스가 죽어 'applying'에 멈춘 제안을 'interrupted'로 돌린다(결과를 알 수 없으니 사용자 확인·롤백 대상).
	recoverStuckProposals(now = Date.now(), olderThanMs = 15 * 60000) {
		return this.db.prepare(`
			UPDATE proposals SET status = 'interrupted', error = ?
			WHERE status = 'applying' AND COALESCE(decided_at, ts) < ?
			RETURNING *
		`).all('적용 도중 중단되어 결과를 알 수 없어요. HA에서 이 설정을 확인하고, 필요하면 [롤백]하세요.', now - olderThanMs).map(r => this.#mapProposal(r))
	}

	#mapProposal(r) {
		return {
			...r,
			payload: parseJson(r.payload, null),
			pre_snapshot: parseJson(r.pre_snapshot, null),
			validation: parseJson(r.validation, null),
		}
	}

	#mapMemory(r) {
		if (!r) return null
		const emb = unpackEmbedding(parseJson(r.embedding, null))
		return {
			...r,
			priority: r.priority ?? MEMORY_DEFAULT_PRIORITY[r.category] ?? 3,
			pinned: Boolean(r.pinned),
			entity_ids: normalizeEntityIds(r.entity_ids),
			hit_count: r.hit_count ?? 0,
			evidence_count: r.evidence_count ?? 1,
			embedding: emb,
			embedding_model: emb?.model ?? null,
		}
	}

	#syncFtsRow(key, content, entityIds, active = true) {
		if (!this.hasFts5) return
		try {
			this.db.prepare('DELETE FROM memory_fts WHERE key = ?').run(key)
			if (active && content) {
				this.db.prepare('INSERT INTO memory_fts (key, content, entity_ids) VALUES (?, ?, ?)').run(key, content, normalizeEntityIds(entityIds).join(' '))
			}
		} catch {}
	}

	#logMemoryHistory({ key, op, prev, next, source, now }) {
		const metaOf = m => (m ? JSON.stringify({
			priority: m.priority ?? 3,
			pinned: Boolean(m.pinned),
			confidence: m.confidence ?? 1.0,
			expires_at: m.expires_at ?? null,
			entity_ids: normalizeEntityIds(m.entity_ids),
			evidence_count: m.evidence_count ?? 1,
			active: m.active ?? 1,
		}) : null)
		this.db.prepare(`
			INSERT INTO memory_history (memory_key, op, prev_category, prev_content, prev_meta, new_category, new_content, new_meta, source, ts)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			key, op,
			prev?.category ?? null, prev?.content ?? null, metaOf(prev),
			next?.category ?? null, next?.content ?? null, metaOf(next),
			source ?? 'agent', now,
		)
	}

	getMemory(key) {
		const r = this.db.prepare('SELECT * FROM memory_items WHERE key = ?').get(key)
		return r ? this.#mapMemory(r) : null
	}

	upsertMemory({
		category, key, content, source = 'agent', confidence = 1.0, expiresAt = null,
		priority = null, pinned = null, entityIds = null, evidenceCount = null, embedding = null, now = Date.now(),
	}) {
		const prev = this.db.prepare('SELECT * FROM memory_items WHERE key = ?').get(key)
		const resolvedPriority = Number.isInteger(priority) ? Math.min(Math.max(priority, 1), 5)
			: (prev?.priority ?? MEMORY_DEFAULT_PRIORITY[category] ?? 3)
		const isUserSrc = USER_SOURCES.has(source)
		// 고정(pinned) 상태는 사용자가 명시적으로 해제하지 않는 한 자동 갱신에서 유지된다.
		const resolvedPinned = pinned === null || pinned === undefined
			? (prev ? (prev.pinned ? 1 : 0) : (category === 'standing_order' && isUserSrc ? 1 : 0))
			: (pinned ? 1 : (prev?.pinned && !isUserSrc ? 1 : 0))
		const resolvedEntities = entityIds != null
			? normalizeEntityIds(entityIds)
			: (prev ? normalizeEntityIds(prev.entity_ids) : [])
		const resolvedEvidence = Number.isInteger(evidenceCount) && evidenceCount > 0
			? evidenceCount
			: (prev ? (prev.evidence_count ?? 1) + 1 : 1)
		const resolvedConf = Number.isFinite(Number(confidence)) ? Math.min(Math.max(Number(confidence), 0), 1) : (prev?.confidence ?? 1.0)
		const resolvedEmbed = unpackEmbedding(embedding)
			?? packEmbedding(localEmbed(`${key} ${content} ${resolvedEntities.join(' ')}`), 'local')
		const nextRow = {
			category, key, content, source, confidence: resolvedConf,
			expires_at: expiresAt, priority: resolvedPriority, pinned: resolvedPinned,
			entity_ids: resolvedEntities, evidence_count: resolvedEvidence, active: 1,
		}
		this.db.prepare(`
			INSERT INTO memory_items (category, key, content, source, confidence, created_at, updated_at, expires_at, active, priority, pinned, entity_ids, last_accessed_at, hit_count, embedding, evidence_count)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, 0, ?, ?)
			ON CONFLICT(key) DO UPDATE SET
				category = excluded.category, content = excluded.content, source = excluded.source,
				confidence = excluded.confidence, updated_at = excluded.updated_at,
				expires_at = excluded.expires_at, active = 1,
				priority = excluded.priority, pinned = excluded.pinned,
				entity_ids = excluded.entity_ids, embedding = excluded.embedding,
				evidence_count = excluded.evidence_count
		`).run(
			category, key, content, source, resolvedConf, now, now, expiresAt,
			resolvedPriority, resolvedPinned, jsonOrNull(resolvedEntities), jsonOrNull(resolvedEmbed), resolvedEvidence,
		)
		this.#syncFtsRow(key, content, resolvedEntities, true)
		this.#logMemoryHistory({ key, op: prev ? 'update' : 'create', prev, next: nextRow, source, now })
		return this.getMemory(key)
	}

	setMemoryPinned(key, pinned, { source = 'user', now = Date.now() } = {}) {
		const prev = this.db.prepare('SELECT * FROM memory_items WHERE key = ? AND active = 1').get(key)
		if (!prev) return null
		const pinVal = pinned ? 1 : 0
		this.db.prepare('UPDATE memory_items SET pinned = ?, updated_at = ? WHERE key = ?').run(pinVal, now, key)
		const next = { ...prev, pinned: pinVal }
		this.#logMemoryHistory({ key, op: pinVal ? 'pin' : 'unpin', prev, next, source, now })
		return this.getMemory(key)
	}

	deleteMemoryDetailed(key, { source = 'agent', force = false, now = Date.now() } = {}) {
		const prev = this.db.prepare('SELECT * FROM memory_items WHERE key = ? AND active = 1').get(key)
		if (!prev) return { ok: false, notFound: true, error: `기억을 찾지 못함: ${key}` }
		const blocked = memoryWriteBlock(prev, source, { force })
		if (blocked) return { ok: false, protected: true, error: blocked }
		const r = this.db.prepare('UPDATE memory_items SET active = 0, updated_at = ? WHERE key = ? AND active = 1').run(now, key)
		if ((r?.changes ?? 0) > 0) {
			this.#syncFtsRow(key, null, null, false)
			this.#logMemoryHistory({ key, op: 'delete', prev, next: { ...prev, active: 0 }, source, now })
			return { ok: true }
		}
		return { ok: false, notFound: true }
	}

	deleteMemory(key, opts = {}) {
		return this.deleteMemoryDetailed(key, opts).ok
	}

	archiveExpiredMemory(now = Date.now()) {
		const expired = this.db.prepare('SELECT * FROM memory_items WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?').all(now)
		if (!expired.length) return []
		const upd = this.db.prepare('UPDATE memory_items SET active = 0, updated_at = ? WHERE key = ?')
		for (const prev of expired) {
			upd.run(now, prev.key)
			this.#syncFtsRow(prev.key, null, null, false)
			this.#logMemoryHistory({ key: prev.key, op: 'expire', prev, next: { ...prev, active: 0 }, source: 'system', now })
		}
		return expired.map(r => r.key)
	}

	touchMemory(keys = [], now = Date.now()) {
		if (!Array.isArray(keys) || !keys.length) return
		const stmt = this.db.prepare('UPDATE memory_items SET last_accessed_at = ?, hit_count = COALESCE(hit_count, 0) + 1 WHERE key = ? AND active = 1')
		for (const k of [...new Set(keys)]) stmt.run(now, k)
	}

	memoryHistory(key = null, limit = 30) {
		const rows = key
			? this.db.prepare('SELECT * FROM memory_history WHERE memory_key = ? ORDER BY id DESC LIMIT ?').all(key, limit)
			: this.db.prepare('SELECT * FROM memory_history ORDER BY id DESC LIMIT ?').all(limit)
		return rows.map(r => ({
			...r,
			prev_meta: parseJson(r.prev_meta, null),
			new_meta: parseJson(r.new_meta, null),
		}))
	}

	restoreMemoryVersion(historyId, { source = 'user', now = Date.now() } = {}) {
		const h = this.db.prepare('SELECT * FROM memory_history WHERE id = ?').get(historyId)
		if (!h || !h.prev_content) return { ok: false, error: `복원할 이전 버전 이력을 찾지 못함: #${historyId}` }
		const meta = parseJson(h.prev_meta, {})
		const restored = this.upsertMemory({
			category: h.prev_category || 'pattern',
			key: h.memory_key,
			content: h.prev_content,
			source,
			confidence: meta?.confidence ?? 1.0,
			expiresAt: meta?.expires_at ?? null,
			priority: meta?.priority ?? null,
			pinned: meta?.pinned ?? false,
			entityIds: meta?.entity_ids ?? [],
			evidenceCount: meta?.evidence_count ?? 1,
			now,
		})
		return { ok: true, item: restored }
	}

	listMemory({ category = null, includeExpired = false, includeArchived = false, entityId = null, now = Date.now() } = {}) {
		const clauses = []
		const params = []
		if (!includeArchived) clauses.push('active = 1')
		if (!includeExpired && !includeArchived) {
			clauses.push('(expires_at IS NULL OR expires_at > ?)')
			params.push(now)
		}
		if (category) {
			clauses.push('category = ?')
			params.push(category)
		}
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
		const rows = this.db.prepare(`
			SELECT * FROM memory_items ${where}
			ORDER BY pinned DESC, ${MEMORY_CAT_RANK_SQL} ASC, COALESCE(priority, 3) DESC, updated_at DESC
		`).all(...params).map(r => this.#mapMemory(r))
		if (entityId) return rows.filter(r => r.entity_ids.includes(entityId))
		return rows
	}

	updateMemoryEmbedding(key, embedding) {
		const packed = unpackEmbedding(embedding)
		if (!packed) return false
		const r = this.db.prepare('UPDATE memory_items SET embedding = ? WHERE key = ?').run(JSON.stringify(packed), key)
		return (r?.changes ?? 0) > 0
	}

	memoriesNeedingEmbedding(targetModel, targetDims = 768, { includeArchived = true } = {}) {
		const rows = this.listMemory({ includeExpired: includeArchived, includeArchived })
		return rows.filter(it => {
			const e = it.embedding
			return !e || e.model !== targetModel || e.dims !== targetDims
		})
	}

	embeddingStats(targetModel = null, targetDims = null) {
		const rows = this.listMemory({ includeExpired: true, includeArchived: true })
		const byModel = {}
		let embedded = 0, matchingTarget = 0, activeTotal = 0, activeMatching = 0
		for (const it of rows) {
			const e = it.embedding
			if (it.active) activeTotal++
			if (e?.vec?.length) {
				embedded++
				const k = `${e.model}(${e.dims})`
				byModel[k] = (byModel[k] ?? 0) + 1
				if (targetModel && e.model === targetModel && (!targetDims || e.dims === targetDims)) {
					matchingTarget++
					if (it.active) activeMatching++
				}
			}
		}
		return {
			total: rows.length,
			active_total: activeTotal,
			embedded,
			by_model: byModel,
			target_model: targetModel,
			target_dims: targetDims,
			matching_target: matchingTarget,
			active_matching: activeMatching,
		}
	}

	searchMemory(query, { category = null, limit = 20, includeArchived = false, entityIds = [], queryEmbedding = null, semanticThreshold = DEFAULT_SEMANTIC_THRESHOLD, now = Date.now() } = {}) {
		const rawQ = String(query ?? '').trim()
		const entSet = new Set(normalizeEntityIds(entityIds))
		const all = this.listMemory({ category, includeExpired: includeArchived, includeArchived, now })
		if (!rawQ && !entSet.size) return all.slice(0, limit)

		// 1) FTS5 점수 (가능할 때)
		const ftsScores = new Map()
		if (this.hasFts5 && rawQ) {
			const toks = tokenize(rawQ)
			if (toks.length) {
				const ftsExpr = toks.slice(0, 8).map(t => `"${t.replace(/"/g, '')}"*`).join(' OR ')
				try {
					const hits = this.db.prepare('SELECT key, bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ? LIMIT 60').all(ftsExpr)
					for (const h of hits) ftsScores.set(h.key, 1 / (1 + Math.max(0, Math.abs(Number(h.rank) || 0))))
				} catch {}
			}
		}

		// 2) 하이브리드 점수: FTS5 + 한국어 토큰/2-gram 유사도 + 임베딩(Gemini Embedding 2 또는 로컬 폴백) 코사인 + 엔티티 겹침 + 중요도 보정
		const qEmb = queryEmbedding ? unpackEmbedding(queryEmbedding) : (rawQ ? packEmbedding(localEmbed(rawQ), 'local') : null)
		const isNeural = Boolean(qEmb && qEmb.model !== 'local')
		const semCut = Number.isFinite(Number(semanticThreshold)) ? Number(semanticThreshold) : DEFAULT_SEMANTIC_THRESHOLD
		const qLower = rawQ.toLowerCase()
		const scored = []
		for (const item of all) {
			const hay = `${item.key} ${item.content} ${item.entity_ids.join(' ')}`
			const substr = rawQ && hay.toLowerCase().includes(qLower) ? 1.0 : 0
			const lex = rawQ ? lexicalSimilarity(rawQ, hay) : 0
			const fts = ftsScores.get(item.key) ?? 0
			const itemEmb = unpackEmbedding(item.embedding)
			let vec = 0
			let neuralCompared = false
			if (qEmb) {
				if (itemEmb && itemEmb.model === qEmb.model && itemEmb.vec.length === qEmb.vec.length) {
					vec = Math.max(0, cosineSimilarity(qEmb.vec, itemEmb.vec))
					neuralCompared = isNeural
				} else if (!isNeural) {
					// 오프라인/동기 폴백 시 DB에 신경망 임베딩이 들어 있더라도 로컬 벡터로 즉석 비교해 품질을 유지한다.
					const tmpLocal = localEmbed(hay, qEmb.vec.length)
					if (tmpLocal) vec = Math.max(0, cosineSimilarity(qEmb.vec, tmpLocal))
				}
			}
			const entHits = entSet.size ? item.entity_ids.filter(id => entSet.has(id)).length : 0
			const entScore = entHits > 0 ? Math.min(1.5, 0.8 + entHits * 0.35) : 0

			let relevance, matched
			if (neuralCompared) {
				const semPass = vec >= semCut
				const semScore = semPass ? (1.4 + (vec - semCut) * 6.0) : Math.max(0, vec - 0.5) * 1.0
				relevance = substr * 1.2 + lex * 0.8 + fts * 0.6 + semScore + entScore
				matched = substr > 0 || entHits > 0 || semPass || ((fts > 0 || lex >= 0.55) && vec >= semCut - 0.14)
			} else {
				relevance = substr * 1.2 + lex + fts * 0.8 + vec * 0.9 + entScore
				matched = substr > 0 || fts > 0 || entHits > 0 || lex >= 0.50 || vec >= 0.52
			}
			if (!matched) continue
			const priorityBoost = (item.pinned ? 0.25 : 0) + ((item.priority ?? 3) - 3) * 0.05
			scored.push({ item, score: relevance + priorityBoost })
		}
		scored.sort((a, b) => b.score - a.score || b.item.updated_at - a.item.updated_at)
		return scored.slice(0, limit).map(s => s.item)
	}

	// ── 암묵적 피드백(Implicit Feedback) ──
	recordImplicitFeedback({ ts = Date.now(), kind, entity_id = null, ref_id = null, score = 0, detail = null }) {
		const t = typeof ts === 'number' ? ts : (Date.parse(ts) || Date.now())
		this.db.prepare(`
			INSERT INTO implicit_feedback (ts, kind, entity_id, ref_id, score, detail)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(t, kind, entity_id, ref_id, Number(score) || 0, jsonOrNull(detail))
	}

	recentImplicitFeedback({ sinceMs = 0, kind = null, limit = 200 } = {}) {
		const rows = kind
			? this.db.prepare('SELECT * FROM implicit_feedback WHERE ts >= ? AND kind = ? ORDER BY ts DESC, id DESC LIMIT ?').all(sinceMs, kind, limit)
			: this.db.prepare('SELECT * FROM implicit_feedback WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT ?').all(sinceMs, limit)
		return rows.reverse().map(r => ({ ...r, detail: parseJson(r.detail, r.detail) }))
	}

	// ── 절차적 기억(Procedural Memory: Lessons / Playbook) ──
	upsertLesson({
		key, scope = 'all', condition_text, rule_text, evidence = null, evidence_count = null,
		confidence = 0.7, pinned = null, source = 'agent', now = Date.now(),
	}) {
		const prev = this.db.prepare('SELECT * FROM lessons WHERE key = ?').get(key)
		const evCount = Number.isInteger(evidence_count) && evidence_count > 0
			? evidence_count
			: (prev ? (prev.evidence_count ?? 1) + 1 : 1)
		const pinVal = pinned == null ? (prev?.pinned ? 1 : 0) : (pinned ? 1 : 0)
		const conf = Math.min(Math.max(Number(confidence) || prev?.confidence || 0.7, 0), 1)
		this.db.prepare(`
			INSERT INTO lessons (key, scope, condition_text, rule_text, evidence, evidence_count, confidence, active, pinned, source, created_at, updated_at, last_used_at, use_count)
			VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, 0)
			ON CONFLICT(key) DO UPDATE SET
				scope = excluded.scope, condition_text = excluded.condition_text, rule_text = excluded.rule_text,
				evidence = COALESCE(excluded.evidence, lessons.evidence), evidence_count = excluded.evidence_count,
				confidence = excluded.confidence, active = 1, pinned = excluded.pinned,
				source = excluded.source, updated_at = excluded.updated_at
		`).run(key, scope, condition_text, rule_text, evidence, evCount, conf, pinVal, source, now, now)
		return this.getLesson(key)
	}

	getLesson(key) {
		const r = this.db.prepare('SELECT * FROM lessons WHERE key = ?').get(key)
		return r ? { ...r, pinned: Boolean(r.pinned), active: Boolean(r.active) } : null
	}

	listLessons({ scope = null, includeInactive = false, limit = 50 } = {}) {
		const clauses = []
		const params = []
		if (!includeInactive) clauses.push('active = 1')
		if (scope && scope !== 'all') {
			clauses.push("(scope = 'all' OR scope = ?)")
			params.push(scope)
		}
		params.push(limit)
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
		return this.db.prepare(`
			SELECT * FROM lessons ${where}
			ORDER BY pinned DESC, confidence DESC, evidence_count DESC, updated_at DESC LIMIT ?
		`).all(...params).map(r => ({ ...r, pinned: Boolean(r.pinned), active: Boolean(r.active) }))
	}

	deleteLesson(key, { source = 'agent', force = false, now = Date.now() } = {}) {
		const prev = this.db.prepare('SELECT * FROM lessons WHERE key = ? AND active = 1').get(key)
		if (!prev) return { ok: false, notFound: true }
		if (!force && !USER_SOURCES.has(source) && prev.pinned) {
			return { ok: false, protected: true, error: `고정된 교훈(${key})은 자동 삭제할 수 없다.` }
		}
		this.db.prepare('UPDATE lessons SET active = 0, updated_at = ? WHERE key = ?').run(now, key)
		return { ok: true }
	}

	touchLessons(keys = [], now = Date.now()) {
		if (!keys.length) return
		const stmt = this.db.prepare('UPDATE lessons SET last_used_at = ?, use_count = COALESCE(use_count, 0) + 1 WHERE key = ? AND active = 1')
		for (const k of [...new Set(keys)]) stmt.run(now, k)
	}

	// ── 변경 실험 원장(Change Experiment Ledger) ──
	upsertExperiment(exp) {
		this.db.prepare(`
			INSERT INTO experiments (eid, ts, kind, ref_id, title, baseline_metrics, eval_after_ts, evaluated_at, after_metrics, verdict, notes, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(eid) DO UPDATE SET
				evaluated_at = COALESCE(excluded.evaluated_at, experiments.evaluated_at),
				after_metrics = COALESCE(excluded.after_metrics, experiments.after_metrics),
				verdict = COALESCE(excluded.verdict, experiments.verdict),
				notes = COALESCE(excluded.notes, experiments.notes),
				status = excluded.status
		`).run(
			exp.eid, exp.ts, exp.kind, exp.ref_id ?? null, exp.title,
			jsonOrNull(exp.baseline_metrics), exp.eval_after_ts,
			exp.evaluated_at ?? null, jsonOrNull(exp.after_metrics),
			exp.verdict ?? null, exp.notes ?? null, exp.status ?? 'active',
		)
		return this.getExperiment(exp.eid)
	}

	#mapExperiment(r) {
		if (!r) return null
		return {
			...r,
			baseline_metrics: parseJson(r.baseline_metrics, null),
			after_metrics: parseJson(r.after_metrics, null),
		}
	}

	getExperiment(eid) {
		return this.#mapExperiment(this.db.prepare('SELECT * FROM experiments WHERE eid = ?').get(eid))
	}

	// 판정은 났는데(개선·악화) 아직 후속 조치를 하지 않은 실험
	unactionedExperiments({ verdicts = ['improved', 'regressed'], limit = 50 } = {}) {
		return this.db.prepare(`SELECT * FROM experiments WHERE actioned_at IS NULL AND status IN (${verdicts.map(() => '?').join(',')}) ORDER BY evaluated_at ASC LIMIT ?`)
			.all(...verdicts, limit).map(r => this.#mapExperiment(r))
	}

	markExperimentActioned(eid, now = Date.now(), note = null) {
		this.db.prepare(`UPDATE experiments SET actioned_at = ?${note ? ", notes = COALESCE(notes, '') || ?" : ''} WHERE eid = ?`)
			.run(...[now, ...(note ? [` / 조치: ${note}`] : []), eid])
	}

	listExperiments({ status = null, dueBefore = null, limit = 50 } = {}) {
		const clauses = []
		const params = []
		if (status) { clauses.push('status = ?'); params.push(status) }
		if (dueBefore != null) { clauses.push('eval_after_ts <= ?'); params.push(dueBefore) }
		params.push(limit)
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
		return this.db.prepare(`SELECT * FROM experiments ${where} ORDER BY ts DESC LIMIT ?`).all(...params).map(r => this.#mapExperiment(r))
	}

	// ── 기간 조회 헬퍼(records.mjs / learning.mjs SQLite 단일 원본) ──
	#mapDecision(r) {
		return {
			...r,
			ts: new Date(r.ts).toISOString(),
			reasons: parseJson(r.reasons, []),
			usage: parseJson(r.usage, null),
			applied: parseJson(r.applied, null),
			skipped: Boolean(r.skipped),
			deferred: Boolean(r.deferred),
		}
	}

	decisionsInRange(sinceMs = 0, untilMs = Infinity) {
		const rows = Number.isFinite(untilMs)
			? this.db.prepare('SELECT * FROM decisions WHERE ts >= ? AND ts < ? ORDER BY ts ASC').all(sinceMs, untilMs)
			: this.db.prepare('SELECT * FROM decisions WHERE ts >= ? ORDER BY ts ASC').all(sinceMs)
		return rows.map(r => this.#mapDecision(r))
	}

	latestDecision({ excludeAssist = false, onlyAssist = false, excludeSkipped = false, excludeDeferred = false } = {}) {
		const isAssistOnly = d => Array.isArray(d?.reasons) && d.reasons.length > 0 && d.reasons.every(r => r === 'assist')
		const clauses = []
		if (excludeSkipped) clauses.push('skipped = 0')
		if (excludeDeferred) clauses.push('deferred = 0')
		if (excludeAssist) clauses.push(`reasons != '["assist"]'`)
		if (onlyAssist) clauses.push(`reasons = '["assist"]'`)
		const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
		const rows = this.db.prepare(`SELECT * FROM decisions ${where} ORDER BY ts DESC, id DESC LIMIT 20`).all()
		for (const r of rows) {
			const d = this.#mapDecision(r)
			if (excludeSkipped && d.skipped) continue
			if (excludeDeferred && d.deferred) continue
			if (excludeAssist && isAssistOnly(d)) continue
			if (onlyAssist && !isAssistOnly(d)) continue
			return d
		}
		return null
	}

	notificationsInRange(sinceMs = 0, untilMs = Infinity) {
		const rows = Number.isFinite(untilMs)
			? this.db.prepare('SELECT * FROM notifications WHERE ts >= ? AND ts < ? ORDER BY ts ASC').all(sinceMs, untilMs)
			: this.db.prepare('SELECT * FROM notifications WHERE ts >= ? ORDER BY ts ASC').all(sinceMs)
		return rows.map(r => this.#mapNotification(r))
	}

	feedbackInRange(sinceMs = 0, untilMs = Infinity) {
		const rows = Number.isFinite(untilMs)
			? this.db.prepare('SELECT * FROM feedback WHERE ts >= ? AND ts < ? ORDER BY ts ASC').all(sinceMs, untilMs)
			: this.db.prepare('SELECT * FROM feedback WHERE ts >= ? ORDER BY ts ASC').all(sinceMs)
		return rows.map(r => ({
			...r,
			ts: new Date(r.ts).toISOString(),
			rules: parseJson(r.rules, []),
			muted: parseJson(r.muted, []),
		}))
	}

	actionsInRange(sinceMs = 0, untilMs = Infinity) {
		const rows = Number.isFinite(untilMs)
			? this.db.prepare('SELECT * FROM actions WHERE ts >= ? AND ts < ? ORDER BY ts ASC').all(sinceMs, untilMs)
			: this.db.prepare('SELECT * FROM actions WHERE ts >= ? ORDER BY ts ASC').all(sinceMs)
		return rows.map(r => this.#mapAction(r))
	}

	eventsInRange(sinceMs = 0, untilMs = Infinity) {
		const rows = Number.isFinite(untilMs)
			? this.db.prepare('SELECT ts AS t, entity_id AS id, name, old_state AS "from", new_state AS "to", is_noise, origin, actor FROM events WHERE ts >= ? AND ts < ? ORDER BY ts ASC').all(sinceMs, untilMs)
			: this.db.prepare('SELECT ts AS t, entity_id AS id, name, old_state AS "from", new_state AS "to", is_noise, origin, actor FROM events WHERE ts >= ? ORDER BY ts ASC').all(sinceMs)
		return rows
	}

	messagesInRange(sinceMs = 0, untilMs = Infinity) {
		const rows = Number.isFinite(untilMs)
			? this.db.prepare('SELECT session_id, ts, role, text, meta FROM messages WHERE ts >= ? AND ts < ? ORDER BY ts ASC, id ASC').all(sinceMs, untilMs)
			: this.db.prepare('SELECT session_id, ts, role, text, meta FROM messages WHERE ts >= ? ORDER BY ts ASC, id ASC').all(sinceMs)
		return rows.map(r => ({ ...r, meta: parseJson(r.meta, null) }))
	}

	// ── 일/월 장기 Rollup (원시 데이터 삭제 전 영구 요약 보존) ──
	upsertDailyRollup(doc, now = Date.now()) {
		if (!doc?.date) return
		const n = doc.notifications ?? {}
		const sumKind = pfx => Object.entries(n).filter(([k]) => k.startsWith(`${pfx}/sent`)).reduce((s, [, v]) => s + (Number(v) || 0), 0)
		this.db.prepare(`
			INSERT INTO daily_rollups (date, weekday, runs, failed, skipped, noop, tokens, alerts, infos, summaries, feedback_json, actions_json, entities_json, sensor_stats_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(date) DO UPDATE SET
				runs = excluded.runs, failed = excluded.failed, skipped = excluded.skipped, noop = excluded.noop,
				tokens = excluded.tokens, alerts = excluded.alerts, infos = excluded.infos, summaries = excluded.summaries,
				feedback_json = excluded.feedback_json, actions_json = excluded.actions_json,
				entities_json = excluded.entities_json, sensor_stats_json = COALESCE(excluded.sensor_stats_json, daily_rollups.sensor_stats_json),
				created_at = excluded.created_at
		`).run(
			doc.date, doc.weekday ?? kst(new Date(`${doc.date}T12:00:00+09:00`)).wd,
			doc.runs ?? 0, doc.failed ?? 0, doc.skipped ?? 0, doc.noop ?? 0, doc.tokens ?? 0,
			doc.alerts ?? sumKind('alert'), doc.infos ?? sumKind('info'), doc.summaries ?? sumKind('hourly_summary'),
			jsonOrNull(doc.feedback ?? {}), jsonOrNull(doc.actions ?? {}),
			jsonOrNull(doc.entities ?? {}), jsonOrNull(doc.sensor_stats ?? null), now,
		)
	}

	listDailyRollups(limit = 90) {
		return this.db.prepare('SELECT * FROM daily_rollups ORDER BY date DESC LIMIT ?').all(limit).reverse().map(r => ({
			...r,
			feedback: parseJson(r.feedback_json, {}),
			actions: parseJson(r.actions_json, {}),
			entities: parseJson(r.entities_json, {}),
			sensor_stats: parseJson(r.sensor_stats_json, null),
		}))
	}

	recomputeMonthlyRollups(now = Date.now()) {
		const dailies = this.db.prepare('SELECT * FROM daily_rollups ORDER BY date ASC').all()
		const byMonth = new Map()
		for (const d of dailies) {
			const m = String(d.date).slice(0, 7)
			if (!/^\d{4}-\d{2}$/.test(m)) continue
			let acc = byMonth.get(m)
			if (!acc) { acc = { month: m, days: 0, runs: 0, failed: 0, noop: 0, tokens: 0, alerts: 0, summaries: 0, entities: {}, sensors: {} }; byMonth.set(m, acc) }
			acc.days++
			acc.runs += d.runs ?? 0
			acc.failed += d.failed ?? 0
			acc.noop += d.noop ?? 0
			acc.tokens += d.tokens ?? 0
			acc.alerts += d.alerts ?? 0
			acc.summaries += d.summaries ?? 0
			for (const [id, info] of Object.entries(parseJson(d.entities_json, {}) ?? {})) {
				acc.entities[id] = (acc.entities[id] ?? 0) + (info?.changes ?? 0)
			}
			for (const [id, st] of Object.entries(parseJson(d.sensor_stats_json, {}) ?? {})) {
				const cur = (acc.sensors[id] ??= { sum: 0, n: 0, min: Infinity, max: -Infinity })
				if (Number.isFinite(st?.avg) && st?.n > 0) {
					cur.sum += st.avg * st.n
					cur.n += st.n
					if (Number.isFinite(st.min)) cur.min = Math.min(cur.min, st.min)
					if (Number.isFinite(st.max)) cur.max = Math.max(cur.max, st.max)
				}
			}
		}
		const ins = this.db.prepare(`
			INSERT INTO monthly_rollups (month, days, runs, failed, noop, tokens, alerts, summaries, sensor_stats_json, top_entities_json, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(month) DO UPDATE SET
				days = excluded.days, runs = excluded.runs, failed = excluded.failed, noop = excluded.noop,
				tokens = excluded.tokens, alerts = excluded.alerts, summaries = excluded.summaries,
				sensor_stats_json = excluded.sensor_stats_json, top_entities_json = excluded.top_entities_json, updated_at = excluded.updated_at
		`)
		for (const acc of byMonth.values()) {
			const topEnt = Object.fromEntries(Object.entries(acc.entities).sort((a, b) => b[1] - a[1]).slice(0, 30))
			const sStats = Object.fromEntries(Object.entries(acc.sensors).filter(([, v]) => v.n > 0).map(([id, v]) => [id, {
				avg: Math.round((v.sum / v.n) * 100) / 100,
				min: v.min,
				max: v.max,
				n: v.n,
			}]))
			ins.run(acc.month, acc.days, acc.runs, acc.failed, acc.noop, acc.tokens, acc.alerts, acc.summaries, jsonOrNull(sStats), jsonOrNull(topEnt), now)
		}
		return byMonth.size
	}

	listMonthlyRollups(limit = 24) {
		return this.db.prepare('SELECT * FROM monthly_rollups ORDER BY month DESC LIMIT ?').all(limit).reverse().map(r => ({
			...r,
			sensor_stats: parseJson(r.sensor_stats_json, {}),
			top_entities: parseJson(r.top_entities_json, {}),
		}))
	}

	rollupBeforePrune(now, cutoffs) {
		const earliestCutoff = Math.max(cutoffs.events, cutoffs.samples, cutoffs.decisions)
		const dates = new Set()
		for (const r of this.db.prepare('SELECT ts FROM events WHERE ts < ?').all(cutoffs.events)) dates.add(kst(new Date(r.ts)).date)
		for (const r of this.db.prepare('SELECT ts FROM sensor_samples WHERE ts < ?').all(cutoffs.samples)) dates.add(kst(new Date(r.ts)).date)
		for (const r of this.db.prepare('SELECT ts FROM decisions WHERE ts < ?').all(cutoffs.decisions)) dates.add(kst(new Date(r.ts)).date)
		let rolledDays = 0
		for (const date of [...dates].sort()) {
			const existing = this.db.prepare('SELECT date FROM daily_rollups WHERE date = ?').get(date)
			if (existing) continue
			const start = Date.parse(`${date}T00:00:00+09:00`), end = start + DAY
			if (end > earliestCutoff + DAY) continue
			const decs = this.decisionsInRange(start, end)
			const notes = this.notificationsInRange(start, end)
			const fbs = this.feedbackInRange(start, end)
			const acts = this.actionsInRange(start, end)
			const evs = this.eventsInRange(start, end)
			const samps = this.db.prepare('SELECT entity_id, value FROM sensor_samples WHERE ts >= ? AND ts < ?').all(start, end)
			const count = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] ?? 0) + 1; return m }, {})
			const entSummary = {}
			for (const e of evs) {
				const cur = (entSummary[e.id] ??= { name: e.name ?? e.id, changes: 0 })
				cur.changes++
			}
			const sensorAcc = {}
			for (const s of samps) {
				const cur = (sensorAcc[s.entity_id] ??= { sum: 0, n: 0, min: Infinity, max: -Infinity })
				cur.sum += s.value; cur.n++; cur.min = Math.min(cur.min, s.value); cur.max = Math.max(cur.max, s.value)
			}
			const sensorStats = Object.fromEntries(Object.entries(sensorAcc).map(([id, v]) => [id, { avg: Math.round((v.sum / v.n) * 100) / 100, min: v.min, max: v.max, n: v.n }]))
			const okDecs = decs.filter(d => !d.skipped && !d.deferred && !d.error)
			const noop = okDecs.filter(d => !(d.applied?.notifications?.length || d.applied?.actions?.length || d.applied?.added?.length || d.applied?.changed?.length || d.applied?.deleted?.length || d.applied?.report)).length
			this.upsertDailyRollup({
				date,
				weekday: kst(new Date(`${date}T12:00:00+09:00`)).wd,
				runs: decs.filter(d => !d.skipped && !d.deferred).length,
				failed: decs.filter(d => d.error).length,
				skipped: decs.filter(d => d.skipped).length,
				noop,
				tokens: decs.reduce((s, d) => s + (d.tokens ?? 0), 0),
				notifications: count(notes, n => `${n.kind}/${n.status}`),
				feedback: count(fbs, f => f.kind),
				actions: count(acts, a => a.status),
				entities: entSummary,
				sensor_stats: Object.keys(sensorStats).length ? sensorStats : null,
			}, now)
			rolledDays++
		}
		const rolledMonths = rolledDays > 0 ? this.recomputeMonthlyRollups(now) : 0
		return { rolledDays, rolledMonths }
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

	#mapNotification(r) {
		return { ...r, ts: new Date(r.ts).toISOString(), related_rule_ids: parseJson(r.related_rule_ids, []) }
	}

	recentNotifications({ sinceMs = 0, limit = 50 } = {}) {
		return this.db.prepare('SELECT * FROM notifications WHERE ts >= ? ORDER BY ts DESC, rowid DESC LIMIT ?')
			.all(sinceMs, limit).reverse().map(r => this.#mapNotification(r))
	}

	getNotification(nid) {
		const r = this.db.prepare('SELECT * FROM notifications WHERE nid = ?').get(nid)
		return r ? this.#mapNotification(r) : null
	}

	latestNotificationByTag(tag) {
		const r = this.db.prepare('SELECT * FROM notifications WHERE tag = ? ORDER BY ts DESC, rowid DESC LIMIT 1').get(tag)
		return r ? this.#mapNotification(r) : null
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

	hasFeedback(nid, kind) {
		return Boolean(this.db.prepare('SELECT 1 FROM feedback WHERE nid = ? AND kind = ? LIMIT 1').get(nid, kind))
	}

	recentFeedback({ sinceMs = 0, limit = 50 } = {}) {
		return this.db.prepare('SELECT * FROM feedback WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT ?')
			.all(sinceMs, limit).reverse().map(r => ({
				...r,
				ts: new Date(r.ts).toISOString(),
				rules: parseJson(r.rules, []),
				muted: parseJson(r.muted, []),
			}))
	}

	maintain(now = Date.now(), { eventDays = 60, sampleDays = 30, decisionDays = 90, messageDays = 90, notificationDays = 90, feedbackDays = 180, implicitFeedbackDays = 180 } = {}) {
		const cutoffs = {
			events: now - eventDays * DAY,
			samples: now - sampleDays * DAY,
			decisions: now - decisionDays * DAY,
			messages: now - messageDays * DAY,
			notifications: now - notificationDays * DAY,
			feedback: now - feedbackDays * DAY,
			implicit: now - implicitFeedbackDays * DAY,
		}
		// 원시 기록을 지우기 전에 일/월 단위 요약(Rollup)을 영구 테이블에 보존한다.
		const rollup = this.rollupBeforePrune(now, cutoffs)
		this.archiveExpiredMemory(now)
		const del = (sql, cutoff) => Number(this.db.prepare(sql).run(cutoff)?.changes ?? 0)
		const deleted = {
			events: del('DELETE FROM events WHERE ts < ?', cutoffs.events),
			sensor_samples: del('DELETE FROM sensor_samples WHERE ts < ?', cutoffs.samples),
			decisions: del('DELETE FROM decisions WHERE ts < ?', cutoffs.decisions),
			messages: del('DELETE FROM messages WHERE ts < ?', cutoffs.messages),
			notifications: del('DELETE FROM notifications WHERE ts < ?', cutoffs.notifications),
			feedback: del('DELETE FROM feedback WHERE ts < ?', cutoffs.feedback),
			implicit_feedback: del('DELETE FROM implicit_feedback WHERE ts < ?', cutoffs.implicit),
		}
		deleted.conversations = Number(
			this.db.prepare('DELETE FROM conversations WHERE updated_at < ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = conversations.session_id)')
				.run(cutoffs.messages)?.changes ?? 0,
		)
		deleted.rolled_up_days = rollup.rolledDays
		deleted.rolled_up_months = rollup.rolledMonths
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
			memory_pinned: Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_items WHERE active = 1 AND pinned = 1').get().n),
			lessons: Number(this.db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE active = 1').get().n),
			experiments_active: Number(this.db.prepare("SELECT COUNT(*) AS n FROM experiments WHERE status = 'active'").get().n),
			implicit_feedback: c('implicit_feedback'),
			daily_rollups: c('daily_rollups'),
			monthly_rollups: c('monthly_rollups'),
			conversations: c('conversations'),
			notifications: c('notifications'),
			feedback: c('feedback'),
		}
	}
}
