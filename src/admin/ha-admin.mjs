// HA DevOps 관리: 자동화/스크립트 검증·Diff·Proposal 승인·자동/수동 롤백·규칙 승격·종합 건강 감사
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { P, newId, fmt } from '../util.mjs'
import { ADMIN_SERVICES, NON_ENTITY_TARGET_KEYS, PolicyEngine } from '../core/policy.mjs'

const ENTITY_REF_RE = /^[a-z_]+\.[a-z0-9_]+$/
const JINJA_ENTITY_RE = /(?:states|is_state|state_attr|is_state_attr|has_value)\(\s*['"]([a-z_]+\.[a-z0-9_]+)['"]/g
const TPL_RE = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/
const RUNTIME_TEMPLATE_VARS = new Set(['trigger', 'this', 'context', 'repeat', 'wait'])
const UNDEF_VAR_RE = /UndefinedError:\s*'([A-Za-z_][A-Za-z0-9_]*)' is undefined/
export const ROLLBACKABLE_KINDS = new Set(['automation_upsert', 'automation_delete', 'automation_toggle', 'script_upsert', 'script_delete', 'promote_rule'])
export const PROMOTABLE_OPS = new Set(['eq', 'ne', 'in', 'not_in', 'gt', 'lt', 'unavailable'])
const splitVals = v => String(v ?? '').split('|').map(s => s.trim()).filter(Boolean)
const sanitizeConfigId = raw => String(raw ?? '').replace(/\.\./g, '_').replace(/[/?#]/g, '_').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
const jinjaExprFor = (entityId, attr) => (attr ? `state_attr('${entityId}', '${attr}')` : `states('${entityId}')`)
const jinjaAliveExpr = entityId => `states('${entityId}') not in ['unavailable', 'unknown']`

export function unifiedDiff(beforeText = '', afterText = '', label = 'config') {
	const a = String(beforeText ?? '').split('\n')
	const b = String(afterText ?? '').split('\n')
	if (beforeText === afterText) return '(변경 없음)'
	const n = a.length, m = b.length
	if (n * m > 200000) {
		return [`--- ${label} (이전)`, `+++ ${label} (이후)`, ...a.slice(0, 30).map(l => `- ${l}`), '...', ...b.slice(0, 30).map(l => `+ ${l}`)].join('\n')
	}
	const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1])
		}
	}
	const out = [`--- ${label} (이전)`, `+++ ${label} (이후)`]
	let i = 0, j = 0
	while (i < n && j < m) {
		if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++ }
		else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`- ${a[i++]}`) }
		else { out.push(`+ ${b[j++]}`) }
	}
	while (i < n) out.push(`- ${a[i++]}`)
	while (j < m) out.push(`+ ${b[j++]}`)
	return out.slice(0, 140).join('\n') + (out.length > 140 ? `\n… (총 ${out.length}줄 중 140줄까지)` : '')
}

export function extractEntityRefs(obj, out = new Set()) {
	if (!obj) return out
	if (typeof obj === 'string') {
		for (const m of obj.matchAll(JINJA_ENTITY_RE)) out.add(m[1])
		return out
	}
	if (Array.isArray(obj)) {
		for (const x of obj) extractEntityRefs(x, out)
		return out
	}
	if (typeof obj === 'object') {
		for (const [k, v] of Object.entries(obj)) {
			if (k === 'entity_id' || k === 'entity') {
				for (const item of [].concat(v ?? [])) {
					if (typeof item === 'string' && ENTITY_REF_RE.test(item)) out.add(item)
				}
			}
			extractEntityRefs(v, out)
		}
	}
	return out
}

export function extractTemplates(obj, out = []) {
	if (!obj) return out
	if (typeof obj === 'string') {
		if (TPL_RE.test(obj)) out.push(obj)
		return out
	}
	if (Array.isArray(obj)) { for (const x of obj) extractTemplates(x, out); return out }
	if (typeof obj === 'object') { for (const v of Object.values(obj)) extractTemplates(v, out) }
	return out
}

