// Policy-Gated Tool Broker: OpenAI Responses API strict 스키마 도구 목록 생성, 실행, 감사 기록
import { readTools } from './read.mjs'
import { controlTools } from './control.mjs'
import { adminTools } from './admin.mjs'
import { log } from '../util.mjs'

const toStrictTool = t => ({
	type: 'function',
	name: t.name,
	description: t.description,
	strict: true,
	parameters: {
		type: 'object',
		additionalProperties: false,
		required: Object.keys(t.properties ?? {}),
		properties: t.properties ?? {},
	},
})

// 한 차례의 도구 호출들을 실행한다. 모두 조회 도구면 동시에, 하나라도 상태를 바꾸는 도구가 있으면 순서대로.
export async function runToolRound(calls, runOne, isReadOnly = () => false) {
	if (calls.length > 1 && calls.every(c => isReadOnly(c.name))) return Promise.all(calls.map(c => runOne(c)))
	const out = []
	for (const c of calls) out.push(await runOne(c))
	return out
}

export class ToolBroker {
	constructor(defaultCtx = {}) {
		this.defaultCtx = defaultCtx
		this.map = new Map()
		this.audit = []
		this.readOnly = new Set(readTools().map(t => t.name))
		for (const t of [...readTools(), ...controlTools(), ...adminTools()]) {
			this.map.set(t.name, t)
		}
	}

	has(name) { return this.map.has(name) }

	// 상태를 바꾸지 않는 조회 도구인지. 한 차례에 조회 도구만 여러 개 부르면 동시에 실행해도 된다.
	isReadOnly(name) { return this.readOnly.has(name) }

	tools(ctx = null) {
		const allowAdmin = (ctx?.adminEnabled ?? this.defaultCtx.adminEnabled ?? true)
		return [...this.map.values()]
			.filter(t => allowAdmin || (t.name !== 'ha_propose_admin' && t.name !== 'ha_proposal_action'))
			.map(toStrictTool)
	}

	async run(name, argsJson, ctx = null) {
		const tool = this.map.get(name)
		if (!tool) return `오류: 없는 도구: ${name}`
		let args = {}
		try {
			args = argsJson ? (typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson) : {}
		} catch (e) {
			return `오류: 잘못된 JSON 인자 (${e.message})`
		}
		const mergedCtx = { ...this.defaultCtx, ...(ctx ?? {}) }
		const started = Date.now()
		try {
			const out = await tool.run(mergedCtx, args)
			this.audit.push({ ts: started, name, ms: Date.now() - started, ok: true })
			if (this.audit.length > 200) this.audit.shift()
			return typeof out === 'string' ? out : JSON.stringify(out)
		} catch (e) {
			log(`도구 실행 실패(${name}):`, e.message)
			this.audit.push({ ts: started, name, ms: Date.now() - started, ok: false, error: e.message })
			if (this.audit.length > 200) this.audit.shift()
			return `오류: ${e.message}`
		}
	}
}
