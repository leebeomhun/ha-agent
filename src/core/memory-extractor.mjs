// 대화 직후 비동기 기억 추출기(Post-Turn Memory Extractor):
// Assist 응답 지연 없이 부재 일정·선호·영구 지시·사실 정정을 탐지해 구조화 장기 기억(memory_items)에 즉시 반영한다.
import { DAY, kst, log } from '../util.mjs'

const ABSENCE_RE = /(원주집|출장|여행|외박|다녀올|다녀올게|다녀올께|집\s*비울|비워|휴가|본가|시골|갔다\s*올|갔다가|며칠\s*있다가|돌아올|복귀)/
const ORDER_PREF_RE = /(앞으로|항상|절대|하지\s*마|끄지\s*마|켜지\s*마|꺼주지\s*마|켜주지\s*마|알리지\s*마|알려주지\s*마|기억해|잊지\s*마|원해|선호|로\s*해\s*둬|로\s*유지|로\s*두길|보내지\s*마)/
const CORRECTION_RE = /(아니야|그게\s*아니라|맞는데|바뀌었어|바꿨어|사실은|원래\s*)/

const WEEKDAYS = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 }
const KST_WD_IDX = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 }

export const EXTRACTOR_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['ops'],
	properties: {
		ops: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['op', 'category', 'key', 'content', 'ttl_days', 'pinned', 'confidence', 'entity_ids'],
				properties: {
					op: { type: 'string', enum: ['upsert', 'delete'] },
					category: { type: 'string', enum: ['preference', 'standing_order', 'incident', 'pattern', 'rejection'] },
					key: { type: 'string' },
					content: { type: 'string' },
					ttl_days: { type: ['integer', 'null'] },
					pinned: { type: ['boolean', 'null'] },
					confidence: { type: ['number', 'null'] },
					entity_ids: { type: ['array', 'null'], items: { type: 'string' } },
				},
			},
		},
	},
}

export function hasMemorySignal(userText) {
	const t = String(userText ?? '').trim()
	if (t.length < 4) return false
	return ABSENCE_RE.test(t) || ORDER_PREF_RE.test(t) || CORRECTION_RE.test(t)
}

// "월요일에 올게", "내일 돌아와", "모레까지", "3일 뒤" 같은 상대 한국어 날짜를 KST 만료일(복귀 다음 날 00시)로 계산
export function estimateKoreanExpiryMs(text, now = Date.now()) {
	const t = String(text ?? '')
	const k = kst(new Date(now))
	const todayMidnight = Date.parse(`${k.date}T00:00:00+09:00`)

	const daysMatch = /(\d{1,2})\s*일\s*(?:뒤|후|동안|간)/.exec(t)
	if (daysMatch) {
		const d = Math.min(Math.max(Number(daysMatch[1]), 1), 60)
		return todayMidnight + (d + 1) * DAY
	}
	if (/글피/.test(t)) return todayMidnight + 4 * DAY
	if (/모레/.test(t)) return todayMidnight + 3 * DAY
	if (/내일/.test(t)) return todayMidnight + 2 * DAY

	const wdMatch = /(다음\s*주\s*)?([일월화수목금토])요일/.exec(t)
	if (wdMatch) {
		const isNextWeek = Boolean(wdMatch[1])
		const targetWd = WEEKDAYS[wdMatch[2]]
		const curWd = KST_WD_IDX[k.wd]
		let delta = (targetWd - curWd + 7) % 7
		if (delta === 0) delta = 7
		if (isNextWeek && delta < 7) delta += 7
		return todayMidnight + (delta + 1) * DAY
	}
	return null
}

