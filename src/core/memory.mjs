// 계층형 메모리: 집 프로필(home-profile.md), 단기 작업 메모(memory.md), 구조화 장기 기억(SQLite memory_items), 절차적 교훈(lessons)을 통합 관리한다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { P, DAY, kst, log } from '../util.mjs'
import { snapshot } from '../records.mjs'
import {
	tokenize, charNgrams, jaccard, embedText, EmbeddingCache,
	DEFAULT_EMBEDDING_DIMS, DEFAULT_SEMANTIC_THRESHOLD,
} from './embeddings.mjs'
import { MEMORY_DEFAULT_PRIORITY } from './store.mjs'

export const CATEGORY_ORDER = ['standing_order', 'preference', 'rejection', 'pattern', 'incident']
export const CAT_LABEL = {
	standing_order: '지시사항',
	preference: '선호',
	rejection: '거절된 제안',
	pattern: '생활 패턴',
	incident: '장애·이력',
}
export const DEFAULT_TTL_DAYS = {
	standing_order: null,
	preference: null,
	pattern: null,
	rejection: 90,
	incident: 21,
}
const AUTO_SOURCES = new Set(['agent', 'cycle', 'extractor', 'tool', 'ha_assist', 'web', 'cli_assist', 'cli_say', 'openai_compat'])

function resolveExpiresAt(item, category, pinned, now) {
	if (item.expires_at != null && item.expires_at !== '') {
		const ms = typeof item.expires_at === 'number' ? item.expires_at : Date.parse(item.expires_at)
		if (Number.isFinite(ms)) return ms
	}
	if (item.ttl_days !== undefined && item.ttl_days !== null) {
		const days = Number(item.ttl_days)
		if (Number.isFinite(days)) return days <= 0 ? null : now + Math.round(days * DAY)
	}
	if (pinned) return null
	const defDays = DEFAULT_TTL_DAYS[category]
	return defDays ? now + defDays * DAY : null
}

function formatMemLine(it, now) {
	const tags = []
	if (it.pinned) tags.push('고정')
	if (it.expires_at && it.expires_at > now) {
		const remDays = Math.ceil((it.expires_at - now) / DAY)
		if (remDays <= 7) tags.push(`${remDays}일 뒤 만료`)
	}
	if ((it.evidence_count ?? 1) >= 3) tags.push(`근거 ${it.evidence_count}회`)
	const badge = tags.length ? ` [${tags.join(', ')}]` : ''
	return `- (${it.key})${badge} ${it.content}`
}

export class MemoryManager {
	constructor({ store = null, cfg = null, fetchFn = fetch, memoryPath = P.memory, profilePath = P.homeProfile } = {}) {
		this.store = store
		this.cfg = cfg
		this.fetchFn = fetchFn
		this.memoryPath = memoryPath
		this.profilePath = profilePath
		this._embedCache = new EmbeddingCache({ max: 128, ttlMs: 15 * 60 * 1000 })
		this._pendingEmbeds = new Set()
		this._embedWarnedAt = 0
	}

	embeddingConfig() {
		const raw = String(this.cfg?.memory?.embedding_model ?? 'local').trim()
		const model = raw || 'local'
		const dims = Math.min(Math.max(Number(this.cfg?.memory?.embedding_dims) || DEFAULT_EMBEDDING_DIMS, 128), 3072)
		const semanticThreshold = Number.isFinite(Number(this.cfg?.memory?.semantic_threshold))
			? Number(this.cfg.memory.semantic_threshold)
			: DEFAULT_SEMANTIC_THRESHOLD
		return { model, dims, semanticThreshold, enabled: model !== 'local' }
	}

	embeddingStats() {
		const ec = this.embeddingConfig()
		if (!this.store) return { model: ec.model, dims: ec.dims, enabled: ec.enabled, total: 0, matching_target: 0 }
		return {
			...this.store.embeddingStats(ec.enabled ? ec.model : 'local', ec.enabled ? ec.dims : null),
			enabled: ec.enabled,
			semantic_threshold: ec.semanticThreshold,
		}
	}

