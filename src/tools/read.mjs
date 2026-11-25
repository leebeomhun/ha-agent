// Tool Broker 읽기 도구: HA 토큰·셸 노출 없이 메모리/캐시/라이브 HA 조회 제공
import { fmt, localTime, localizeDeep } from '../util.mjs'
import { weatherText, calendarText } from '../context.mjs'

const clip = (v, max = 14000) => {
	const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1)
	return s.length > max ? `${s.slice(0, max)}\n… (잘림: 전체 ${s.length}자)` : s
}
const round2 = v => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)

// HA 기록 원본(epoch 초·ms 시각, UTC ISO 상태값)을 KST 시각으로 바꾸고 줄인다. Assist 도구와 정각 점검 자료가 같이 쓴다.
export function digestHaData(kind, raw, now = Date.now()) {
	const out = {}
	if (kind === 'statistics') {
		for (const [id, rows] of Object.entries(raw ?? {})) {
			out[id] = rows.map(x => ({ t: fmt(x.start), mean: round2(x.mean) ?? undefined, min: round2(x.min) ?? undefined, max: round2(x.max) ?? undefined, state: round2(x.state) ?? undefined })).slice(-400)
		}
		return out
	}
	if (kind === 'logbook') {
		return (raw ?? []).map(x => ({ t: fmt(x.when * 1000), id: x.entity_id, name: x.name, state: localTime(x.state, now, false), message: x.message, by: x.context_name ?? x.context_entity_id_name ?? x.source })).slice(-300)
	}
	for (const [id, rows] of Object.entries(raw ?? {})) out[id] = rows.map(x => [fmt((x.lc ?? x.lu) * 1000), localTime(x.s, now, false)]).slice(-300)
	return out
}