// LLM 호출이 불가능하거나 비활성화되었을 때의 안전한 결정론적 폴백 추출
export function deterministicExtract(userText, now = Date.now()) {
	const t = String(userText ?? '').trim()
	if (!t) return []
	const k = kst(new Date(now))
	const dayTag = k.date.replace(/-/g, '')

	if (ABSENCE_RE.test(t)) {
		const expMs = estimateKoreanExpiryMs(t, now) ?? (now + 7 * DAY)
		const ttlDays = Math.max(1, Math.ceil((expMs - now) / DAY))
		return [{
			op: 'upsert',
			category: 'incident',
			key: `absence_schedule_${dayTag}`,
			content: `(${k.date}) 사용자 부재·귀가 일정: "${t.slice(0, 180)}"`,
			ttl_days: ttlDays,
			pinned: false,
			confidence: 0.9,
			entity_ids: ['person.ibeomhun'],
		}]
	}

	if (/(앞으로|항상|절대|기억해|잊지\s*마)/.test(t) && ORDER_PREF_RE.test(t)) {
		const slug = t.replace(/[^a-zA-Z0-9가-힣]+/g, '_').replace(/^_|_$/g, '').slice(0, 24)
		const isOrder = /(앞으로|항상|절대|하지\s*마|끄지\s*마|켜지\s*마|알리지\s*마|보내지\s*마)/.test(t)
		return [{
			op: 'upsert',
			category: isOrder ? 'standing_order' : 'preference',
			key: `${isOrder ? 'order' : 'pref'}_${dayTag}_${Math.abs(hashSimple(slug)).toString(36).slice(0, 6)}`,
			content: `(${k.date}) 사용자 대화 지시·선호: "${t.slice(0, 220)}"`,
			ttl_days: null,
			pinned: isOrder,
			confidence: 0.85,
			entity_ids: [],
		}]
	}
	return []
}

function hashSimple(s) {
	let h = 0
	for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
	return h
}

export async function extractMemoryFromTurn({
	text, assistantText = '', now = Date.now(), cfg = {},
	llmRouter = null, existingKeys = [], mode = null, model = null,
} = {}) {
	if (!hasMemorySignal(text)) return []
	const k = kst(new Date(now))

	// LLM 추출기 사용 가능하면 정밀 추출 시도
	if (llmRouter && cfg?.memory?.post_turn_llm !== false && mode && !['codex', 'agy'].includes(mode)) {
		try {
			const prompt = [
				`현재 시각(KST): ${k.date}(${k.wd}) ${k.hm}`,
				existingKeys.length ? `기존 기억 키(중복 생성 방지용): ${existingKeys.slice(0, 40).join(', ')}` : '',
				`[사용자 발화] ${text}`,
				assistantText ? `[비서 응답] ${assistantText}` : '',
				'',
				'위 대화에서 앞으로의 집 관리·브리핑·제어에 꼭 기억해야 할 사실(임시 부재·귀가 일정, 영구 지시 standing_order, 선호 preference, 사실 정정, 거절)만 추출하라.',
				'- 단순 기기 제어 명령이나 잡담은 빈 배열 {"ops":[]}로 답한다.',
				'- 임시 부재/일정(예: "원주집에 갔다가 월요일에 올게")은 category="incident"로 두고 복귀 다음 날까지 ttl_days를 계산해 넣는다.',
				'- 영구 지시("앞으로 ~하지 마")는 category="standing_order", pinned=true, ttl_days=null로 둔다.',
				'- 기존 키와 같은 주제면 그 키를 그대로 재사용(upsert)한다.',
			].filter(Boolean).join('\n')

			const res = await llmRouter.run({
				cfg,
				mode,
				model,
				effort: 'low',
				timeoutSec: 15,
				prompt: [{ role: 'user', content: prompt }],
				instructions: '너는 Home Assistant 비서의 백그라운드 기억 추출기다. 꼭 기억할 항목만 JSON 스키마에 맞춰 추출하라.',
				customSchema: EXTRACTOR_SCHEMA,
				includeFileTools: false,
				toolBroker: null,
				runDir: null,
			})
			const ops = Array.isArray(res?.result?.ops) ? res.result.ops : []
			if (ops.length) return ops.slice(0, 5)
		} catch (e) {
			log('Post-Turn LLM 기억 추출 실패(결정론적 폴백 시도):', e.message)
		}
	}

	return deterministicExtract(text, now)
}