export function extractDeclaredVars(obj, out = new Set(), parentKey = '') {
	if (!obj || typeof obj !== 'object') return out
	if (Array.isArray(obj)) {
		for (const x of obj) extractDeclaredVars(x, out, parentKey)
		return out
	}
	for (const [k, v] of Object.entries(obj)) {
		if ((k === 'variables' || k === 'trigger_variables' || k === 'fields')
			&& parentKey !== 'data' && parentKey !== 'service_data'
			&& v && typeof v === 'object' && !Array.isArray(v)) {
			for (const name of Object.keys(v)) out.add(name)
		} else if (k === 'response_variable' && typeof v === 'string' && v.trim()) {
			out.add(v.trim())
		}
		extractDeclaredVars(v, out, k)
	}
	return out
}

// 자동화·스크립트 설정에서 "실행되는 것"(서비스 호출·기기 동작)만 모은다. 트리거·조건은 상태를 읽을 뿐이라 건너뛴다.
// 서비스 호출의 data·target 안(알림 버튼의 action 등)은 동작이 아니므로 들어가지 않는다.
const ACTION_SKIP_KEYS = new Set(['conditions', 'condition', 'if', 'while', 'until', 'triggers', 'trigger', 'wait_for_trigger', 'data', 'data_template', 'target', 'variables', 'event_data', 'metadata', 'response_variable'])
const toIds = v => (v == null ? [] : Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : [v])
export function collectConfigCalls(kind, config) {
	const out = []
	const walk = node => {
		if (Array.isArray(node)) { for (const x of node) walk(x); return }
		if (!node || typeof node !== 'object') return
		const svc = typeof node.action === 'string' ? node.action : typeof node.service === 'string' ? node.service : null
		if (svc) {
			const t = node.target && typeof node.target === 'object' ? node.target : {}
			const data = node.data ?? node.data_template
			out.push({
				kind: 'service', service: svc.trim(),
				entity_ids: [...toIds(t.entity_id), ...toIds(node.entity_id), ...toIds(data && typeof data === 'object' ? data.entity_id : null)],
				non_entity_targets: NON_ENTITY_TARGET_KEYS.filter(k => t[k] != null),
			})
		} else if (typeof node.scene === 'string') {
			out.push({ kind: 'service', service: 'scene.turn_on', entity_ids: [node.scene], non_entity_targets: [] })
		} else if (node.device_id && typeof node.domain === 'string' && node.type && !('condition' in node) && !('trigger' in node) && !('platform' in node)) {
			out.push({ kind: 'device', domain: node.domain, type: String(node.type), device_id: node.device_id })
		}
		for (const [k, v] of Object.entries(node)) if (!ACTION_SKIP_KEYS.has(k) && v && typeof v === 'object') walk(v)
	}
	if (!config || typeof config !== 'object') return out
	walk(String(kind).startsWith('script') ? config.sequence : (config.actions ?? config.action))
	return out
}

// 승인 알림에 보여 줄 짧은 요약: 무엇이 언제 무엇을 하는가
export function summarizeConfig(config, calls) {
	const trig = [].concat(config?.triggers ?? config?.trigger ?? []).filter(t => t && typeof t === 'object').slice(0, 3)
		.map(t => `${t.trigger ?? t.platform ?? '?'}${t.entity_id ? ` ${[].concat(t.entity_id).join(',')}` : ''}${t.at ? ` ${[].concat(t.at).join(',')}` : ''}`)
	const acts = [...new Set(calls.map(c => (c.kind === 'device'
		? `${c.domain}.${c.type}(기기)`
		: `${c.service}${c.entity_ids?.length ? ` → ${c.entity_ids.join(',')}` : c.non_entity_targets?.length ? ` → ${c.non_entity_targets.join(',')}` : ''}`)))]
	return [
		trig.length ? `트리거: ${trig.join(' / ')}` : '',
		acts.length ? `동작: ${acts.slice(0, 6).join(' / ')}${acts.length > 6 ? ` 외 ${acts.length - 6}개` : ''}` : '동작: 없음',
	].filter(Boolean).join('\n')
}

// 키 순서와 상관없이 같은 설정인지 비교하려고 정규화한다.
export function canonicalJson(v) {
	if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
	if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
	return JSON.stringify(v ?? null)
}

