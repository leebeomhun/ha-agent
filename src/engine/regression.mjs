// Assist 빠른 경로(LLM 없이 바로 켜고 끄는 길) 회귀 평가.
// 별칭 같은 설정을 바꾸기 전후에 같은 평가 사례를 돌려, 전에는 맞던 말이 틀린 기기로 가거나 질문에 기기를 움직이게 되면 막는다.
// LLM을 부르지 않는 결정론적 평가라 승인할 때마다·매일 돌려도 비용이 없다.
import { buildDirectory, matchFastCommand } from '../orchestrator/assist-context.mjs'
import { globs } from '../util.mjs'
import { DEFAULT_CASES } from '../orchestrator/assist-cases.mjs'
import { loadEvalCases } from './learning.mjs'

// 어느 집에서나 지켜야 하는 것: 질문·의향·금지·여러 동작은 빠른 경로가 바로 실행하면 안 된다.
export const BUILTIN_SAFETY_CASES = [
	{ text: '불 켜져 있어?', expect: [] },
	{ text: '불 켤까?', expect: [] },
	{ text: '불 켜지 마', expect: [] },
	{ text: '불 끄지 말아 줘', expect: [] },
	{ text: '불 켜고 TV 꺼줘', expect: [] },
	{ text: '어제 불 몇 번 켰어?', expect: [] },
]

// 평가 사례 모음: 기본 벤치마크 + 안전 사례 + 실패에서 자동으로 쌓인 사례(기대값이 있는 것만) + extra
export function fastPathCases({ includeLearned = true, extra = [], evalPath = undefined } = {}) {
	const learned = includeLearned ? loadEvalCases(evalPath).filter(c => Array.isArray(c.expect)).map(c => ({ text: c.text, expect: c.expect, learned: true })) : []
	const seen = new Set()
	const out = []
	for (const c of [...DEFAULT_CASES, ...BUILTIN_SAFETY_CASES, ...learned, ...extra]) {
		const k = String(c.text ?? '').replace(/\s+/g, '').toLowerCase()
		if (!k || seen.has(k)) continue
		seen.add(k)
		out.push(c)
	}
	return out
}

export function directoryIndexFor({ policy, states, meta = {}, cfg = {}, aliases = undefined }) {
	const as = cfg.assist ?? {}
	return buildDirectory({
		policy, states, areaOf: meta.areaOf ?? null, catOf: meta.catOf ?? null,
		aliases: aliases ?? as.aliases ?? {}, isNoise: globs(cfg.noise_entities ?? []), scriptFields: meta.scriptFields ?? null,
	}).index
}

// 한 사례 채점. 빠른 경로는 켜기/끄기 하나만 한다.
// - 기대값 []: 아무것도 실행하면 안 된다(질문·금지 등) → 맞으면 실패
// - 기대값 1개(켜기/끄기): 빠른 경로가 넘기면(LLM) 괜찮고, 잡았다면 같은 기기·동작이어야 한다
// - 기대값 여러 개 또는 다른 서비스: 빠른 경로가 잡으면 안 된다(하나만 하고 끝나므로)
export function judgeFastPath(c, got) {
	if (!Array.isArray(c.expect)) return { ok: true, skipped: true }
	if (!got) return { ok: true }
	const one = c.expect.length === 1 && ['turn_on', 'turn_off'].includes(c.expect[0][1]) ? c.expect[0] : null
	if (one && got.entity_id === one[0] && got.service === one[1]) return { ok: true }
	return { ok: false }
}

export function runFastPathRegression({ index, cases }) {
	const failed = []
	let passed = 0, skipped = 0
	for (const c of cases) {
		const got = matchFastCommand(c.text, index)
		const j = judgeFastPath(c, got)
		if (j.skipped) { skipped++; continue }
		if (j.ok) passed++
		else failed.push({ text: c.text, expect: c.expect, got: got ? [got.entity_id, got.service] : null })
	}
	return { total: passed + failed.length, passed, failed, skipped }
}

// 별칭 하나를 더하기 전후 비교. 새로 생긴 실패(전에는 통과)와, 새 별칭이 정작 그 기기로 가지 않는 경우를 잡는다.
export function checkAliasChange({ policy, states, meta = {}, cfg = {}, entityId, alias, evalPath = undefined }) {
	if (!states?.size) return { ok: true, skipped: true, errors: [], warnings: ['HA 상태 목록이 없어 빠른 경로 회귀 평가를 건너뜀'] }
	const cur = cfg.assist?.aliases ?? {}
	const next = { ...cur, [entityId]: [...new Set([...(cur[entityId] ?? []), alias])] }
	const service = states.get(entityId) && !String(entityId).startsWith('media_player.') ? 'turn_on' : 'turn_off'
	const probe = { text: `${alias} ${service === 'turn_on' ? '켜줘' : '꺼줘'}`, expect: [[entityId, service]] }
	const cases = fastPathCases({ evalPath })
	const before = runFastPathRegression({ index: directoryIndexFor({ policy, states, meta, cfg, aliases: cur }), cases })
	const afterIndex = directoryIndexFor({ policy, states, meta, cfg, aliases: next })
	const after = runFastPathRegression({ index: afterIndex, cases })
	const wasFailing = new Set(before.failed.map(f => f.text))
	const errors = after.failed.filter(f => !wasFailing.has(f.text)).map(f => `회귀: "${f.text}" → ${f.got ? f.got.join(' ') : '없음'} (기대 ${f.expect.map(e => e.join(' ')).join(', ') || '제어 없음'})`)
	const got = matchFastCommand(probe.text, afterIndex)
	if (!got || got.entity_id !== entityId) errors.push(`새 별칭 "${alias}"이 빠른 경로에서 ${got ? `다른 기기(${got.entity_id})로 감` : '인식되지 않음'}`)
	return { ok: errors.length === 0, errors, warnings: [], before: { passed: before.passed, total: before.total }, after: { passed: after.passed, total: after.total } }
}