	async embedQuery(query, { timeoutMs = 4000 } = {}) {
		const ec = this.embeddingConfig()
		const raw = String(query ?? '').trim()
		if (!ec.enabled || !raw) return null
		const cacheKey = `${ec.model}:${ec.dims}:${raw}`
		const cached = this._embedCache.get(cacheKey)
		if (cached) return cached
		const res = await embedText(raw, {
			cfg: this.cfg,
			model: ec.model,
			dims: ec.dims,
			task: 'query',
			fetchFn: this.fetchFn,
			timeoutMs,
		})
		if (res && !res.fallback) {
			this._embedCache.set(cacheKey, res)
			return res
		}
		if (res?.error && Date.now() - this._embedWarnedAt > 60000) {
			this._embedWarnedAt = Date.now()
			log(`기억 쿼리 임베딩 폴백 (${ec.model}): ${res.error}`)
		}
		return null
	}

	async syncEmbedding(key, { timeoutMs = 8000 } = {}) {
		const ec = this.embeddingConfig()
		if (!this.store || !ec.enabled || !key) return { ok: false, skipped: true }
		const item = this.store.getMemory(key)
		if (!item) return { ok: false, notFound: true }
		const docText = `${item.content}${item.entity_ids?.length ? ` (${item.entity_ids.join(', ')})` : ''}`
		const res = await embedText(docText, {
			cfg: this.cfg,
			model: ec.model,
			dims: ec.dims,
			task: 'document',
			title: item.key,
			fetchFn: this.fetchFn,
			timeoutMs,
		})
		if (!res || res.fallback) {
			if (res?.error && Date.now() - this._embedWarnedAt > 60000) {
				this._embedWarnedAt = Date.now()
				log(`기억 저장 임베딩 실패 (${key}, 로컬 폴백 유지): ${res.error}`)
			}
			return { ok: false, fallback: true, error: res?.error ?? null }
		}
		if (!this.store?.db) return { ok: false, closed: true }
		this.store.updateMemoryEmbedding(key, res)
		return { ok: true, model: res.model, dims: res.dims }
	}

	scheduleEmbedding(keys = []) {
		const ec = this.embeddingConfig()
		if (!this.store || !ec.enabled || !Array.isArray(keys) || !keys.length) return
		for (const key of [...new Set(keys)]) {
			const p = this.syncEmbedding(key)
				.catch(() => {})
				.finally(() => this._pendingEmbeds.delete(p))
			this._pendingEmbeds.add(p)
		}
	}

	async flushEmbeddings() {
		while (this._pendingEmbeds.size > 0) {
			await Promise.allSettled([...this._pendingEmbeds])
		}
	}