export function readTools() {
	return [
		{
			name: 'ha_search_entities',
			description: '엔티티 ID, 이름, 도메인, 방(area)으로 현재 HA 엔티티를 검색한다',
			properties: {
				query: { type: ['string', 'null'], description: '검색어(ID 또는 이름 일부). null이면 필터 없이 나열' },
				domain: { type: ['string', 'null'], description: '도메인 필터(예: light, switch, sensor). null이면 전체' },
				area: { type: ['string', 'null'], description: '방 이름 필터(예: 거실, 화장실). null이면 전체' },
				limit: { type: ['integer', 'null'], description: '최대 결과 수(1~100). null이면 30' },
			},
			async run(ctx, a) {
				const q = a.query ? String(a.query).toLowerCase() : null
				const lim = Math.min(Math.max(Number(a.limit) || 30, 1), 100)
				const out = []
				for (const [id, st] of ctx.states) {
					if (a.domain && id.split('.')[0] !== a.domain) continue
					const area = ctx.areaOf?.get(id) ?? null
					if (a.area && (!area || !area.toLowerCase().includes(String(a.area).toLowerCase()))) continue
					const name = st.attributes?.friendly_name ?? ''
					if (q && !id.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue
					out.push({
						id, name, area, state: localTime(st.state), changed: fmt(Date.parse(st.last_changed)),
						...(st.attributes?.unit_of_measurement ? { unit: st.attributes.unit_of_measurement } : {}),
						...(st.attributes?.device_class ? { device_class: st.attributes.device_class } : {}),
					})
					if (out.length >= lim) break
				}
				return clip(out)
			},
		},
		{
			name: 'ha_get_state',
			description: '지정한 엔티티들의 현재 상태와 전체 속성을 조회한다',
			properties: {
				entity_ids: { type: 'array', items: { type: 'string' }, description: '조회할 entity_id 목록(최대 10개)' },
			},
			async run(ctx, a) {
				const out = {}
				const now = Date.now()
				for (const id of (a.entity_ids ?? []).slice(0, 10)) {
					const st = ctx.states.get(id)
					out[id] = st ? { state: localTime(st.state, now), area: ctx.areaOf?.get(id) ?? null, attributes: localizeDeep(st.attributes, now), last_changed: fmt(Date.parse(st.last_changed)) } : null
				}
				return clip(out)
			},
		},
		{
			name: 'ha_get_history',
			description: 'HA 상태 기록(history), 활동 기록(logbook), 장기 통계(statistics) 중 하나를 조회한다',
			properties: {
				kind: { type: 'string', enum: ['history', 'logbook', 'statistics'], description: '조회 종류' },
				entity_ids: { type: 'array', items: { type: 'string' }, description: '대상 entity_id 목록(최대 6개)' },
				hours: { type: ['integer', 'null'], description: '최근 몇 시간(1~168). null이면 24' },
			},
			async run(ctx, a) {
				const ids = (a.entity_ids ?? []).filter(id => ctx.states.has(id)).slice(0, 6)
				if (!ids.length) return '유효한 entity_id가 없다'
				const h = Math.min(Math.max(Number(a.hours) || 24, 1), a.kind === 'statistics' ? 2160 : a.kind === 'logbook' ? 72 : 168)
				const kind = a.kind === 'statistics' || a.kind === 'logbook' ? a.kind : 'history'
				const data = kind === 'statistics' ? await ctx.ha.statistics(ids, h)
					: kind === 'logbook' ? await ctx.ha.logbook(ids, h)
						: await ctx.ha.history(ids, h)
				return clip(digestHaData(kind, data))
			},
		},
		{
			name: 'ha_get_automation_traces',
			description: '자동화 실행 추적(trace/list) 목록을 조회해 최근 실행 성공·오류·중단 단계를 확인한다',
			properties: {
				entity_id: { type: ['string', 'null'], description: '특정 automation.xxx (null이면 전체 최근 실행)' },
				limit: { type: ['integer', 'null'], description: '최대 개수(1~50). null이면 20' },
			},
			async run(ctx, a) {
				let itemId = null
				if (a.entity_id) itemId = ctx.autoCfg?.[a.entity_id]?.id ?? a.entity_id.replace(/^automation\./, '')
				const list = await ctx.ha.traces('automation', itemId ? String(itemId) : null)
				const lim = Math.min(Math.max(Number(a.limit) || 20, 1), 50)
				return clip((list ?? []).slice(0, lim))
			},
		},
		{
			name: 'ha_get_trace_detail',
			description: '특정 자동화/스크립트 실행(run_id)의 상세 trace를 읽어 어느 조건·동작에서 멈췄는지 확인한다',
			properties: {
				domain: { type: 'string', enum: ['automation', 'script'], description: '도메인' },
				item_id: { type: 'string', description: 'automation 또는 script 설정 id' },
				run_id: { type: 'string', description: 'trace/list에서 얻은 run_id' },
			},
			async run(ctx, a) {
				return clip(await ctx.ha.traceDetail(a.domain, a.item_id, a.run_id))
			},
		},
		{
			name: 'ha_get_config_entries',
			description: 'HA 통합 구성 요소(config entries) 상태를 조회한다',
			properties: {
				only_errors: { type: ['boolean', 'null'], description: 'true면 오류 상태인 통합만 반환' },
			},
			async run(ctx, a) {
				const entries = await ctx.ha.configEntries()
				const filtered = a.only_errors
					? (entries ?? []).filter(e => !e.disabled_by && ['setup_error', 'setup_retry', 'failed_unload'].includes(e.state))
					: (entries ?? [])
				return clip(filtered.map(e => ({ entry_id: e.entry_id, domain: e.domain, title: e.title, state: e.state, disabled_by: e.disabled_by, reason: e.reason })))
			},
		},
		{
			name: 'ha_get_backup_info',
			description: 'HA 자동 백업 상태와 백업 목록을 조회한다',
			properties: {},
			async run(ctx) {
				return clip(await ctx.ha.backupInfo())
			},
		},
		{
			name: 'ha_audit_orphans',
			description: '자동화 내 깨진 엔티티 참조, 통합 오류, 트레이스 오류, 대기 업데이트, 고아 엔티티를 종합 점검한다',
			properties: {},
			async run(ctx) {
				if (!ctx.haAdmin) return '관리 모듈을 사용할 수 없음'
				return clip(await ctx.haAdmin.auditHealth())
			},
		},
		{
			name: 'ha_render_template',
			description: 'HA Jinja2 템플릿을 드라이런으로 평가해 문법·결과를 확인한다',
			properties: {
				template: { type: 'string', description: '평가할 Jinja2 템플릿 문자열' },
			},
			async run(ctx, a) {
				return clip(await ctx.ha.renderTemplate(a.template))
			},
		},
		{
			name: 'memory_search',
			description: '구조화 장기 기억(선호, 지시사항, 거절 이력, 장애 이력, 생활 패턴)을 하이브리드(FTS5·유사도·엔티티)로 검색한다',
			properties: {
				query: { type: 'string', description: '검색 키워드 또는 문장' },
				category: { type: ['string', 'null'], enum: ['preference', 'standing_order', 'incident', 'pattern', 'rejection', null], description: '카테고리 필터. null이면 전체' },
				include_archived: { type: ['boolean', 'null'], description: 'true면 만료·삭제된 아카이브 기억까지 함께 검색. null이면 활성 기억만' },
			},
			async run(ctx, a) {
				if (!ctx.memory) return '[]'
				const hits = typeof ctx.memory.searchAsync === 'function'
					? await ctx.memory.searchAsync(a.query, a.category ?? null, { includeArchived: Boolean(a.include_archived) })
					: ctx.memory.search(a.query, a.category ?? null, { includeArchived: Boolean(a.include_archived) })
				return clip(hits.map(({ embedding, ...rest }) => rest))
			},
		},
		{
			name: 'memory_history',
			description: '구조화 장기 기억의 변경 이력(생성·수정·삭제·만료)을 조회한다',
			properties: {
				key: { type: ['string', 'null'], description: '조회할 기억 키. null이면 전체 최근 변경 이력' },
				limit: { type: ['integer', 'null'], description: '최대 개수(1~30). null이면 15' },
			},
			async run(ctx, a) {
				if (!ctx.memory) return '[]'
				const lim = Math.min(Math.max(Number(a.limit) || 15, 1), 30)
				return clip(ctx.memory.history(a.key ?? null, lim))
			},
		},
		{
			name: 'ha_get_weather',
			description: '현재 날씨와 시간별·일별 기상 예보를 조회한다',
			properties: {
				entity_id: { type: ['string', 'null'], description: '날씨 엔티티 ID. null이면 기본 날씨 엔티티' },
			},
			async run(ctx, a) {
				if (typeof ctx.getWeather !== 'function') return '날씨 조회 기능이 연결되지 않음'
				const w = await ctx.getWeather(a.entity_id ?? null)
				return clip({ entity: w?.entity ?? a.entity_id ?? null, summary: weatherText(w), raw: w })
			},
		},
		{
			name: 'ha_get_calendar',
			description: '등록된 HA 달력에서 다가오는 일정을 조회한다',
			properties: {
				days: { type: ['integer', 'null'], description: '조회할 일수(1~14). null이면 2(오늘~내일)' },
			},
			async run(ctx, a) {
				if (typeof ctx.getCalendar !== 'function') return '일정 조회 기능이 연결되지 않음'
				const days = Math.min(Math.max(Math.round(Number(a.days)) || 2, 1), 14)
				const c = await ctx.getCalendar(days)
				return clip({ days, summary: calendarText(c), events: c })
			},
		},
		{
			name: 'ha_get_recent_notifications',
			description: '최근 집 비서가 사용자에게 보낸 알림과 요약 기록을 조회한다',
			properties: {
				hours: { type: ['integer', 'null'], description: '최근 몇 시간(1~168). null이면 24' },
				limit: { type: ['integer', 'null'], description: '최대 개수(1~30). null이면 15' },
			},
			async run(ctx, a) {
				if (typeof ctx.getRecentNotifications !== 'function') return '알림 기록 조회 기능이 연결되지 않음'
				const hours = Math.min(Math.max(Math.round(Number(a.hours)) || 24, 1), 168)
				const limit = Math.min(Math.max(Math.round(Number(a.limit)) || 15, 1), 30)
				const list = await ctx.getRecentNotifications(hours, limit)
				return clip(list.map(n => ({
					ts: fmt(Date.parse(n.ts)),
					kind: n.kind,
					level: n.level,
					status: n.status,
					title: n.title,
					message: n.message,
				})))
			},
		},
	]
}
