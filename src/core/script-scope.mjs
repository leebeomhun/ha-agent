// 스크립트가 HA 안에서 최종적으로 움직이는 기기 분석.
// 직접 실행 경로는 필드 이름·필수 입력만 검사했다. 서비스명·대상이 템플릿이면 무엇을 움직일지 그 검사로는 알 수 없어서
// 스크립트 설정을 읽을 때 동작마다 "미리 알 수 있는 기기"와 "실행 때 정해지는 동작"을 나눠 둔다(정책 검사는 core/policy.mjs).
import { collectConfigCalls } from '../admin/ha-admin.mjs'
import { entityTokens } from './policy.mjs'

// 기기를 움직이지 않는 동작(기록·표시용 헬퍼, 알림). 범위 검사에서 뺀다.
const BOOKKEEPING_DOMAINS = new Set(['input_datetime', 'input_text', 'timer', 'counter', 'logbook', 'notify', 'persistent_notification', 'system_log'])
const hasTemplate = s => typeof s === 'string' && /\{\{|\{%/.test(s)
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/

function analyzeCalls(calls, { autoCfg, depth, out }) {
	for (const c of calls) {
		if (c.kind === 'device') { out.dynamic.push({ service: `${c.domain}.${c.type}`, reason: '기기 동작(device_id)' }); continue }
		const svc = String(c.service ?? '')
		const m = /^([a-z_]+)\.(.*)$/.exec(svc)
		if (!m) { out.dynamic.push({ service: svc.slice(0, 80), reason: '서비스 이름이 템플릿' }); continue }
		const [, domain, name] = m
		if (BOOKKEEPING_DOMAINS.has(domain) || svc === 'homeassistant.update_entity') continue
		const ids = c.entity_ids ?? []
		// 다른 자동화를 실행하면 그 자동화의 동작을 한 단계 더 따라간다.
		if (svc === 'automation.trigger') {
			for (const aid of ids) {
				const ac = typeof aid === 'string' && ENTITY_RE.test(aid) ? autoCfg?.[aid] : null
				if (!ac || depth >= 2) { out.dynamic.push({ service: svc, reason: `다른 자동화 실행(${String(aid).slice(0, 60)})` }); continue }
				out.via.push(aid)
				analyzeCalls(collectConfigCalls('automation_upsert', ac), { autoCfg, depth: depth + 1, out })
			}
			continue
		}
		// 다른 스크립트를 부르면 그 스크립트가 무엇을 움직일지는 넘기는 값에 달렸다. 넘기는 값에 적힌 기기를 후보로 남긴다.
		if (domain === 'script' && !hasTemplate(name)) {
			const targets = name === 'turn_on' ? ids : [`script.${name}`]
			out.dynamic.push({ service: svc, reason: `다른 스크립트 실행(${targets.join(', ').slice(0, 60)})` })
			for (const e of entityTokens(c.data ?? {})) out.candidates.push(e)
			continue
		}
		if (c.non_entity_targets?.length) { out.dynamic.push({ service: svc, reason: `방·기기 단위 대상(${c.non_entity_targets.join(', ')})` }); continue }
		const tplIds = ids.filter(id => typeof id !== 'string' || hasTemplate(id) || id === 'all' || !ENTITY_RE.test(id))
		if (tplIds.length) { out.dynamic.push({ service: svc, reason: '대상이 템플릿' }); continue }
		if (!ids.length) { out.dynamic.push({ service: svc, reason: '대상 없음(서비스 기본 대상)' }); continue }
		// 서비스 이름만 템플릿(예: switch.turn_{{ ... }})이고 대상이 고정이면 움직이는 기기는 안다.
		for (const id of ids) out.devices.push({ entity_id: id, service: svc, service_template: hasTemplate(name) })
	}
}

// cfg: HA script/config 결과의 config. autoCfg: { 'automation.x': 설정 } (automation.trigger를 따라갈 때 쓴다)
export function analyzeScriptScope(cfg, { autoCfg = {} } = {}) {
	const out = { devices: [], dynamic: [], candidates: [], via: [] }
	if (!cfg || typeof cfg !== 'object') return out
	analyzeCalls(collectConfigCalls('script_upsert', cfg), { autoCfg, depth: 0, out })
	const seen = new Set()
	out.devices = out.devices.filter(d => { const k = `${d.entity_id}|${d.service}`; if (seen.has(k)) return false; seen.add(k); return true })
	out.candidates = [...new Set(out.candidates)]
	return out
}

// 기기 목록(판단 입력)에 보여 줄 한 줄 요약
export function scriptScopeText(scope) {
	if (!scope) return '움직이는 기기 확인 전'
	const devs = [...new Set((scope.devices ?? []).map(d => d.entity_id))]
	const parts = []
	if (devs.length) parts.push(`움직이는 기기: ${devs.slice(0, 6).join(', ')}${devs.length > 6 ? ` 외 ${devs.length - 6}개` : ''}`)
	if (scope.dynamic?.length) parts.push(`실행 때 정해지는 동작 ${scope.dynamic.length}개${scope.candidates?.length ? `(후보: ${scope.candidates.slice(0, 6).join(', ')})` : ''}`)
	return parts.join(' / ') || '기기를 움직이지 않음'
}