	async backfillEmbeddings({ includeArchived = true, concurrency = 3, timeoutMs = 8000 } = {}) {
		const ec = this.embeddingConfig()
		if (!this.store || !ec.enabled) {
			return { model: ec.model, dims: ec.dims, enabled: false, total: 0, updated: 0, skipped: 0, failed: 0 }
		}
		const all = this.store.listMemory({ includeExpired: includeArchived, includeArchived })
		const targets = this.store.memoriesNeedingEmbedding(ec.model, ec.dims, { includeArchived })
		let updated = 0, failed = 0
		const queue = [...targets]
		const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, async () => {
			while (queue.length) {
				const item = queue.shift()
				if (!item) break
				const r = await this.syncEmbedding(item.key, { timeoutMs })
				if (r.ok) updated++
				else failed++
			}
		})
		await Promise.all(workers)
		return {
			model: ec.model,
			dims: ec.dims,
			enabled: true,
			total: all.length,
			needed: targets.length,
			updated,
			skipped: all.length - targets.length,
			failed,
		}
	}

	loadHomeProfile() {
		try { return existsSync(this.profilePath) ? readFileSync(this.profilePath, 'utf8').trim() : '' } catch { return '' }
	}

	readLegacy() {
		try { return existsSync(this.memoryPath) ? readFileSync(this.memoryPath, 'utf8') : '' } catch { return '' }
	}

	applyLegacy(m, out, now, { dry = false, max = 6000, keepSnapshots = 30 } = {}) {
		if (!m || m.mode === 'keep') return false
		const old = this.readLegacy()
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
		if (cur === old || dry) return false
		snapshot('memory', old, now, keepSnapshots)
		writeFileSync(this.memoryPath, cur)
		return true
	}

	applyOps(ops = [], { source = 'agent', now = Date.now(), force = false } = {}) {
		if (!this.store || !Array.isArray(ops) || !ops.length) return { upserted: [], deleted: [], blocked: [], warnings: [] }
		const upserted = [], deleted = [], blocked = [], warnings = []
		for (const item of ops) {
			if (!item?.key) continue
			const key = String(item.key).trim().slice(0, 80)
			if (!key) continue
			if (item.op === 'delete') {
				const del = this.store.deleteMemoryDetailed(key, { source, force, now })
				if (del.ok) deleted.push(key)
				else if (del.protected) blocked.push({ key, error: del.error })
			} else if (item.content) {
				let category = CATEGORY_ORDER.includes(item.category) ? item.category : 'pattern'
				const prev = this.store.getMemory(key)
				const rawConf = item.confidence != null ? Number(item.confidence) : null
				const confidence = Number.isFinite(rawConf) ? Math.min(Math.max(rawConf, 0), 1) : (prev?.confidence ?? 1.0)
				const pinned = item.pinned === true ? true : item.pinned === false ? false : null
				// 근거 임계치 가드: 자동 출처가 낮은 확신도(<0.55)로 새 영구 패턴을 만들려 하면 만료가 있는 incident로 강등해 오염을 막는다.
				if (AUTO_SOURCES.has(source) && !prev && category === 'pattern' && confidence < 0.55) {
					category = 'incident'
					warnings.push(`${key}: 확신도(${confidence})가 낮아 영구 pattern 대신 임시 incident로 저장`)
				}
				const expiresAt = resolveExpiresAt(item, category, pinned ?? prev?.pinned ?? false, now)
				const priority = Number.isInteger(Number(item.priority)) && item.priority != null
					? Math.min(Math.max(Number(item.priority), 1), 5)
					: (prev?.priority ?? MEMORY_DEFAULT_PRIORITY[category] ?? 3)
				const entityIds = Array.isArray(item.entity_ids) ? item.entity_ids : (item.entity_ids === null ? null : undefined)
				this.store.upsertMemory({
					category,
					key,
					content: String(item.content).trim().slice(0, 500),
					source,
					confidence,
					expiresAt,
					priority,
					pinned,
					entityIds,
					now,
				})
				upserted.push(key)
			}
		}
		if (upserted.length) this.scheduleEmbedding(upserted)
		return { upserted, deleted, blocked, warnings }
	}

	setPinned(key, pinned, { source = 'user', now = Date.now() } = {}) {
		if (!this.store) return null
		return this.store.setMemoryPinned(key, pinned, { source, now })
	}

	history(key = null, limit = 30) {
		if (!this.store) return []
		return this.store.memoryHistory(key, limit)
	}

	restoreVersion(historyId, { source = 'user', now = Date.now() } = {}) {
		if (!this.store) return { ok: false, error: '저장소 없음' }
		const r = this.store.restoreMemoryVersion(historyId, { source, now })
		if (r.ok && r.item?.key) this.scheduleEmbedding([r.item.key])
		return r
	}

	list(category = null, opts = {}) {
		if (!this.store) return []
		return this.store.listMemory({ category, ...opts })
	}

	search(query, category = null, opts = {}) {
		const ec = this.embeddingConfig()
		if (this.store) return this.store.searchMemory(query, { category, semanticThreshold: ec.semanticThreshold, ...opts })
		const q = String(query ?? '').toLowerCase()
		return this.readLegacy().split('\n').filter(l => l.toLowerCase().includes(q)).map((line, i) => ({ category: 'legacy', key: `line_${i + 1}`, content: line }))
	}

	async searchAsync(query, category = null, opts = {}) {
		const ec = this.embeddingConfig()
		if (!this.store) return this.search(query, category, opts)
		let queryEmbedding = opts.queryEmbedding ?? null
		if (!queryEmbedding && ec.enabled && String(query ?? '').trim()) {
			queryEmbedding = await this.embedQuery(query, { timeoutMs: opts.embedTimeoutMs ?? 4000 })
		}
		return this.store.searchMemory(query, {
			category,
			semanticThreshold: ec.semanticThreshold,
			...opts,
			queryEmbedding,
		})
	}

	// 우선순위 보장 + 맥락 기반 회상(Contextual Recall) 렌더링:
	// 1) pinned · standing_order · preference는 incident에 밀려 잘리지 않도록 항상 최우선 배치
	// 2) 남은 예산은 contextText / entityIds와 관련 높은 항목을 우선 선별
	renderStructured(maxChars = 2500, { contextText = '', entityIds = [], queryEmbedding = null, now = Date.now(), touch = false } = {}) {
		const items = this.list(null, { now })
		if (!items.length) return ''

		const mustKeep = []
		const optional = []
		for (const it of items) {
			if (it.pinned || it.category === 'standing_order' || it.category === 'preference') mustKeep.push(it)
			else optional.push(it)
		}

		let orderedOptional = optional
		if ((contextText || entityIds?.length) && optional.length > 0) {
			const ec = this.embeddingConfig()
			const recalled = this.store.searchMemory(contextText, {
				entityIds,
				queryEmbedding,
				semanticThreshold: ec.semanticThreshold,
				limit: optional.length,
				now,
			})
			const rankMap = new Map(recalled.map((r, idx) => [r.key, idx]))
			orderedOptional = [...optional].sort((a, b) => {
				const ra = rankMap.has(a.key) ? rankMap.get(a.key) : 9999
				const rb = rankMap.has(b.key) ? rankMap.get(b.key) : 9999
				if (ra !== rb) return ra - rb
				const ca = CATEGORY_ORDER.indexOf(a.category), cb = CATEGORY_ORDER.indexOf(b.category)
				if (ca !== cb) return ca - cb
				return (b.priority ?? 3) - (a.priority ?? 3) || b.updated_at - a.updated_at
			})
		}

		// 카테고리별 순서(standing_order → preference → rejection → pattern → incident)를 유지하며 예산 내에서 채운다.
		const picked = []
		let usedChars = 0
		const headerOverhead = 24
		const seenCats = new Set()
		const tryAdd = it => {
			const line = formatMemLine(it, now)
			const extra = line.length + 1 + (seenCats.has(it.category) ? 0 : headerOverhead)
			if (usedChars + extra > maxChars && picked.length > 0) return false
			picked.push(it)
			seenCats.add(it.category)
			usedChars += extra
			return true
		}

		for (const it of mustKeep) tryAdd(it)
		for (const it of orderedOptional) tryAdd(it)

		if (touch && picked.length && this.store) {
			try { this.store.touchMemory(picked.map(p => p.key), now) } catch {}
		}

		const byCat = new Map()
		for (const cat of CATEGORY_ORDER) byCat.set(cat, [])
		for (const it of picked) {
			if (!byCat.has(it.category)) byCat.set(it.category, [])
			byCat.get(it.category).push(it)
		}
		const lines = []
		for (const [cat, list] of byCat) {
			if (!list.length) continue
			lines.push(`[${CAT_LABEL[cat] ?? cat}]`)
			for (const it of list) lines.push(formatMemLine(it, now))
		}
		const omitted = items.length - picked.length
		if (omitted > 0) lines.push(`… (우선순위 낮은 기억 ${omitted}건은 memory_search로 조회 가능)`)
		const text = lines.join('\n')
		return text.length > maxChars + 60 ? `${text.slice(0, maxChars)}\n… (나머지 생략)` : text
	}

	async renderStructuredAsync(maxChars = 2500, opts = {}) {
		const ec = this.embeddingConfig()
		let queryEmbedding = opts.queryEmbedding ?? null
		if (!queryEmbedding && ec.enabled && String(opts.contextText ?? '').trim() && this.store) {
			const items = this.list(null, { now: opts.now ?? Date.now() })
			const optionalCount = items.filter(it => !(it.pinned || it.category === 'standing_order' || it.category === 'preference')).length
			const estChars = items.reduce((s, it) => s + it.content.length + it.key.length + 20, 0)
			// 전체 기억이 프롬프트 예산에 다 들어갈 때는 불필요한 임베딩 API 호출을 생략한다.
			if (optionalCount > 1 && estChars > maxChars) {
				queryEmbedding = await this.embedQuery(opts.contextText, { timeoutMs: 3000 })
			}
		}
		return this.renderStructured(maxChars, { ...opts, queryEmbedding })
	}

	async renderForPromptAsync(maxChars = 6000, opts = {}) {
		const structBudget = Math.min(3600, Math.floor(maxChars * 0.65))
		const ec = this.embeddingConfig()
		let queryEmbedding = opts.queryEmbedding ?? null
		if (!queryEmbedding && ec.enabled && String(opts.contextText ?? '').trim() && this.store) {
			const items = this.list(null, { now: opts.now ?? Date.now() })
			const optionalCount = items.filter(it => !(it.pinned || it.category === 'standing_order' || it.category === 'preference')).length
			const estChars = items.reduce((s, it) => s + it.content.length + it.key.length + 20, 0)
			if (optionalCount > 1 && estChars > structBudget) {
				queryEmbedding = await this.embedQuery(opts.contextText, { timeoutMs: 3000 })
			}
		}
		return this.renderForPrompt(maxChars, { ...opts, queryEmbedding })
	}

	renderForPrompt(maxChars = 6000, opts = {}) {
		const legacy = this.readLegacy().trim()
		// 구조화 장기 기억에 최대 65%까지 우선 배정(Assist 2500자에서도 영구 지시·선호가 잘리지 않게).
		const structBudget = Math.min(3600, Math.floor(maxChars * 0.65))
		const structured = this.renderStructured(structBudget, opts)
		if (!structured) return legacy.length <= maxChars ? legacy : `… (이전 작업 메모 생략)\n${legacy.slice(-(maxChars - 30))}`
		if (!legacy) return structured
		const sep = '\n\n### 구조화 장기 기억\n'
		const joined = `${legacy}${sep}${structured}`
		if (joined.length <= maxChars) return joined
		// 작업 메모(memory.md)가 길면 앞쪽 낡은 줄을 줄이고 최신 줄(뒤쪽)과 구조화 장기 기억을 온전히 보존한다.
		const legacyBudget = Math.max(0, maxChars - structured.length - sep.length - 25)
		if (legacyBudget < 80) return `### 구조화 장기 기억\n${structured}`
		const tail = legacy.slice(-legacyBudget)
		const nl = tail.indexOf('\n')
		const cleanTail = nl > 0 && nl < 120 ? tail.slice(nl + 1) : tail
		return `… (이전 작업 메모 생략)\n${cleanTail}${sep}${structured}`
	}

	// 절차적 기억(교훈/Playbook) 렌더링
	renderLessons(scope = 'all', maxChars = 1200, { now = Date.now(), touch = false } = {}) {
		if (!this.store) return ''
		const list = this.store.listLessons({ scope, limit: 20 })
		if (!list.length) return ''
		const lines = []
		const usedKeys = []
		let chars = 0
		for (const l of list) {
			const line = `- (${l.key}${l.pinned ? ', 고정' : ''}) [상황] ${l.condition_text} → [원칙] ${l.rule_text}`
			if (chars + line.length + 1 > maxChars && lines.length > 0) break
			lines.push(line)
			usedKeys.push(l.key)
			chars += line.length + 1
		}
		if (touch && usedKeys.length) {
			try { this.store.touchLessons(usedKeys, now) } catch {}
		}
		return lines.join('\n')
	}

	// 기억 통합(Consolidation): 만료 아카이브, 유사 중복 키 탐지/병합, 반복 사건의 패턴 승격 후보 추출
	consolidate({ now = Date.now(), dry = false, mergeThreshold = 0.72 } = {}) {
		if (!this.store) return { archived_expired: [], merged: [], duplicates: [], promotion_candidates: [], expiring_soon: [] }
		const archived_expired = dry
			? this.store.listMemory({ includeExpired: true, now }).filter(it => it.expires_at && it.expires_at <= now).map(it => it.key)
			: this.store.archiveExpiredMemory(now)

		const items = this.store.listMemory({ now })
		const duplicates = []
		const merged = []
		const consumed = new Set()

		for (let i = 0; i < items.length; i++) {
			const a = items[i]
			if (consumed.has(a.key)) continue
			for (let j = i + 1; j < items.length; j++) {
				const b = items[j]
				if (consumed.has(b.key) || a.category !== b.category) continue
				const tokSim = jaccard(tokenize(`${a.key} ${a.content}`), tokenize(`${b.key} ${b.content}`))
				const biSim = jaccard(charNgrams(a.content, 2), charNgrams(b.content, 2))
				const sim = Math.max(tokSim, biSim)
				if (sim < 0.55) continue
				duplicates.push({ category: a.category, keep: a.key, dup: b.key, similarity: Math.round(sim * 100) / 100 })
				// 동일 카테고리 incident/rejection의 고도 중복(>= mergeThreshold)은 자동 병합(pinned 제외)
				if (!dry && sim >= mergeThreshold && !b.pinned && ['incident', 'rejection'].includes(a.category)) {
					const keeper = a.updated_at >= b.updated_at ? a : b
					const victim = keeper === a ? b : a
					if (victim.pinned) continue
					const mergedEntities = [...new Set([...(keeper.entity_ids ?? []), ...(victim.entity_ids ?? [])])]
					const mergedEvidence = (keeper.evidence_count ?? 1) + (victim.evidence_count ?? 1)
					const mergedContent = keeper.content.length >= victim.content.length ? keeper.content : victim.content
					this.store.upsertMemory({
						category: keeper.category,
						key: keeper.key,
						content: mergedContent,
						source: 'consolidation',
						confidence: Math.max(keeper.confidence ?? 1, victim.confidence ?? 1),
						expiresAt: keeper.expires_at ?? victim.expires_at ?? null,
						priority: Math.max(keeper.priority ?? 3, victim.priority ?? 3),
						pinned: keeper.pinned,
						entityIds: mergedEntities,
						evidenceCount: mergedEvidence,
						now,
					})
					this.store.deleteMemoryDetailed(victim.key, { source: 'consolidation', force: true, now })
					this.scheduleEmbedding([keeper.key])
					consumed.add(victim.key)
					merged.push({ kept: keeper.key, archived: victim.key, similarity: Math.round(sim * 100) / 100 })
				}
			}
		}

		// 동일 엔티티/주제에서 3회 이상 반복 확인된 incident는 pattern 승격 후보
		const fresh = this.store.listMemory({ now })
		const byEnt = new Map()
		for (const it of fresh) {
			if (it.category !== 'incident') continue
			if ((it.evidence_count ?? 1) >= 3) {
				byEnt.set(`key:${it.key}`, [it])
				continue
			}
			for (const eid of it.entity_ids ?? []) {
				if (!byEnt.has(eid)) byEnt.set(eid, [])
				byEnt.get(eid).push(it)
			}
		}
		const promotion_candidates = []
		for (const [group, list] of byEnt) {
			const totalEv = list.reduce((s, x) => s + (x.evidence_count ?? 1), 0)
			if (list.length >= 3 || totalEv >= 3) {
				promotion_candidates.push({ group, keys: list.map(x => x.key), evidence_count: totalEv })
			}
		}

		const expiring_soon = fresh
			.filter(it => it.expires_at && it.expires_at > now && it.expires_at - now <= 3 * DAY)
			.map(it => ({ key: it.key, category: it.category, expires_in_days: Math.ceil((it.expires_at - now) / DAY) }))

		return { archived_expired, merged, duplicates, promotion_candidates, expiring_soon }
	}

	hygieneHints(now = Date.now()) {
		const report = this.consolidate({ now, dry: true })
		const lines = []
		if (report.archived_expired.length) lines.push(`만료된 기억 ${report.archived_expired.length}건(자동 정리 예정): ${report.archived_expired.join(', ')}`)
		if (report.duplicates.length) lines.push(`유사 중복 의심 기억: ${report.duplicates.slice(0, 5).map(d => `${d.keep} ≈ ${d.dup} (${Math.round(d.similarity * 100)}%)`).join(', ')}`)
		if (report.promotion_candidates.length) lines.push(`패턴 승격 후보(반복 관측 3회+): ${report.promotion_candidates.slice(0, 4).map(p => `${p.group} [${p.keys.join(', ')}]`).join(', ')}`)
		if (report.expiring_soon.length) lines.push(`3일 내 만료 예정: ${report.expiring_soon.slice(0, 5).map(e => `${e.key}(${e.expires_in_days}일)`).join(', ')}`)
		return lines
	}
}