export function ruleToAutomationConfig(rule, notifyTargets = ['mobile_app_ibeomhun']) {
	if (!PROMOTABLE_OPS.has(rule?.op)) {
		throw new Error(`${rule?.op ?? '알 수 없음'} 연산자는 HA 자동화 직접 승격을 지원하지 않음`)
	}
	for (const c of rule.also ?? []) {
		if (!PROMOTABLE_OPS.has(c?.op)) {
			throw new Error(`also 조건의 ${c?.op ?? '알 수 없음'} 연산자는 HA 자동화 직접 승격을 지원하지 않음`)
		}
	}
	const trigger = (() => {
		const dur = rule.for_minutes > 0 ? { for: { minutes: rule.for_minutes } } : {}
		if (rule.op === 'gt' || rule.op === 'lt') {
			return {
				trigger: 'numeric_state',
				entity_id: rule.entity_id,
				...(rule.attribute ? { attribute: rule.attribute } : {}),
				...(rule.op === 'gt' ? { above: Number(rule.value) } : { below: Number(rule.value) }),
				...dur,
			}
		}
		if (rule.op === 'ne' || rule.op === 'not_in') {
			const expr = jinjaExprFor(rule.entity_id, rule.attribute)
			const cmp = rule.op === 'ne'
				? `(${expr} | string) != ${JSON.stringify(String(rule.value ?? ''))}`
				: `(${expr} | string) not in ${JSON.stringify(splitVals(rule.value))}`
			return {
				trigger: 'template',
				value_template: `{{ ${jinjaAliveExpr(rule.entity_id)} and ${cmp} }}`,
				...dur,
			}
		}
		const base = { trigger: 'state', entity_id: rule.entity_id }
		if (rule.attribute) base.attribute = rule.attribute
		if (rule.op === 'eq' && rule.value != null) base.to = String(rule.value)
		else if (rule.op === 'in') base.to = splitVals(rule.value)
		else if (rule.op === 'unavailable') base.to = ['unavailable', 'unknown']
		return { ...base, ...dur }
	})()
	const conditions = (rule.also ?? []).map(c => {
		if (c.op === 'gt' || c.op === 'lt') {
			return {
				condition: 'numeric_state',
				entity_id: c.entity_id,
				...(c.attribute ? { attribute: c.attribute } : {}),
				...(c.op === 'gt' ? { above: Number(c.value) } : { below: Number(c.value) }),
			}
		}
		if (c.op === 'ne' || c.op === 'not_in') {
			const expr = jinjaExprFor(c.entity_id, c.attribute)
			const cmp = c.op === 'ne'
				? `(${expr} | string) != ${JSON.stringify(String(c.value ?? ''))}`
				: `(${expr} | string) not in ${JSON.stringify(splitVals(c.value))}`
			return {
				condition: 'template',
				value_template: `{{ ${jinjaAliveExpr(c.entity_id)} and ${cmp} }}`,
			}
		}
		return {
			condition: 'state',
			entity_id: c.entity_id,
			...(c.attribute ? { attribute: c.attribute } : {}),
			state: c.op === 'unavailable' ? ['unavailable', 'unknown'] : c.op === 'in' ? splitVals(c.value) : String(c.value ?? ''),
		}
	})
	if (rule.hour_from != null && rule.hour_to != null) {
		conditions.push({
			condition: 'time',
			after: `${String(rule.hour_from).padStart(2, '0')}:00:00`,
			before: `${String(rule.hour_to % 24).padStart(2, '0')}:00:00`,
		})
	}
	const target = notifyTargets[0] ?? 'mobile_app_ibeomhun'
	return {
		alias: `집 비서 승격: ${rule.description.slice(0, 50)}`,
		description: `ha-agent 규칙(${rule.id})에서 승격됨`,
		mode: 'single',
		triggers: [trigger],
		conditions,
		actions: [{
			action: `notify.${target}`,
			data: { title: `⚠️ ${rule.description}`, message: `{{ states('${rule.entity_id}') }} 상태로 감지되었어요.` },
		}],
	}
}

export class HaAdmin {
	constructor({ cfg, ha, store = null, states = new Map(), meta = {}, memory = null, onRulePromoted = null, policy = null } = {}) {
		this.cfg = cfg
		this.policy = policy ?? new PolicyEngine(cfg ?? {})
		this.ha = ha
		this.store = store
		this.states = states
		this.meta = meta
		this.memory = memory
		this.onRulePromoted = onRulePromoted
		this.memProposals = new Map()
		this._writeChain = Promise.resolve()
		this._opChain = Promise.resolve()
	}

