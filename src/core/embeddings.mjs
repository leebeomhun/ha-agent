// 한국어·영문 하이브리드 텍스트 유사도, 경량 로컬 임베딩(폴백), Gemini Embedding 2 / 001 API 클라이언트
import { geminiKey } from '../llm/providers/gemini.mjs'

export const LOCAL_EMBED_DIMS = 512
export const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-2'
export const DEFAULT_EMBEDDING_DIMS = 768
export const DEFAULT_SEMANTIC_THRESHOLD = 0.66

const STOP = new Set([
	'은', '는', '이', '가', '을', '를', '의', '에', '에서', '로', '으로', '와', '과', '도', '만', '좀', '잘', '더', '때', '것', '수', '등', '및', '또는',
	'the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'for',
])
const KOREAN_JOSA_RE = /(?:에서|으로|부터|까지|처럼|보다|라고|하고|이라|에는|에도|과는|와는|은|는|이|가|을|를|의|에|로|와|과|도|만)$/

export function normalizeText(s) {
	return String(s ?? '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_.\s-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

export function tokenize(s) {
	const norm = normalizeText(s)
	if (!norm) return []
	const out = []
	for (const raw of norm.split(' ')) {
		if (!raw) continue
		const stripped = raw.length >= 3 ? raw.replace(KOREAN_JOSA_RE, '') : raw
		const tok = stripped.length >= 2 ? stripped : raw
		if (tok.length >= 2 && !STOP.has(tok)) out.push(tok)
		if (tok !== raw && raw.length >= 2 && !STOP.has(raw)) out.push(raw)
	}
	return [...new Set(out)]
}

export function charNgrams(s, n = 2) {
	const compact = normalizeText(s).replace(/\s+/g, '')
	if (!compact) return []
	if (compact.length <= n) return [compact]
	const out = []
	for (let i = 0; i <= compact.length - n; i++) out.push(compact.slice(i, i + n))
	return out
}

export function jaccard(aList, bList) {
	const a = new Set(aList), b = new Set(bList)
	if (!a.size || !b.size) return 0
	let inter = 0
	for (const x of a) if (b.has(x)) inter++
	return inter / (a.size + b.size - inter)
}

function fnv1a(str) {
	let h = 2166136261
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return h >>> 0
}

export function normalizeVec(vec, decimals = 5) {
	if (!Array.isArray(vec) || !vec.length) return null
	let norm = 0
	for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
	if (norm <= 0) return null
	const inv = 1 / Math.sqrt(norm)
	const scale = 10 ** decimals
	const out = new Array(vec.length)
	for (let i = 0; i < vec.length; i++) out[i] = Math.round(vec[i] * inv * scale) / scale
	return out
}

// 오프라인·제로의존성 로컬 해시 임베딩(512차원 정규화 벡터). Gemini API 불가 시 폴백으로 사용된다.
export function localEmbed(text, dims = LOCAL_EMBED_DIMS) {
	const vec = new Float32Array(dims)
	const tokens = tokenize(text)
	const bi = charNgrams(text, 2)
	const tri = charNgrams(text, 3)
	const add = (feat, weight) => {
		const h = fnv1a(feat)
		const idx = h % dims
		const sign = (h & 1) ? 1 : -1
		vec[idx] += sign * weight
	}
	for (const t of tokens) add(`w:${t}`, 2.0)
	for (const g of bi) add(`2:${g}`, 1.0)
	for (const g of tri) add(`3:${g}`, 1.2)
	let norm = 0
	for (let i = 0; i < dims; i++) norm += vec[i] * vec[i]
	if (norm <= 0) return null
	const inv = 1 / Math.sqrt(norm)
	return Array.from(vec, v => Math.round(v * inv * 10000) / 10000)
}

export function packEmbedding(vec, model = 'local') {
	if (!Array.isArray(vec) || !vec.length) return null
	return { model: String(model || 'local'), dims: vec.length, vec }
}

export function unpackEmbedding(raw) {
	if (!raw) return null
	let v = raw
	if (typeof v === 'string') {
		try { v = JSON.parse(v) } catch { return null }
	}
	if (Array.isArray(v) && v.length && typeof v[0] === 'number') {
		return { model: 'local', dims: v.length, vec: v }
	}
	if (v && typeof v === 'object' && Array.isArray(v.vec) && v.vec.length) {
		return { model: String(v.model || 'local'), dims: Number(v.dims) || v.vec.length, vec: v.vec }
	}
	return null
}

export function cosineSimilarity(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0
	let dot = 0, na = 0, nb = 0
	for (let i = 0; i < a.length; i++) {
		const x = a[i], y = b[i]
		dot += x * y
		na += x * x
		nb += y * y
	}
	if (na <= 0 || nb <= 0) return 0
	return dot / Math.sqrt(na * nb)
}

export function lexicalSimilarity(query, text) {
	const qNorm = normalizeText(query)
	const tNorm = normalizeText(text)
	if (!qNorm || !tNorm) return 0
	let score = 0
	if (tNorm.includes(qNorm)) score += 1.0
	const qToks = tokenize(qNorm)
	const tToks = tokenize(tNorm)
	if (qToks.length) {
		let hits = 0
		for (const qt of qToks) {
			const exactOrSub = tNorm.includes(qt) || tToks.some(tt => tt.includes(qt) || (tt.length >= 3 && qt.includes(tt) && tt.length / qt.length >= 0.6))
			if (exactOrSub) hits++
		}
		score += (hits / qToks.length) * 0.9
	}
	const qBi = charNgrams(qNorm, 2)
	const tBi = charNgrams(tNorm, 2)
	if (qBi.length && tBi.length) {
		const tSet = new Set(tBi)
		let biHit = 0
		for (const g of qBi) if (tSet.has(g)) biHit++
		score += (biHit / qBi.length) * 0.7
	}
	return score
}

export function isGeminiEmbedding2(model) {
	return /^gemini-embedding-2(?:\b|-)/i.test(String(model ?? '').trim())
}

// Gemini Embedding 2는 taskType 대신 공식 프롬프트 접두어(prefix)를 사용해야 검색 분리도가 크게 높아진다.
export function formatEmbedInput(text, { model = DEFAULT_EMBEDDING_MODEL, task = 'document', title = null } = {}) {
	const raw = String(text ?? '').trim().slice(0, 4000)
	if (!isGeminiEmbedding2(model)) return raw
	if (task === 'query') return `task: search result | query: ${raw}`
	if (task === 'similarity') return `task: sentence similarity | query: ${raw}`
	const t = String(title ?? '').trim() || 'none'
	return `title: ${t} | text: ${raw}`
}

const LEGACY_TASK_MAP = {
	query: 'RETRIEVAL_QUERY',
	document: 'RETRIEVAL_DOCUMENT',
	similarity: 'SEMANTIC_SIMILARITY',
}

// Gemini Embedding API 호출(gemini-embedding-2 기본 권장, gemini-embedding-001 호환).
// 실패하거나 model === 'local'이면 로컬 해시 임베딩(512차원)으로 안전하게 폴백한다.
export async function embedText(text, {
	cfg = null,
	model = null,
	dims = null,
	task = 'document',
	title = null,
	fetchFn = fetch,
	timeoutMs = 8000,
} = {}) {
	const rawModel = String(model ?? cfg?.memory?.embedding_model ?? 'local').trim()
	const resolvedDims = Math.min(Math.max(Number(dims ?? cfg?.memory?.embedding_dims) || DEFAULT_EMBEDDING_DIMS, 128), 3072)
	const fallback = (reason = null) => {
		const vec = localEmbed(text)
		return vec ? { model: 'local', dims: vec.length, vec, fallback: true, ...(reason ? { error: reason } : {}) } : null
	}
	if (!rawModel || rawModel === 'local') return fallback()
	const cleanText = String(text ?? '').trim()
	if (!cleanText) return null

	try {
		const key = geminiKey(cfg)
		const base = (cfg?.gemini?.base_url || cfg?.llm?.gemini?.base_url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
		const url = `${base}/models/${encodeURIComponent(rawModel)}:embedContent`
		const formatted = formatEmbedInput(cleanText, { model: rawModel, task, title })
		const body = {
			content: { parts: [{ text: formatted }] },
			outputDimensionality: resolvedDims,
		}
		if (!isGeminiEmbedding2(rawModel)) {
			body.taskType = LEGACY_TASK_MAP[task] ?? 'RETRIEVAL_DOCUMENT'
			if (task === 'document' && title) body.title = String(title).slice(0, 120)
		}
		const res = await fetchFn(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!res.ok) {
			const msg = (await res.text().catch(() => '')).slice(0, 160)
			return fallback(`HTTP ${res.status}: ${msg}`)
		}
		const j = await res.json()
		const vals = j?.embedding?.values
		if (!Array.isArray(vals) || !vals.length) return fallback('빈 임베딩 벡터 응답')
		const vec = normalizeVec(vals, 5)
		if (!vec) return fallback('정규화 실패')
		return { model: rawModel, dims: vec.length, vec, fallback: false }
	} catch (e) {
		return fallback(e?.message || '임베딩 호출 실패')
	}
}

export class EmbeddingCache {
	constructor({ max = 128, ttlMs = 15 * 60 * 1000 } = {}) {
		this.max = max
		this.ttlMs = ttlMs
		this.map = new Map()
	}

	get(key, now = Date.now()) {
		const hit = this.map.get(key)
		if (!hit) return null
		if (now - hit.ts > this.ttlMs) {
			this.map.delete(key)
			return null
		}
		this.map.delete(key)
		this.map.set(key, hit)
		return hit.val
	}

	set(key, val, now = Date.now()) {
		if (!val) return
		if (this.map.has(key)) this.map.delete(key)
		else if (this.map.size >= this.max) {
			const oldest = this.map.keys().next().value
			if (oldest !== undefined) this.map.delete(oldest)
		}
		this.map.set(key, { val, ts: now })
	}

	clear() { this.map.clear() }
}
