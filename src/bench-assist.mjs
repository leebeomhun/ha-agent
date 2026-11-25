// Assist 모델 벤치마크: 실제 HA 상태·프롬프트·도구로 여러 모델을 같은 발화에 돌려 지연·왕복·토큰·정확도를 비교한다.
// 안전장치: HA 쓰기 호출(call_service·fire_event·REST 쓰기)을 막고, 기기 제어는 정책 판정만 한 뒤 성공으로 흉내 내며,
// 기억 저장·제안 생성·결정 기록도 하지 않는다. 집 기기는 절대 움직이지 않는다.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HA } from './ha.mjs'
import { Agent } from './agent.mjs'
import { Store } from './core/store.mjs'
import { PolicyEngine } from './core/policy.mjs'
import { matchFastCommand } from './orchestrator/assist-context.mjs'
import { normalizeMode, selfCheck } from './brain.mjs'
import { loadEvalCases } from './engine/learning.mjs'
import { P, expandHome, kst } from './util.mjs'

export const DEFAULT_MODELS = [
	'gemini:gemini-4-hydrogen:low',
	'gemini:gemini-3.5-flash-lite:minimal',
	'gemini:gemini-3.5-flash-lite:low',
	'api:gpt-6-luna:none',
	'api:gpt-6-luna:low',
	'api:gpt-6.1-terra:none',
]

// expect: 시도해야 하는 제어 [entity_id, service, option?] 목록. 빈 배열이면 제어하면 안 되는 질문.
import { DEFAULT_CASES } from './orchestrator/assist-cases.mjs'
export { DEFAULT_CASES }

// 대략적인 표준 가격(1M 토큰당 달러: 입력, 출력, 캐시 입력). Gemini 캐시 할인은 반영하지 않은 상한값.
const PRICE = {
	'gemini-4-hydrogen': [1.5, 7.5, 1.5],
	'gemini-4-carbon': [2, 10, 2],
	'gemini-3.5-flash-lite': [0.3, 2.5, 0.3],
	'gpt-6-luna': [0.1, 0.5, 0.01],
	'gpt-6.1-terra': [1, 5, 0.05],
	'gpt-6.1-sol': [2, 10, 0.1],
	'gpt-6.2-sol': [2, 10, 0.1],
}
const costOf = (model, u) => {
	const p = PRICE[model]
	if (!p || !u) return null
	const uncached = Math.max(0, (u.input ?? 0) - (u.cached ?? 0))
	const out = (u.output ?? 0) + (model.startsWith('gemini') ? (u.reasoning ?? 0) : 0)
	return (uncached * p[0] + (u.cached ?? 0) * p[2] + out * p[1]) / 1e6
}

export function parseModelSpec(spec) {
	const [provider, model, effort] = String(spec).split(':')
	if (!provider || !model) throw new Error(`모델 형식 오류: ${spec} (provider:model[:effort])`)
	return { provider: normalizeMode(provider), model, effort: effort || null, label: spec }
}

const median = xs => {
	const s = [...xs].sort((a, b) => a - b)
	return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null
}

function judge(expect, calls) {
	const got = calls.map(c => [c.entity_id, c.service, c.option].filter(v => v != null).join(' ')).sort()
	if (!Array.isArray(expect)) return { ok: true, got, want: [] } // 기대값 없는 임의 발화는 채점하지 않음
	const want = expect.map(e => e.join(' ')).sort()
	return { ok: JSON.stringify(got) === JSON.stringify(want), got, want }
}

async function connectHa(cfg, policy) {
	const ha = new HA({ url: cfg.ha_ws_url, tokenFile: expandHome(cfg.token_file), notifyTargets: [], policy })
	ha.start()
	const list = await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('HA 연결 시간 초과')), 20000)
		ha.once('ready', l => { clearTimeout(t); resolve(l) })
	})
	// 쓰기 차단: 서비스 호출·이벤트 발생·REST 쓰기
	const call = ha.call.bind(ha)
	ha.call = (msg, t) => (['call_service', 'fire_event'].includes(msg?.type)
		? Promise.reject(new Error('벤치마크: HA 쓰기 호출 차단'))
		: call(msg, t))
	const rest = ha.rest.bind(ha)
	ha.rest = (method, ...r) => (String(method).toUpperCase() === 'GET'
		? rest(method, ...r)
		: Promise.reject(new Error('벤치마크: HA 쓰기 호출 차단')))
	return { ha, list }
}

export function mergedBenchCases({ includeLearned = false, baseCases = DEFAULT_CASES } = {}) {
	if (!includeLearned) return baseCases
	const learned = loadEvalCases().map(c => ({ text: c.text, expect: Array.isArray(c.expect) ? c.expect : null, learned: true, source: c.source }))
	const seen = new Set(baseCases.map(c => c.text.replace(/\s+/g, '').toLowerCase()))
	return [...baseCases, ...learned.filter(c => !seen.has(c.text.replace(/\s+/g, '').toLowerCase()))]
}

