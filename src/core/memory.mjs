// 계층형 메모리: 집 프로필(home-profile.md), 평문 메모(memory.md), 구조화 장기 기억(SQLite memory_items)을 통합 관리한다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { P, kst } from '../util.mjs'
import { snapshot } from '../records.mjs'

const CAT_LABEL = {
	preference: '선호',
	standing_order: '지시사항',
	rejection: '거절된 제안',
	incident: '장애·이력',
	pattern: '생활 패턴',
}

export class MemoryManager {
	constructor({ store = null, memoryPath = P.memory, profilePath = P.homeProfile } = {}) {
		this.store = store
		this.memoryPath = memoryPath
		this.profilePath = profilePath
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

	applyOps(ops = [], { source = 'agent', now = Date.now() } = {}) {
		if (!this.store || !Array.isArray(ops) || !ops.length) return { upserted: [], deleted: [] }
		const upserted = [], deleted = []
		for (const item of ops) {
			if (!item?.key) continue
			if (item.op === 'delete') {
				if (this.store.deleteMemory(item.key)) deleted.push(item.key)
			} else if (item.content) {
				this.store.upsertMemory({
					category: item.category || 'pattern',
					key: String(item.key).slice(0, 80),
					content: String(item.content).slice(0, 500),
					source,
					now,
				})
				upserted.push(item.key)
			}
		}
		return { upserted, deleted }
	}

	list(category = null) {
		if (!this.store) return []
		return this.store.listMemory({ category })
	}

	search(query, category = null) {
		if (this.store) return this.store.searchMemory(query, { category })
		const q = String(query ?? '').toLowerCase()
		return this.readLegacy().split('\n').filter(l => l.toLowerCase().includes(q)).map((line, i) => ({ category: 'legacy', key: `line_${i + 1}`, content: line }))
	}

	renderStructured(maxChars = 2500) {
		const items = this.list()
		if (!items.length) return ''
		const byCat = new Map()
		for (const it of items) {
			if (!byCat.has(it.category)) byCat.set(it.category, [])
			byCat.get(it.category).push(it)
		}
		const lines = []
		for (const [cat, list] of byCat) {
			lines.push(`[${CAT_LABEL[cat] ?? cat}]`)
			for (const it of list) lines.push(`- (${it.key}) ${it.content}`)
		}
		const text = lines.join('\n')
		return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (나머지 생략)` : text
	}

	renderForPrompt(maxChars = 6000) {
		const legacy = this.readLegacy().trim()
		const structured = this.renderStructured(Math.min(2500, Math.floor(maxChars * 0.45)))
		if (!structured) return legacy
		if (!legacy) return structured
		const joined = `${legacy}\n\n### 구조화 장기 기억\n${structured}`
		return joined.length <= maxChars ? joined : `${legacy.slice(0, Math.max(0, maxChars - structured.length - 30))}\n\n### 구조화 장기 기억\n${structured}`
	}
}
