// HA DevOps 관리: 자동화/스크립트 검증·Diff·Proposal 승인·자동/수동 롤백·규칙 승격·종합 건강 감사
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { P, newId, fmt, readJson, writeJson } from '../util.mjs'
import { ADMIN_SERVICES, NON_ENTITY_TARGET_KEYS, PolicyEngine } from '../core/policy.mjs'
import { mergeConfig, validateConfig } from '../config.mjs'

const ENTITY_REF_RE = /^[a-z_]+\.[a-z0-9_]+$/
const JINJA_ENTITY_RE = /(?:states|is_state|state_attr|is_state_attr|has_value)\(\s*['"]([a-z_]+\.[a-z0-9_]+)['"]/g
const TPL_RE = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/
const RUNTIME_TEMPLATE_VARS = new Set(['trigger', 'this', 'context', 'repeat', 'wait'])
const UNDEF_VAR_RE = /UndefinedError:\s*'([A-Za-z_][A-Za-z0-9_]*)' is undefined/
export const SELF_PROPOSAL_KINDS = new Set(['self_alias_proposal', 'self_noise_proposal', 'self_stt_tune', 'self_lesson_proposal'])
export const ROLLBACKABLE_KINDS = new Set(['automation_upsert', 'automation_delete', 'automation_toggle', 'script_upsert', 'script_delete', 'promote_rule', ...SELF_PROPOSAL_KINDS])
// [롤백]을 받을 수 있는 상태: 적용됨, 자동 롤백 실패, 적용 도중 중단(결과 불명)
export const ROLLBACK_FROM = new Set(['applied', 'rollback_failed', 'interrupted'])
export const PROMOTABLE_OPS = new Set(['eq', 'ne', 'in', 'not_in', 'gt', 'lt', 'unavailable'])
// 불변 코어 보호: 자가개선 제안은 보안·정책·네트워크 경계를 절대 건드릴 수 없다.
const IMMUTABLE_CORE_KEYS = new Set(['policy', 'tier3_blocked', 'admin_enabled', 'allowed_networks', 'oob', 'token_file', 'actions'])
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
	constructor({ cfg, ha, store = null, states = new Map(), meta = {}, memory = null, onRulePromoted = null, policy = null, configPath = P.config, onConfigUpdated = null, onProposalOutcome = null, onRollbackFailed = null } = {}) {
		this.cfg = cfg
		this.policy = policy ?? new PolicyEngine(cfg ?? {})
		this.ha = ha
		this.store = store
		this.states = states
		this.meta = meta
		this.memory = memory
		this.onRulePromoted = onRulePromoted
		this.configPath = configPath
		this.onConfigUpdated = onConfigUpdated
		this.onProposalOutcome = onProposalOutcome
		// 자동·수동 롤백이 실패했을 때(HA 설정이 어떤 상태인지 모름) 비상 알림을 보내는 데 쓴다.
		this.onRollbackFailed = onRollbackFailed
		this.memProposals = new Map()
		this._writeChain = Promise.resolve()
		this._opChain = Promise.resolve()
	}

	#readRawConfig() {
		const raw = readJson(this.configPath, null)
		return raw && typeof raw === 'object' ? raw : structuredClone(this.cfg ?? {})
	}

	// 불변 코어 가드: 자가 튜닝 payload에 보안/정책 키가 섞여 있으면 차단한다.
	#checkSelfProposalImmutable(payload) {
		const keys = Object.keys(payload ?? {})
		const bad = keys.find(k => IMMUTABLE_CORE_KEYS.has(k))
		if (bad) return `불변 코어 보호: 자가 튜닝 제안에서 ${bad} 영역은 수정할 수 없다`
		return null
	}

	#buildSelfConfigPatch(kind, targetId, payload, rawCfg) {
		const next = structuredClone(rawCfg)
		if (kind === 'self_alias_proposal') {
			const entityId = String(payload?.entity_id || targetId || '').trim()
			const alias = String(payload?.alias || '').trim()
			if (!ENTITY_REF_RE.test(entityId) || alias.length < 2 || alias.length > 30) {
				return { error: 'self_alias_proposal에는 유효한 entity_id와 2~30자 alias가 필요하다' }
			}
			if (this.policy.isTier3Blocked(entityId)) return { error: `안전 정책(Tier 3)으로 차단된 엔티티 별칭은 추가할 수 없다: ${entityId}` }
			next.assist ??= {}
			next.assist.aliases ??= {}
			const cur = Array.isArray(next.assist.aliases[entityId]) ? [...next.assist.aliases[entityId]] : []
			if (!cur.includes(alias)) cur.push(alias)
			next.assist.aliases[entityId] = cur
			if (payload?.add_stt_hint !== false) {
				next.assist.voice ??= {}
				const hints = Array.isArray(next.assist.voice.stt_hints) ? [...next.assist.voice.stt_hints] : []
				if (!hints.includes(alias)) hints.push(alias)
				next.assist.voice.stt_hints = hints
			}
			return {
				next,
				beforeSlice: { aliases: rawCfg.assist?.aliases?.[entityId] ?? [], stt_hints: rawCfg.assist?.voice?.stt_hints ?? [] },
				afterSlice: { aliases: next.assist.aliases[entityId], stt_hints: next.assist.voice?.stt_hints ?? [] },
				summaryText: `별칭 추가: ${entityId} ← "${alias}"`,
			}
		}
		if (kind === 'self_noise_proposal') {
			const pat = String(payload?.entity_id || payload?.pattern || targetId || '').trim()
			if (!pat || !/^[a-z_]+\.[a-z0-9_*]+$/.test(pat)) return { error: `유효하지 않은 noise_entities 패턴: ${pat}` }
			if (this.policy.isTier3Blocked(pat.replace(/\*/g, 'x')) || pat.startsWith('person.')) {
				return { error: `보안·재실 핵심 엔티티(${pat})는 소음 목록에 넣을 수 없다` }
			}
			const list = Array.isArray(next.noise_entities) ? [...next.noise_entities] : []
			if (!list.includes(pat)) list.push(pat)
			next.noise_entities = list
			return {
				next,
				beforeSlice: { noise_entities: rawCfg.noise_entities ?? [] },
				afterSlice: { noise_entities: next.noise_entities },
				summaryText: `소음 엔티티 추가: ${pat}`,
			}
		}
		if (kind === 'self_stt_tune') {
			const ep = payload?.endpoint
			if (!ep || typeof ep !== 'object' || Array.isArray(ep)) return { error: 'self_stt_tune에는 endpoint 객체가 필요하다' }
			const allowed = ['enabled', 'silence_ms', 'max_seconds', 'no_speech_seconds', 'start_margin_db', 'bg_margin_db', 'near_field_db', 'end_drop_db', 'preroll_ms']
			const cleanEp = { ...(rawCfg.assist?.voice?.endpoint ?? {}) }
			for (const [k, v] of Object.entries(ep)) {
				if (!allowed.includes(k)) return { error: `허용되지 않은 STT endpoint 키: ${k}` }
				if (k === 'silence_ms' && !(Number(v) >= 300 && Number(v) <= 2000)) return { error: 'silence_ms는 300~2000ms 범위여야 한다' }
				if (k === 'max_seconds' && !(Number(v) >= 4 && Number(v) <= 20)) return { error: 'max_seconds는 4~20초 범위여야 한다' }
				if (k === 'no_speech_seconds' && !(Number(v) >= 2 && Number(v) <= 15)) return { error: 'no_speech_seconds는 2~15초 범위여야 한다' }
				cleanEp[k] = v
			}
			next.assist ??= {}
			next.assist.voice ??= {}
			next.assist.voice.endpoint = cleanEp
			return {
				next,
				beforeSlice: { endpoint: rawCfg.assist?.voice?.endpoint ?? {} },
				afterSlice: { endpoint: cleanEp },
				summaryText: `STT endpoint 조정: ${JSON.stringify(cleanEp)}`,
			}
		}
		return { error: `지원하지 않는 자가 설정 제안: ${kind}` }
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

	// 지금 상태에서 [롤백]을 누를 수 있는지(적용됨·롤백 실패·적용 중단).
	canRollback(p) {
		return this.isRollbackable(p) && ROLLBACK_FROM.has(p?.status)
	}

	// 제안 상태를 from일 때만 to로 바꾼다. 다른 쪽(알림 버튼·콘솔·CLI·만료)이 먼저 처리했으면 null.
	#transition(pid, from, to, { decidedAt = null, error } = {}) {
		if (this.store) return this.store.transitionProposal(pid, from, to, { decidedAt, error })
		const p = this.memProposals.get(pid)
		if (!p || p.status !== from) return null
		const next = { ...p, status: to, decided_at: decidedAt ?? p.decided_at ?? null, ...(error !== undefined ? { error } : {}) }
		this.memProposals.set(pid, next)
		return next
	}

	expireProposals(now = Date.now()) {
		if (this.store) return [...this.store.expirePendingProposals(now), ...this.store.recoverStuckProposals(now)]
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
		} else if (kind === 'self_lesson_proposal') {
			const guardErr = this.#checkSelfProposalImmutable(finalPayload)
			if (guardErr) return { ok: false, error: guardErr }
			const key = String(finalPayload.key || target_id || '').trim().slice(0, 80)
			const cond = String(finalPayload.condition_text || '').trim().slice(0, 200)
			const rule = String(finalPayload.rule_text || '').trim().slice(0, 300)
			const scope = ['all', 'assist', 'cycle', 'weekly', 'proposal'].includes(finalPayload.scope) ? finalPayload.scope : 'all'
			if (!key || !cond || !rule) return { ok: false, error: 'self_lesson_proposal에는 key, condition_text, rule_text가 필요하다' }
			finalPayload = { key, scope, condition_text: cond, rule_text: rule, evidence: finalPayload.evidence ?? null, evidence_count: Number(finalPayload.evidence_count) || 1, pinned: Boolean(finalPayload.pinned) }
			preSnapshot = this.store ? this.store.getLesson(key) : null
			validation = { valid: true, errors: [], warnings: [], summary_text: `교훈(${scope}): [${cond}] → ${rule}` }
			diffText = unifiedDiff(preSnapshot ? JSON.stringify(preSnapshot, null, 2) : '', JSON.stringify(finalPayload, null, 2), `lesson:${key}`)
		} else if (SELF_PROPOSAL_KINDS.has(kind)) {
			const guardErr = this.#checkSelfProposalImmutable(finalPayload)
			if (guardErr) return { ok: false, error: guardErr }
			const rawCfg = this.#readRawConfig()
			const built = this.#buildSelfConfigPatch(kind, target_id, finalPayload, rawCfg)
			if (built.error) return { ok: false, error: built.error }
			const cfgChk = validateConfig(mergeConfig(built.next))
			if (cfgChk.errors.length) return { ok: false, error: `설정 사전 검증 실패: ${cfgChk.errors.join(', ')}` }
			preSnapshot = built.beforeSlice
			validation = { valid: true, errors: [], warnings: cfgChk.warnings, summary_text: built.summaryText }
			diffText = unifiedDiff(JSON.stringify(built.beforeSlice, null, 2), JSON.stringify(built.afterSlice, null, 2), `config.json (${kind})`)
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
			this.#transition(pid, 'pending', 'expired', { decidedAt: now })
			return { ok: false, error: '제안 승인 기한이 지남' }
		}
		if (p.validation && p.validation.valid === false) {
			return { ok: false, error: `사전 검증 실패: ${(p.validation.errors ?? []).join(', ')}` }
		}
		// 먼저 'applying'으로 선점한다. 그사이 거절·만료·다른 승인이 끼어들면 적용하지 않는다(알림 버튼·콘솔·CLI가 동시에 눌려도 한 번만).
		if (!this.#transition(pid, 'pending', 'applying', { decidedAt: now })) {
			return { ok: false, error: `이미 처리 중이거나 처리된 제안 (${this.getProposal(pid)?.status ?? '없음'})` }
		}
		try {
			return await this.#applyClaimed(p, now)
		} catch (e) {
			// 예상 못 한 오류로 'applying'에 멈춰 있지 않게 한다.
			const failed = { ...p, status: 'error', decided_at: now, error: `적용 중 오류: ${e.message}` }
			this.#saveProposal(failed)
			return { ok: false, error: failed.error, proposal: failed }
		}
	}

	// 'applying'으로 선점한 제안을 적용한다. p는 선점 전(pending) 내용이다.
	async #applyClaimed(p, now) {
		const pid = p.pid
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
				this.#saveProposal(p) // 다시 승인할 수 있게 pending으로 되돌린다
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
			} else if (p.kind === 'self_lesson_proposal') {
				if (!this.store) throw new Error('저장소가 없어 교훈을 등록할 수 없다')
				this.store.upsertLesson({ ...p.payload, source: 'user_approved', now })
			} else if (SELF_PROPOSAL_KINDS.has(p.kind)) {
				const rawCfg = this.#readRawConfig()
				const built = this.#buildSelfConfigPatch(p.kind, p.target_id, p.payload, rawCfg)
				if (built.error) throw new Error(built.error)
				const merged = mergeConfig(built.next)
				const chk = validateConfig(merged)
				if (chk.errors.length) throw new Error(`설정 검증 실패: ${chk.errors.join(', ')}`)
				writeJson(this.configPath, built.next)
				this.cfg = merged
				await this.onConfigUpdated?.(merged, p)
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
			try { this.onProposalOutcome?.(updated, 'applied', now) } catch {}
			return { ok: true, proposal: updated }
		} catch (e) {
			if (mutatedConfig) {
				let rbErr = null
				try { await this.#restoreSnapshot(p) } catch (re) { rbErr = re }
				if (rbErr) {
					// 되돌리기도 실패: HA에 새(깨졌을 수 있는) 설정이 남아 있을 수 있다. 롤백됐다고 기록하지 않는다.
					const stuck = { ...p, status: 'rollback_failed', decided_at: now, error: `적용 실패(${e.message}) 뒤 자동 롤백도 실패(${rbErr.message}). HA에서 이 설정을 직접 확인하고 [롤백]을 다시 시도하세요.` }
					this.#saveProposal(stuck)
					this.#notifyRollbackFailed(stuck)
					return { ok: false, error: stuck.error, proposal: stuck }
				}
				const rolled = { ...p, status: 'rolled_back', decided_at: now, rollback_at: Date.now(), error: `적용 실패로 자동 롤백: ${e.message}` }
				this.#saveProposal(rolled)
				try { this.onProposalOutcome?.(rolled, 'rolled_back', now, e.message) } catch {}
				return { ok: false, error: rolled.error, proposal: rolled }
			}
			const failed = { ...p, status: 'error', decided_at: now, error: e.message }
			this.#saveProposal(failed)
			return { ok: false, error: e.message, proposal: failed }
		}
	}

	async #restoreSnapshot(p) {
		if (p.kind === 'self_lesson_proposal') {
			if (!this.store) return
			if (p.pre_snapshot) this.store.upsertLesson({ ...p.pre_snapshot, now: Date.now() })
			else this.store.deleteLesson(p.payload?.key || p.target_id, { source: 'user', force: true })
			return
		}
		if (SELF_PROPOSAL_KINDS.has(p.kind)) {
			const rawCfg = this.#readRawConfig()
			const next = structuredClone(rawCfg)
			if (p.kind === 'self_alias_proposal') {
				const eid = p.payload?.entity_id || p.target_id
				next.assist ??= {}
				next.assist.aliases ??= {}
				if (p.pre_snapshot?.aliases?.length) next.assist.aliases[eid] = p.pre_snapshot.aliases
				else delete next.assist.aliases[eid]
				if (Array.isArray(p.pre_snapshot?.stt_hints)) {
					next.assist.voice ??= {}
					next.assist.voice.stt_hints = p.pre_snapshot.stt_hints
				}
			} else if (p.kind === 'self_noise_proposal') {
				next.noise_entities = Array.isArray(p.pre_snapshot?.noise_entities) ? p.pre_snapshot.noise_entities : []
			} else if (p.kind === 'self_stt_tune') {
				next.assist ??= {}
				next.assist.voice ??= {}
				next.assist.voice.endpoint = p.pre_snapshot?.endpoint ?? {}
			}
			writeJson(this.configPath, next)
			const merged = mergeConfig(next)
			this.cfg = merged
			await this.onConfigUpdated?.(merged, p)
			return
		}
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
		if (!ROLLBACK_FROM.has(p.status)) return { ok: false, error: `적용된 제안만 롤백 가능 (${p.status})` }
		try {
			await this.#restoreSnapshot(p)
			if (!SELF_PROPOSAL_KINDS.has(p.kind) && typeof this.ha?.checkConfig === 'function') await this.ha.checkConfig()
			const updated = { ...p, status: 'rolled_back', rollback_at: now }
			this.#saveProposal(updated)
			try { this.onProposalOutcome?.(updated, 'rolled_back', now) } catch {}
			return { ok: true, proposal: updated }
		} catch (e) {
			// 일부만 되돌려졌을 수 있다. 상태를 남겨 콘솔·알림에서 다시 [롤백]할 수 있게 한다.
			const stuck = { ...p, status: 'rollback_failed', error: `롤백 실패: ${e.message}. HA에서 이 설정을 직접 확인하고 다시 시도하세요.` }
			this.#saveProposal(stuck)
			this.#notifyRollbackFailed(stuck)
			return { ok: false, error: `롤백 실패: ${e.message}`, proposal: stuck }
		}
	}

	#notifyRollbackFailed(p) {
		try { this.onProposalOutcome?.(p, 'rollback_failed', Date.now(), p.error) } catch {}
		try { this.onRollbackFailed?.(p) } catch {}
	}

	rejectProposal(pid, now = Date.now(), reason = '') {
		const p = this.getProposal(pid)
		if (!p) return { ok: false, error: `제안을 찾지 못함: ${pid}` }
		if (p.status !== 'pending') return { ok: false, error: `이미 처리된 제안 (${p.status})` }
		// 승인이 'applying'으로 먼저 선점했거나 만료됐으면 거절하지 않는다(거절 기억이 적용된 제안에 남지 않게).
		const updated = this.#transition(pid, 'pending', 'rejected', { decidedAt: now, ...(reason ? { error: reason } : {}) })
		if (!updated) return { ok: false, error: `이미 처리 중이거나 처리된 제안 (${this.getProposal(pid)?.status ?? '없음'})` }
		if (this.memory) {
			this.memory.applyOps([{ op: 'upsert', category: 'rejection', key: `rej_${p.kind}_${p.target_id || pid}`, content: `사용자가 거절한 제안: ${p.title}${reason ? ` (${reason})` : ''}` }], { source: 'user_rejection', now })
		}
		try { this.onProposalOutcome?.(updated, 'rejected', now, reason) } catch {}
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