export async function benchAssist({ cfg, models = DEFAULT_MODELS, cases = DEFAULT_CASES, includeLearned = false, repeat = 1, out = console.log } = {}) {
	cases = includeLearned ? mergedBenchCases({ includeLearned: true, baseCases: cases }) : cases
	const specs = models.map(parseModelSpec)
	const bcfg = structuredClone(cfg)
	bcfg.assist = { ...bcfg.assist, fast_path: false, deep: null }
	bcfg.llm = { ...bcfg.llm, routes: { ...bcfg.llm?.routes } }
	// 오늘 판단 한도(데몬과 같은 카운터 파일)에 막히지 않게 한다. dry라 카운터는 올리지 않는다.
	bcfg.limits = { ...bcfg.limits, brain_runs_per_day: 1e9 }

	const { ha, list } = await connectHa(bcfg, new PolicyEngine(bcfg))
	let calls = []
	const agent = new Agent({
		dry: true, cfg: bcfg, ha,
		assistControl: async req => {
			const service = req.action ?? req.service
			const v = agent.policy.evaluateControl(req, { states: agent.states, requested: true })
			calls.push({ entity_id: req.entity_id, service, option: req.service_data?.option, ok: v.ok, noop: Boolean(v.noop), error: v.error })
			if (!v.ok) return { ok: false, status: 'rejected', error: v.error }
			if (v.noop) return { ok: true, status: 'noop' }
			return { ok: true, status: 'done', rec: { entity_id: req.entity_id, service: v.service, service_data: v.service_data, status: 'done' } }
		},
	})
	let store = null
	try {
		for (const s of list) agent.states.set(s.entity_id, s)
		await agent.prepareAssist()
		try {
			store = new Store()
			agent.memoryMgr.store = store
		} catch (e) { out(`(기억 DB를 열지 못해 구조화 기억 없이 진행: ${e.message})`) }
		agent.memoryMgr.applyOps = () => ({ upserted: [], deleted: [], note: '벤치마크: 저장 생략' })
		agent.haAdmin.createProposal = async () => ({ ok: false, error: '벤치마크: 제안 생성 생략' })
		agent.handleProposalAction = async () => ({ ok: false, error: '벤치마크: 제안 처리 생략' })

		const dir = agent.assistDirectory()
		out(`HA 상태 ${agent.states.size}개, 제어 가능 기기 ${agent.policy.tiersMap().size}개, 빠른 경로 이름 ${dir.index.size}개`)
		out('\n[로컬 빠른 경로] LLM 없이 처리되는 발화:')
		for (const c of cases) {
			const m = matchFastCommand(c.text, dir.index)
			out(`  ${m ? '✔' : '·'} "${c.text}"${m ? ` → ${m.entity_id} ${m.service}` : ''}`)
		}

		const results = []
		for (const spec of specs) {
			if (selfCheck(bcfg, spec.provider)) {
				out(`\n[${spec.label}] 건너뜀: ${selfCheck(bcfg, spec.provider)}`)
				continue
			}
			bcfg.llm.routes.assist = spec.provider
			bcfg.assist.model = spec.model
			bcfg.assist.effort = spec.effort
			out(`\n[${spec.label}]`)
			for (let r = 0; r < repeat; r++) {
				for (const c of cases) {
					calls = []
					const res = await agent.handleAssist({ text: c.text, conversationId: `bench_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, channel: 'bench' })
					const m = res.meta ?? {}
					const verdict = judge(c.expect, calls)
					const row = {
						model: spec.label, text: c.text, ms: res.ms, path: m.path, rounds: m.rounds, tool_calls: m.tool_calls,
						usage: m.usage ?? null, cost: costOf(spec.model, m.usage), ok: verdict.ok && m.path !== 'error', got: verdict.got, want: verdict.want, speech: res.speech,
					}
					results.push(row)
					out(`  ${row.ok ? '✔' : '✘'} ${(row.ms / 1000).toFixed(1).padStart(5)}초 왕복${row.rounds ?? '?'} 도구${row.tool_calls ?? '?'}${m.path === 'early' ? ' 조기' : ''} | ${c.text} → ${row.speech.slice(0, 70)}${verdict.ok ? '' : ` [기대 ${verdict.want.join(', ') || '제어 없음'} / 실제 ${verdict.got.join(', ') || '제어 없음'}]`}`)
				}
			}
		}

		const summary = specs.map(spec => {
			const rows = results.filter(r => r.model === spec.label)
			if (!rows.length) return null
			const ctl = rows.filter(r => cases.find(c => c.text === r.text)?.expect?.length)
			const costs = rows.map(r => r.cost).filter(v => v != null)
			return {
				model: spec.label,
				accuracy: `${rows.filter(r => r.ok).length}/${rows.length}`,
				median_s: +(median(rows.map(r => r.ms)) / 1000).toFixed(1),
				control_median_s: ctl.length ? +(median(ctl.map(r => r.ms)) / 1000).toFixed(1) : null,
				max_s: +(Math.max(...rows.map(r => r.ms)) / 1000).toFixed(1),
				avg_rounds: +(rows.reduce((a, r) => a + (r.rounds ?? 0), 0) / rows.length).toFixed(1),
				avg_input_tokens: Math.round(rows.reduce((a, r) => a + (r.usage?.input ?? 0), 0) / rows.length),
				cost_per_1000_turns_usd: costs.length ? +(costs.reduce((a, b) => a + b, 0) / costs.length * 1000).toFixed(2) : null,
			}
		}).filter(Boolean)

		out('\n[요약]')
		for (const s of summary) {
			out(`  ${s.model.padEnd(36)} 정확 ${s.accuracy.padStart(5)} | 중앙값 ${String(s.median_s).padStart(4)}초 (제어 ${s.control_median_s ?? '-'}초, 최대 ${s.max_s}초) | 평균 왕복 ${s.avg_rounds} | 입력 ${s.avg_input_tokens}토큰 | 1000회 약 $${s.cost_per_1000_turns_usd ?? '?'}`)
		}
		const dirOut = join(dirname(P.decisions), 'bench')
		mkdirSync(dirOut, { recursive: true })
		const file = join(dirOut, `assist-${kst().iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}.json`)
		writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), repeat, summary, results }, null, 1) + '\n')
		out(`\n결과 파일: ${file}`)
		return { summary, results, file }
	} finally {
		ha.stop()
		store?.close()
	}
}