	#saveSnapFile(pid, label, data) {
		try {
			mkdirSync(P.haSnapshots, { recursive: true })
			writeFileSync(join(P.haSnapshots, `${pid}-${label}.json`), JSON.stringify(data, null, 1))
		} catch {}
	}

	async validateHaConfig(kind, config) {
		const errors = [], warnings = []
		if (!config || typeof config !== 'object' || Array.isArray(config)) {
			return { valid: false, errors: ['설정이 객체가 아님'], warnings, missing_entities: [] }
		}
		if (kind.startsWith('automation')) {
			if (!config.alias) errors.push('alias 필수')
			if (!config.triggers && !config.trigger) errors.push('triggers 필수')
			if (!config.actions && !config.action) errors.push('actions 필수')
		} else if (kind.startsWith('script')) {
			if (!config.sequence && !config.alias) errors.push('alias 또는 sequence 필수')
		}
		const refs = [...extractEntityRefs(config)]
		const missing = this.states.size ? refs.filter(id => !this.states.has(id)) : []
		if (missing.length) errors.push(`존재하지 않는 엔티티 참조: ${missing.join(', ')}`)
		// 승인 뒤에는 HA 안에서 돌기 때문에 Tier 3 차단을 여기서 미리 건다.
		const calls = collectConfigCalls(kind, config)
		errors.push(...this.policy.checkConfigCalls(calls))
		const summaryText = summarizeConfig(config, calls)
		const templates = [...new Set(extractTemplates(config))]
		const allowedRuntimeVars = new Set([...RUNTIME_TEMPLATE_VARS, ...extractDeclaredVars(config)])
		const skippedVars = new Set()
		let skippedCount = 0
		if (templates.length && typeof this.ha?.renderTemplate === 'function' && this.ha?.connected) {
			for (const tpl of templates.slice(0, 50)) {
				try {
					await this.ha.renderTemplate(tpl)
				} catch (e) {
					const m = UNDEF_VAR_RE.exec(String(e?.message ?? ''))
					if (m && allowedRuntimeVars.has(m[1])) {
						skippedVars.add(m[1])
						skippedCount++
					} else {
						errors.push(`템플릿 문법 오류(${tpl.slice(0, 40)}): ${e.message}`)
					}
				}
			}
		}
		if (skippedCount > 0) {
			warnings.push(`런타임 변수(${[...skippedVars].join(', ')}) 참조 템플릿 ${skippedCount}건은 문법 검사만 통과`)
		}
		return { valid: errors.length === 0, errors, warnings, missing_entities: missing, template_count: templates.length, summary_text: summaryText }
	}

	#resolveConfigId(kind, targetId, payload) {
		if (payload?.config_id) return sanitizeConfigId(payload.config_id)
		if (kind.startsWith('automation') || kind === 'promote_rule') {
			const auto = this.meta?.autoCfg?.[targetId]
			if (auto?.id != null) return sanitizeConfigId(auto.id)
			const stateId = this.states?.get(targetId)?.attributes?.id
			if (stateId != null) return sanitizeConfigId(stateId)
			const cfgId = payload?.config?.id ?? payload?.id
			if (cfgId != null) return sanitizeConfigId(cfgId)
			return sanitizeConfigId(targetId.replace(/^automation\./, ''))
		}
		return sanitizeConfigId(targetId.replace(/^script\./, ''))
	}

	// 지금 HA에 저장된 설정. 없으면 null, 확인할 수단이 없으면 undefined(시험용 가짜 HA 등). 그 밖의 오류는 던진다.
	async #currentConfig(domain, configId) {
		if (typeof this.ha?.getConfigRest !== 'function') return undefined
		try { return (await this.ha.getConfigRest(domain, configId)) ?? null } catch (e) {
			if (/(^|\D)404(\D|$)/.test(String(e?.message))) return null
			throw e
		}
	}

	// 제안할 때의 "이전 설정". 캐시(최대 6시간 묵음)가 아니라 HA에서 지금 값을 읽는다. 못 읽으면 캐시로 대신한다.
	async #snapshotFor(domain, configId, targetId) {
		try {
			const cur = await this.#currentConfig(domain, configId)
			if (cur !== undefined) return cur
		} catch {}
		return (domain === 'automation' ? this.meta?.autoCfg?.[targetId] : null) ?? null
	}

	isRollbackable(p) {
		return Boolean(p && ROLLBACKABLE_KINDS.has(p.kind))
	}

	expireProposals(now = Date.now()) {
		if (this.store) return this.store.expirePendingProposals(now)
		const expired = []
		for (const [pid, p] of this.memProposals) {
			if (p.status === 'pending' && p.expires && now > p.expires) {
				const next = { ...p, status: 'expired', decided_at: now }
				this.memProposals.set(pid, next)
				expired.push(next)
			}
		}
		return expired
	}

	async createProposal({ kind, target_id = '', title, summary, payload = null }, now = Date.now()) {
		const pid = `p${newId()}`
		let finalPayload = payload ? { ...payload } : {}
		let preSnapshot = null
		let diffText = ''
		let validation = { valid: true, errors: [], warnings: [] }

		if (kind === 'automation_upsert' || kind === 'script_upsert') {
			const domain = kind.startsWith('automation') ? 'automation' : 'script'
			const config = finalPayload.config ?? finalPayload
			const configId = this.#resolveConfigId(kind, target_id, finalPayload) || `haagent_${now}`
			finalPayload = { config_id: configId, config: domain === 'automation' ? { ...config, id: configId } : { ...config } }
			validation = await this.validateHaConfig(kind, finalPayload.config)
			if (!validation.valid) {
				return { ok: false, error: `사전 검증 실패: ${validation.errors.join(', ')}`, validation }
			}
			preSnapshot = await this.#snapshotFor(domain, configId, target_id)
			diffText = unifiedDiff(preSnapshot ? JSON.stringify(preSnapshot, null, 2) : '', JSON.stringify(finalPayload.config, null, 2), target_id || configId)
		} else if (kind === 'automation_delete' || kind === 'script_delete') {
			const domain = kind.startsWith('automation') ? 'automation' : 'script'
			const configId = this.#resolveConfigId(kind, target_id, finalPayload)
			finalPayload = { config_id: configId }
			preSnapshot = await this.#snapshotFor(domain, configId, target_id)
			if (preSnapshot) validation = { ...validation, summary_text: `삭제: ${preSnapshot.alias ?? target_id}` }
			diffText = unifiedDiff(preSnapshot ? JSON.stringify(preSnapshot, null, 2) : '(기존 설정 없음)', '', target_id)
		} else if (kind === 'automation_toggle') {
			if (!/^automation\.[a-z0-9_]+$/.test(String(target_id)) || (this.states.size && !this.states.has(target_id))) {
				return { ok: false, error: `automation_toggle 대상은 있는 automation 엔티티여야 한다: ${target_id}` }
			}
			const cur = this.states.get(target_id)?.state ?? 'unknown'
			preSnapshot = { state: cur }
			diffText = `${target_id}: ${cur} → ${finalPayload.state ?? (cur === 'on' ? 'off' : 'on')}`
		} else if (kind === 'promote_rule') {
			const rule = finalPayload.rule
			if (!rule) return { ok: false, error: 'promote_rule에는 rule 객체가 필요하다' }
			const configId = sanitizeConfigId(`haagent_${rule.id}`) || `haagent_${now}`
			let generated
			try {
				generated = finalPayload.config ?? { id: configId, ...ruleToAutomationConfig(rule, this.cfg?.notify_targets) }
			} catch (e) {
				return { ok: false, error: e.message }
			}
			const config = generated
			finalPayload = { config_id: configId, rule_id: rule.id, config }
			validation = await this.validateHaConfig('automation_upsert', config)
			if (!validation.valid) {
				return { ok: false, error: `사전 검증 실패: ${validation.errors.join(', ')}`, validation }
			}
			preSnapshot = await this.#snapshotFor('automation', configId, `automation.${configId}`)
			diffText = unifiedDiff(preSnapshot ? JSON.stringify(preSnapshot, null, 2) : '', JSON.stringify(config, null, 2), `automation.${configId}`)
		} else if (kind === 'entity_admin') {
			const svc = `homeassistant.${finalPayload.service}`
			if (!ADMIN_SERVICES.has(svc)) return { ok: false, error: `허용되지 않은 엔티티 관리 서비스: ${svc}` }
			if (!ENTITY_REF_RE.test(String(target_id))) return { ok: false, error: `entity_admin 대상은 entity_id여야 한다: ${target_id}` }
			if (this.policy.isTier3Blocked(target_id)) return { ok: false, error: `안전 정책(Tier 3)으로 차단된 대상: ${target_id}` }
			diffText = `${svc} target=${target_id} data=${JSON.stringify(finalPayload.data ?? {})}`
		} else {
			diffText = `${kind} ${target_id} ${JSON.stringify(finalPayload)}`
		}

		const expireHours = this.cfg?.policy?.proposal_expire_hours ?? 24
		const rec = {
			pid, ts: now, kind, title, summary, target_id,
			payload: finalPayload, diff_text: diffText, pre_snapshot: preSnapshot,
			validation, status: 'pending', expires: now + expireHours * 3600000,
		}
		if (this.store) this.store.upsertProposal(rec)
		else this.memProposals.set(pid, rec)
		return { ok: true, proposal: rec }
	}

	getProposal(pid) {
		return this.store ? this.store.getProposal(pid) : (this.memProposals.get(pid) ?? null)
	}

	listProposals(opts) {
		if (this.store) return this.store.listProposals(opts)
		const all = [...this.memProposals.values()].sort((a, b) => b.ts - a.ts)
		return opts?.status ? all.filter(p => p.status === opts.status) : all
	}

	#saveProposal(p) {
		if (this.store) this.store.upsertProposal(p)
		else this.memProposals.set(p.pid, p)
	}

	#serializeOp(fn) {
		const run = this._opChain.then(fn)
		this._opChain = run.catch(() => {})
		return run
	}

	async #withConfigWrite(fn) {
		const run = this._writeChain.then(async () => {
			const prev = this.ha.guard?.allowConfigWrite
			if (this.ha.guard) this.ha.guard.allowConfigWrite = true
			try { return await fn() } finally { if (this.ha.guard) this.ha.guard.allowConfigWrite = prev }
		})
		this._writeChain = run.catch(() => {})
		return run
	}

	approveProposal(pid, now = Date.now()) {
		return this.#serializeOp(() => this.#approveProposalUnlocked(pid, now))
	}

	async #approveProposalUnlocked(pid, now = Date.now()) {
		if (!this.cfg?.policy?.admin_enabled) return { ok: false, error: 'HA 관리 권한(policy.admin_enabled)이 꺼져 있다' }
		const p = this.getProposal(pid)
		if (!p) return { ok: false, error: `제안을 찾지 못함: ${pid}` }
		if (p.status !== 'pending') return { ok: false, error: `이미 처리된 제안 (${p.status})` }
		if (p.expires && now > p.expires) {
			this.#saveProposal({ ...p, status: 'expired', decided_at: now })
			return { ok: false, error: '제안 승인 기한이 지남' }
		}
		if (p.validation && p.validation.valid === false) {
			return { ok: false, error: `사전 검증 실패: ${(p.validation.errors ?? []).join(', ')}` }
		}
		const mutatedConfig = ['automation_upsert', 'automation_delete', 'script_upsert', 'script_delete', 'promote_rule'].includes(p.kind)
		// 예전 판이 만든 제안도 승인할 때 Tier 3 검사를 다시 거친다.
		if (['automation_upsert', 'script_upsert', 'promote_rule'].includes(p.kind)) {
			const errs = this.policy.checkConfigCalls(collectConfigCalls(p.kind === 'script_upsert' ? 'script_upsert' : 'automation_upsert', p.payload?.config))
			if (errs.length) {
				const blocked = { ...p, status: 'error', decided_at: now, error: `사전 검증 실패: ${errs.join(', ')}` }
				this.#saveProposal(blocked)
				return { ok: false, error: blocked.error, proposal: blocked }
			}
		}
		// 제안 뒤에 HA에서 같은 설정을 손댔으면(UI 수정 등) 덮어쓰지 않는다. 그 수정이 사라지고, 롤백도 옛 판으로 돌아가기 때문이다.
		if (mutatedConfig) {
			const domain = p.kind.startsWith('script') ? 'script' : 'automation'
			let cur
			try { cur = await this.#currentConfig(domain, p.payload?.config_id) } catch (e) {
				return { ok: false, error: `지금 HA 설정을 확인하지 못해 적용하지 않음(잠시 뒤 다시 승인): ${e.message}` }
			}
			if (cur !== undefined && canonicalJson(cur) !== canonicalJson(p.pre_snapshot ?? null)) {
				const stale = { ...p, status: 'error', decided_at: now, error: '제안을 만든 뒤 HA에서 이 설정이 바뀌어 적용하지 않았어요. 바뀐 내용을 기준으로 다시 제안해야 해요.' }
				this.#saveProposal(stale)
				return { ok: false, error: stale.error, proposal: stale }
			}
		}
		if (p.pre_snapshot) this.#saveSnapFile(pid, 'before', p.pre_snapshot)

		try {
			if (p.kind === 'automation_upsert' || p.kind === 'promote_rule') {
				await this.#withConfigWrite(() => this.ha.saveConfigRest('automation', p.payload.config_id, p.payload.config))
				await this.ha.callService('automation', 'reload')
			} else if (p.kind === 'automation_delete') {
				await this.#withConfigWrite(() => this.ha.deleteConfigRest('automation', p.payload.config_id))
				await this.ha.callService('automation', 'reload')
			} else if (p.kind === 'script_upsert') {
				await this.#withConfigWrite(() => this.ha.saveConfigRest('script', p.payload.config_id, p.payload.config))
				await this.ha.callService('script', 'reload')
			} else if (p.kind === 'script_delete') {
				await this.#withConfigWrite(() => this.ha.deleteConfigRest('script', p.payload.config_id))
				await this.ha.callService('script', 'reload')
			} else if (p.kind === 'automation_toggle') {
				const svc = p.payload?.state === 'off' ? 'turn_off' : 'turn_on'
				await this.ha.callService('automation', svc, { target: { entity_id: p.target_id } })
			} else if (p.kind === 'reload_config_entry') {
				await this.ha.callService('homeassistant', 'reload_config_entry', { data: { entry_id: p.target_id } })
			} else if (p.kind === 'backup_create') {
				await this.ha.callService('backup', 'create_automatic')
			} else if (p.kind === 'entity_admin') {
				await this.ha.callService('homeassistant', p.payload.service, { data: { entity_id: p.target_id, ...(p.payload.data ?? {}) } })
			} else {
				throw new Error(`알 수 없는 제안 종류: ${p.kind}`)
			}

			if (mutatedConfig && typeof this.ha.checkConfig === 'function') {
				const chk = await this.ha.checkConfig()
				if (chk && chk.result && chk.result !== 'valid') {
					throw new Error(`check_config 실패: ${JSON.stringify(chk.errors ?? chk.result)}`)
				}
			}
			const updated = { ...p, status: 'applied', decided_at: now, applied_at: now, error: null }
			this.#saveProposal(updated)
			if (p.kind === 'promote_rule' && this.onRulePromoted && p.payload?.rule_id) {
				await this.onRulePromoted(p.payload.rule_id)
			}
			return { ok: true, proposal: updated }
		} catch (e) {
			if (mutatedConfig) {
				try { await this.#restoreSnapshot(p) } catch {}
				const rolled = { ...p, status: 'rolled_back', decided_at: now, rollback_at: Date.now(), error: `적용 실패로 자동 롤백: ${e.message}` }
				this.#saveProposal(rolled)
				return { ok: false, error: rolled.error, proposal: rolled }
			}
			const failed = { ...p, status: 'error', decided_at: now, error: e.message }
			this.#saveProposal(failed)
			return { ok: false, error: e.message, proposal: failed }
		}
	}

	async #restoreSnapshot(p) {
		const domain = (p.kind.startsWith('script')) ? 'script' : 'automation'
		if (p.kind === 'automation_toggle') {
			const prev = p.pre_snapshot?.state
			if (prev === 'on' || prev === 'off') await this.ha.callService('automation', prev === 'on' ? 'turn_on' : 'turn_off', { target: { entity_id: p.target_id } })
			return
		}
		if (p.pre_snapshot) {
			await this.#withConfigWrite(() => this.ha.saveConfigRest(domain, p.payload.config_id, p.pre_snapshot))
		} else if (p.kind === 'automation_upsert' || p.kind === 'script_upsert' || p.kind === 'promote_rule') {
			await this.#withConfigWrite(() => this.ha.deleteConfigRest(domain, p.payload.config_id))
		}
		await this.ha.callService(domain, 'reload')
	}

	rollbackProposal(pid, now = Date.now()) {
		return this.#serializeOp(() => this.#rollbackProposalUnlocked(pid, now))
	}

	async #rollbackProposalUnlocked(pid, now = Date.now()) {
		const p = this.getProposal(pid)
		if (!p) return { ok: false, error: `제안을 찾지 못함: ${pid}` }
		if (!this.isRollbackable(p)) return { ok: false, error: `${p.kind} 제안은 롤백을 지원하지 않음` }
		if (p.status !== 'applied') return { ok: false, error: `적용된 제안만 롤백 가능 (${p.status})` }
		try {
			await this.#restoreSnapshot(p)
			if (typeof this.ha.checkConfig === 'function') await this.ha.checkConfig()
			const updated = { ...p, status: 'rolled_back', rollback_at: now }
			this.#saveProposal(updated)
			return { ok: true, proposal: updated }
		} catch (e) {
			return { ok: false, error: `롤백 실패: ${e.message}` }
		}
	}

	rejectProposal(pid, now = Date.now(), reason = '') {
		const p = this.getProposal(pid)
		if (!p) return { ok: false, error: `제안을 찾지 못함: ${pid}` }
		if (p.status !== 'pending') return { ok: false, error: `이미 처리된 제안 (${p.status})` }
		const updated = { ...p, status: 'rejected', decided_at: now, ...(reason ? { error: reason } : {}) }
		this.#saveProposal(updated)
		if (this.memory) {
			this.memory.applyOps([{ op: 'upsert', category: 'rejection', key: `rej_${p.kind}_${p.target_id || pid}`, content: `사용자가 거절한 제안: ${p.title}${reason ? ` (${reason})` : ''}` }], { source: 'user_rejection', now })
		}
		return { ok: true, proposal: updated }
	}

	async auditHealth() {
		const report = {
			at: fmt(Date.now()),
			broken_automation_refs: [],
			integration_errors: [],
			recent_trace_errors: [],
			pending_updates: [],
			backup_status: null,
			orphaned_entities: [],
		}
		for (const [autoId, cfg] of Object.entries(this.meta?.autoCfg ?? {})) {
			if (!cfg) continue
			const refs = [...extractEntityRefs(cfg)]
			const missing = this.states.size ? refs.filter(id => !this.states.has(id)) : []
			if (missing.length) report.broken_automation_refs.push({ automation_id: autoId, alias: cfg.alias, missing_entities: missing })
		}
		if (typeof this.ha?.configEntries === 'function' && this.ha?.connected) {
			try {
				const entries = await this.ha.configEntries()
				for (const e of entries ?? []) {
					if (['setup_error', 'setup_retry', 'failed_unload'].includes(e.state) || e.disabled_by) {
						if (!e.disabled_by) report.integration_errors.push({ entry_id: e.entry_id, domain: e.domain, title: e.title, state: e.state, reason: e.reason ?? null })
					}
				}
			} catch {}
		}
		if (typeof this.ha?.traces === 'function' && this.ha?.connected) {
			try {
				const traces = await this.ha.traces('automation')
				for (const t of (traces ?? []).slice(0, 200)) {
					if (t.error || (t.script_execution && !['finished', 'cancelled', 'aborted', 'failed_conditions'].includes(t.script_execution))) {
						report.recent_trace_errors.push({ item_id: t.item_id, run_id: t.run_id, last_step: t.last_step, execution: t.script_execution, error: t.error ?? null, start: t.timestamp?.start })
					}
				}
			} catch {}
		}
		for (const [id, st] of this.states) {
			if (id.startsWith('update.') && st.state === 'on') {
				report.pending_updates.push({ id, name: st.attributes?.friendly_name, installed: st.attributes?.installed_version, latest: st.attributes?.latest_version })
			}
		}
		if (typeof this.ha?.backupInfo === 'function' && this.ha?.connected) {
			try {
				const b = await this.ha.backupInfo()
				report.backup_status = { state: b?.state ?? null, last_completed: b?.last_completed_automatic_backup ?? null, count: (b?.backups ?? []).length }
			} catch {}
		}
		if (typeof this.ha?.callService === 'function' && this.ha?.connected) {
			try {
				const res = await this.ha.callService('homeassistant', 'list_orphaned_database_entities', { response: true })
				const list = res?.response?.entities ?? res?.entities ?? []
				if (Array.isArray(list)) report.orphaned_entities = list.slice(0, 50)
			} catch {}
		}
		return report
	}
}
