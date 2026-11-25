// Codex에게 넘길 자료: 상태 요약본, 최근 변화, 날씨·일정 문장, 프롬프트
import { fmt, kst, globs } from './util.mjs'
import { recentFires } from './rules.mjs'

const SKIP_DOMAINS = new Set(['button', 'tts', 'stt', 'conversation', 'ai_task', 'wake_word', 'assist_satellite',
	'image', 'notify', 'tag', 'automation'])
const KEEP_ATTRS = {
	climate: ['current_temperature', 'temperature', 'hvac_action', 'current_humidity', 'hvac_modes'],
	fan: ['percentage', 'preset_mode', 'preset_modes'],
	light: ['brightness', 'color_temp_kelvin', 'supported_color_modes'],
	media_player: ['media_title', 'source', 'app_name', 'volume_level', 'is_volume_muted', 'source_list'],
	cover: ['current_position'],
	vacuum: ['battery_level'],
	weather: ['temperature', 'humidity'],
	calendar: ['message', 'start_time', 'end_time'],
	person: ['source'],
	select: ['options'],
	input_select: ['options'],
	input_number: ['min', 'max', 'step'],
	number: ['min', 'max', 'step'],
	script: ['last_triggered'],
	lock: ['changed_by'],
	update: ['installed_version', 'latest_version', 'release_summary', 'release_url'],
}
const isNum = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))

// areaOf: 엔티티 id → 방 이름 (HA의 영역 등록 정보에서 만든 Map)
export function compactStates(states, areaOf = null) {
	const out = []
	for (const st of states.values()) {
		const domain = st.entity_id.split('.')[0]
		if (SKIP_DOMAINS.has(domain)) continue
		if (domain === 'update' && st.state !== 'on') continue
		const a = st.attributes ?? {}
		const o = { id: st.entity_id, name: a.friendly_name, state: st.state }
		const area = areaOf?.get(st.entity_id)
		if (area) o.area = area
		if (a.unit_of_measurement) o.unit = a.unit_of_measurement
		if (a.device_class) o.class = a.device_class
		o.changed = fmt(Date.parse(st.last_changed))
		for (const k of KEEP_ATTRS[domain] ?? []) if (a[k] != null) (o.attrs ??= {})[k] = a[k]
		out.push(o)
	}
	return out.sort((x, y) => x.id.localeCompare(y.id))
}

// configs: 자동화 id → HA 자동화 설정. 설명과, 무엇을 보고(트리거) 무엇을 하는지(동작) 한 줄씩 붙인다.
export const automationList = (states, configs = null) => [...states.values()]
	.filter(s => s.entity_id.startsWith('automation.'))
	.map(s => {
		const c = configs?.[s.entity_id]
		const o = { id: s.entity_id, name: s.attributes?.friendly_name, state: s.state, last_triggered: fmt(Date.parse(s.attributes?.last_triggered)) }
		if (c?.id != null) o.config_id = String(c.id)
		if (c?.description) o.description = c.description
		if (c) {
			const one = x => (Array.isArray(x) ? x : x ? [x] : [])
			o.watches = [...new Set(one(c.triggers ?? c.trigger).flatMap(t => one(t.entity_id ?? t.event_type ?? t.trigger ?? t.platform)))].slice(0, 12)
			o.does = [...new Set(one(c.actions ?? c.action).map(a => a.action ?? a.service ?? Object.keys(a)[0]).filter(Boolean))].slice(0, 12)
		}
		return o
	})

const RING_DOMAINS = new Set(['binary_sensor', 'lock', 'switch', 'light', 'cover', 'fan', 'climate', 'media_player', 'person',
	'device_tracker', 'input_boolean', 'input_select', 'vacuum', 'alarm_control_panel', 'humidifier', 'water_heater', 'calendar', 'select'])

// 사람이 읽을 만한 상태 변화만 남긴다(숫자 센서 출렁임, 속성만 바뀐 것은 뺀다).
export function notableChange(d) {
	const o = d.old_state, n = d.new_state
	if (!n || (o && o.state === n.state)) return null
	const domain = n.entity_id.split('.')[0]
	let ok = RING_DOMAINS.has(domain)
	if (domain === 'sensor') {
		const dc = n.attributes?.device_class
		ok = !['timestamp', 'date'].includes(dc) && !isNum(n.state) && !isNum(o?.state) && !/^\d{4}-\d\d-\d\dT/.test(n.state)
	}
	if (!ok) return null
	return { t: Date.parse(n.last_changed) || Date.now(), id: n.entity_id, name: n.attributes?.friendly_name, from: o?.state ?? null, to: n.state }
}

// 켜진 채로 오가는 재생 상태(재생↔일시정지↔대기)는 집 상태가 달라진 것으로 치지 않는다.
const MEDIA_ON = new Set(['on', 'playing', 'paused', 'idle', 'buffering'])
// 정각 점검을 건너뛸지 따질 때 "집에 무슨 일이 있었다"고 볼 만한 변화인가. isNoise는 설정의 noise_entities.
export const significantChange = (c, isNoise = () => false) =>
	!isNoise(c.id) && !(c.id.startsWith('media_player.') && MEDIA_ON.has(c.from) && MEDIA_ON.has(c.to))

const BURST_GAP = 5 * 60000
// 최근 변화를 프롬프트 줄로. 같은 엔티티가 짧은 사이에 3번 넘게 바뀐 것은 한 줄로 묶고, 소음 엔티티는 횟수만 남긴다.
export function changeLines(list, isNoise = () => false, max = 80) {
	const hm = t => kst(new Date(t)).hm
	const noise = new Map(), bursts = [], open = new Map()
	for (const c of list) {
		if (isNoise(c.id)) { noise.set(c.id, { name: c.name ?? c.id, n: (noise.get(c.id)?.n ?? 0) + 1 }); continue }
		const b = open.get(c.id)
		if (b && c.t - b.at(-1).t <= BURST_GAP) b.push(c)
		else { const nb = [c]; open.set(c.id, nb); bursts.push(nb) }
	}
	const rows = []
	for (const b of bursts) {
		if (b.length < 3) { for (const c of b) rows.push([c.t, `- ${hm(c.t)} ${c.name ?? c.id} (${c.id}) ${c.from} → ${c.to}`]); continue }
		const seq = [b[0].from, ...b.map(c => c.to)]
		const path = seq.length <= 6 ? seq.join(' → ') : `${seq.slice(0, 3).join(' → ')} → … → ${seq.slice(-2).join(' → ')}`
		rows.push([b[0].t, `- ${hm(b[0].t)}~${hm(b.at(-1).t)} ${b[0].name ?? b[0].id} (${b[0].id}) ${b.length}번 바뀜: ${path}`])
	}
	const lines = rows.sort((a, b) => a[0] - b[0]).map(r => r[1]).slice(-max)
	if (noise.size) lines.push(`- (소음으로 분류해 줄임) ${[...noise.values()].map(v => `${v.name} ${v.n}번`).join(', ')}`)
	return lines
}

// 지침에서 이번 깨움에 필요 없는 절을 뺀다. `<!-- only: weekly -->` … `<!-- /only -->`로 감싼 절은 그 종류의 깨움에만 넣는다.
export function guideFor(text, reasons = []) {
	const types = new Set(reasons.map(r => r.type))
	return text.replace(/<!-- only: ([a-z_, ]+) -->\n?([\s\S]*?)<!-- \/only -->\n?/g, (_, only, body) => (only.split(',').some(t => types.has(t.trim())) ? body : ''))
}

const COND = {
	'clear-night': '맑음', cloudy: '흐림', fog: '안개', hail: '우박', lightning: '뇌우', 'lightning-rainy': '뇌우·비',
	partlycloudy: '구름 조금', pouring: '폭우', rainy: '비', snowy: '눈', 'snowy-rainy': '진눈깨비', sunny: '맑음',
	windy: '바람', 'windy-variant': '바람·구름', exceptional: '특이 기상',
}
const r1 = v => (isNum(v) ? Math.round(Number(v) * 10) / 10 : v)

export function weatherText(w) {
	if (!w || w.error) return `날씨를 가져오지 못함${w?.error ? `: ${w.error}` : ''}`
	const lines = []
	if (w.current) {
		const c = w.current
		lines.push(`지금: ${COND[c.state] ?? c.state}, ${r1(c.temperature)}°C, 습도 ${r1(c.humidity)}%, 바람 ${r1(c.wind_speed)}${c.wind_unit ?? ''}`)
	}
	if (w.hourly?.length) lines.push('시간별: ' + w.hourly.map(f => {
		const rain = Number(f.precipitation) > 0 ? ` 비 ${r1(f.precipitation)}mm` : ''
		const prob = f.precipitation_probability != null ? ` (강수확률 ${f.precipitation_probability}%)` : ''
		return `${kst(new Date(f.datetime)).h}시 ${COND[f.condition] ?? f.condition} ${Math.round(f.temperature)}°${rain}${prob}`
	}).join(', '))
	if (w.daily?.length) lines.push('일별: ' + w.daily.map(f => {
		const k = kst(new Date(f.datetime))
		const rain = Number(f.precipitation) > 0 ? ` 비 ${r1(f.precipitation)}mm` : ''
		return `${k.date.slice(5)}(${k.wd}) ${COND[f.condition] ?? f.condition} ${f.templow != null ? Math.round(f.templow) + '~' : ''}${Math.round(f.temperature)}°${rain}`
	}).join(', '))
	return lines.join('\n')
}

export function calendarText(c) {
	if (!c || c.error) return `일정을 가져오지 못함${c?.error ? `: ${c.error}` : ''}`
	if (!c.length) return '(없음)'
	return c.map(ev => {
		const allDay = /^\d{4}-\d\d-\d\d$/.test(ev.start)
		let when
		if (allDay) {
			const s = new Date(`${ev.start}T00:00:00+09:00`), k = kst(s)
			const endMs = /^\d{4}-\d\d-\d\d$/.test(ev.end ?? '') ? Date.parse(`${ev.end}T00:00:00+09:00`) : NaN
			const lastMs = Number.isFinite(endMs) ? endMs - 86400000 : NaN
			const endK = Number.isFinite(lastMs) && lastMs > s.getTime() ? kst(new Date(lastMs)) : null
			when = endK ? `${k.date.slice(5)}(${k.wd})~${endK.date.slice(5)}(${endK.wd}) 종일` : `${k.date.slice(5)}(${k.wd}) 종일`
		} else {
			const s = new Date(ev.start), e = new Date(ev.end), k = kst(s), ek = kst(e)
			when = ek.date === k.date
				? `${k.date.slice(5)}(${k.wd}) ${k.hm}~${ek.hm}`
				: `${k.date.slice(5)}(${k.wd}) ${k.hm}~${ek.date.slice(5)}(${ek.wd}) ${ek.hm}`
		}
		return `- ${when} ${ev.summary}${ev.location ? ` @${ev.location}` : ''} [${ev.calendar}]`
	}).join('\n')
}

function describeReason(r) {
	const again = r.attempts ? ` (지난 판단이 실패해 ${r.attempts + 1}번째 시도)` : ''
	switch (r.type) {
		case 'bootstrap': return '[처음 시작] 아직 감시 규칙이 없다. 집을 파악하고 규칙과 메모를 만들어라.' + again
		case 'rule': return `[규칙 발동] ${r.rule_id}: ${r.description} — ${r.entity_id} 현재 값 ${JSON.stringify(r.value)} (${fmt(r.since)}부터)`
			+ (r.pre_notified ? ' ※ urgent 규칙이라 규칙 설명이 이미 긴급 알림으로 나갔다. 보탤 내용이 있을 때만 같은 related_rule_ids로 후속 알림을 낸다.' : '') + again
		case 'anomaly': return `[이상 패턴 감지] ${r.entity_id} (${r.name ?? ''}) 현재 값 ${r.value} (평소 평균 ${r.avg}, 편차 ${r.z}σ)` + again
		case 'scheduled': return `[예약] ${r.reason} (예약 시각 ${fmt(r.at)})` + again
		case 'hourly': return (r.briefing ? `[정기 브리핑] ${r.hour}시` : `[정각 점검] ${r.hour}시`) + again
		case 'reflection': return `[하루 돌아보기 + 정각 점검] ${r.hour}시` + again
		case 'weekly': return '[주간 분석] 지난 7일의 자동화 실행과 기기 조작을 분석해 개선안과 새 자동화 제안을 report에 쓴다(지침의 "주간 분석").' + again
		case 'held': return '[밤사이 보류] 아래 "밤사이 보류된 것"을 보고 아직 유효한 것만 처리한다.'
		case 'manual': return `[사용자 요청] ${r.reason}` + again
		case 'user': return `[사용자 말] 사용자가 휴대폰에서 직접 보낸 말이다(지시로 따른다): "${r.text}"${r.about ? ` — 알림 "${r.about}"에 단 답장` : ''}` + again
		case 'retry': return `[다시 시도] 지난번 판단이 실패했다: ${r.reason}`
		default: return `[${r.type}]`
	}
}

const FEEDBACK_MARK = { up: '👍 도움됐어요', mute: '🔕 이건 그만', less: '🔽 줄여 줘', reply: '💬 답장' }
const STATUS = { sent: '보냄', held: '보류(조용한 시간)', test_mode: '시험 모드라 안 보냄', over_limit: '한도 초과로 안 보냄', error: '발송 오류', queued: '발송 실패, 다시 보내는 중', expired: '끝내 못 보냄', replaced: '못 보낸 사이 새 요약으로 대신함' }
const ACT_STATUS = { done: '실행함', unverified: '실행했지만 상태 확인 안 됨', error: '실패', pending: '승인 기다리는 중', declined: '사용자가 거절', expired: '승인 없이 시간 지남', undone: '사용자가 되돌림', test_mode: '시험 모드라 안 함' }
const VERB = { turn_on: '켜기', turn_off: '끄기' }
const INFO_KIND = { history: '상태 기록', statistics: '통계(평균·최소·최대)', logbook: '활동 기록(무엇이 바꿨는지)', traces: '자동화 실행 추적(trace)', config_entries: '통합 구성 요소 상태' }

function ruleLine(r, rt, now) {
	const cond = c => `${c.entity_id}${c.attribute ? `[${c.attribute}]` : ''} ${c.op}${c.value != null ? ` ${JSON.stringify(c.value)}` : ''}`
	let target = cond(r)
	for (const c of r.also ?? []) target += ` 그리고 ${cond(c)}`
	if (r.hour_from != null) target += ` (${r.hour_from}~${r.hour_to}시만)`
	const extra = [`7일 발동 ${recentFires(rt, now).length}회`]
	if (rt.backtest) extra.push(`백테스트: 만들 때 지난 ${rt.backtest.days}일 기록으로는 ${rt.backtest.fires}회 발동했을 것`)
	if (rt.last_fired) extra.push(`마지막 ${fmt(rt.last_fired)}`)
	const cl = (rt.clear_log ?? []).slice(-3).map(([a, b]) => `${Math.round((b - a) / 60000)}분`)
	if (cl.length) extra.push(`발동 뒤 풀리기까지 ${cl.join(', ')}`)
	if (rt.muted_until && rt.muted_until > now) extra.push(`${fmt(rt.muted_until)}까지 쉼(사용자가 그만)`)
	if (rt.fired) extra.push(rt.waiting ? '지금 조건 참(쿨다운·쉼이 끝나면 발동)' : '지금 조건 참')
	const span = r.op === 'older_than' ? '값의 시각 기준' : ['stale', 'changes_gt', 'rise_gt', 'drop_gt'].includes(r.op) ? `${r.for_minutes}분 구간` : `${r.for_minutes}분 지속`
	return `- ${r.id} | ${r.description} | ${target} | ${span}, 쿨다운 ${r.cooldown_minutes}분, ${r.priority} | ${extra.join(', ')}`
}

export function buildPrompt(x) {
	const now = kst(new Date(x.now))
	const feedback = x.feedback ?? []
	const fbByNid = new Map(feedback.filter(f => f.nid).map(f => [f.nid, f]))
	const lines = []
	const sec = (title, body) => lines.push(`\n## ${title}\n${body}`)

	lines.push(guideFor(x.guide, x.reasons).trim())
	if (x.homeProfile?.trim()) sec('이 집의 프로필', x.homeProfile.trim())
	lines.push('\n---\n# 이번 깨움')
	lines.push(`- 지금: ${now.date}(${now.wd}) ${now.hm} KST, ${x.quiet ? '조용한 시간(urgent만 실제로 나감)' : '활동 시간'}`)
	const hrs = x.hours
	if (hrs) {
		const checkinDesc = hrs.briefings?.length
			? `정기 브리핑 ${hrs.briefings.join(', ')}시`
			: hrs.checkins?.length ? `정각 점검 ${hrs.checkins[0]}~${hrs.checkins.at(-1)}시` : '정각 점검 없음'
		lines.push(`- 하루 시간표: 활동 시간 ${hrs.start}~${hrs.end}시(그 밖은 조용한 시간), ${checkinDesc}${hrs.reflection != null ? `, 하루 돌아보기 ${hrs.reflection}시` : ''}`)
	}
	if (x.awayOverride) lines.push(`- 재실·방해금지 도우미: ${x.awayOverride.name ?? x.awayOverride.id} (${x.awayOverride.id}) = ${x.awayOverride.state}`)
	lines.push('- 깨운 이유:')
	x.reasons.forEach((r, i) => lines.push(`  ${i + 1}. ${describeReason(r)}`))

	const notes = x.recentNotes ?? []
	sec('최근 24시간 보낸 알림', notes.length ? notes.slice(-30).map(n => {
		const fb = fbByNid.get(n.nid)
		const k = kst(new Date(n.ts))
		return `- ${k.date.slice(5)} ${k.hm} [${n.kind}/${n.level}/${STATUS[n.status] ?? n.status}] ${n.title} — ${n.message}${fb ? ` (${FEEDBACK_MARK[fb.kind]}${fb.text ? `: "${fb.text}"` : ''})` : ''}`
	}).join('\n') : '(없음)')

	sec('최근 7일 사용자 피드백', feedback.length ? feedback.slice(-20).map(f =>
		`- ${fmt(Date.parse(f.ts))} ${FEEDBACK_MARK[f.kind] ?? f.kind}${f.text ? ` "${f.text}"` : ''}${f.title ? ` ← 알림 "${f.title}"` : ''}${f.message ? ` (그 요약: ${f.message.replace(/\s+/g, ' ').slice(0, 160)})` : ''}${f.rules?.length ? ` (규칙 ${f.rules.join(', ')})` : ''}`).join('\n') : '(없음)')

	if (x.held?.length) sec('밤사이 보류된 것', x.held.map(h => h.type === 'rule'
		? `- ${fmt(h.at)} 규칙 발동 ${h.rule_id}: ${h.description} (값 ${JSON.stringify(h.value)})`
		: h.type === 'anomaly'
			? `- ${fmt(h.at)} 이상 패턴 감지 ${h.entity_id} (${h.name ?? ''}): 값 ${h.value} (평균 ${h.avg}, ${h.z}σ)`
			: `- ${fmt(Date.parse(h.ts))} 보내지 않은 알림 [${h.level}] ${h.title} — ${h.message}`).join('\n'))

	sec(`감시 규칙 (${x.rules.length}개)`, x.rules.length ? x.rules.map(r => ruleLine(r, x.runtime[r.id] ?? {}, x.now)).join('\n') : '(없음)')

	const act = x.actions
	if (act?.tiers?.length) {
		const tierText = { auto: '스스로 실행(Tier 1)', confirm: '사용자 승인 뒤 실행(Tier 2)' }
		sec(`행동 권한 (오늘 ${act.today}/${act.perDay}회 사용)`, [
			...act.tiers.map(t => `- ${t.id} (${t.name ?? ''}) 지금 ${t.state} — ${tierText[t.tier]}${t.fields ? ` [${t.fields}]` : ''}`),
			...(act.adminEnabled ? ['※ HA 관리 제안(proposals): 자동화·스크립트 수정/생성, 통합 리로드, 백업, 규칙 승격, 엔티티 정리는 사전 검증 뒤 Tier 2 승인 요청으로 낼 수 있습니다.'] : []),
			...(act.onRequest && x.reasons.some(r => r.type === 'user') ? ['※ 사용자가 이번 말에서 직접 시킨 행동은 requested=true로 낸다. 그러면 승인을 묻지 않고 바로 실행된다(조용한 시간에도). 네가 스스로 판단한 행동은 requested=false.'] : []),
			...(act.recent?.length ? ['최근 행동:', ...act.recent.map(a => `- ${fmt(Date.parse(a.ts))} ${a.name ?? a.entity_id} ${VERB[a.action] ?? a.action} [${ACT_STATUS[a.status] ?? a.status}] ${a.reason}`)] : []),
		].join('\n'))
	} else sec('행동 권한', '없음. actions는 빈 배열로 둔다(알림만 가능).')

	if (x.pendingProposals?.length) {
		sec(`승인 대기 중인 HA 관리 제안 (${x.pendingProposals.length}건)`, x.pendingProposals.map(p => `- [${p.pid}] (${p.kind}) ${p.title} — ${p.summary}`).join('\n'))
	}

	sec('예약된 깨움', x.schedule.length ? x.schedule.map(w => `- ${fmt(Date.parse(w.at))} ${w.reason}`).join('\n') : '(없음)')
	if (x.rejected?.length) sec('지난 답에서 거절된 변경 (고쳐서 다시 내도 된다)', x.rejected.map(r => `- ${JSON.stringify(r)}`).join('\n'))
	sec('메모', x.memory.trim() || '(비어 있음)')
	if (x.lessons?.trim()) sec('학습된 교훈 (Playbook — 반드시 준수)', x.lessons.trim())
	if (x.memoryHygiene?.length) sec('기억 정리 힌트 (reflection 참고)', x.memoryHygiene.map(l => `- ${l}`).join('\n'))
	if (x.assistHistory?.length) {
		sec('최근 24시간 HA Assist 대화', x.assistHistory.map(m => `- ${fmt(m.ts)} [${m.role === 'user' ? '사용자' : '비서'}] ${String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n'))
	}
	if (x.metrics) sec('지난 7일 지표', Object.entries(x.metrics).map(([k, v]) => `${k}=${v}`).join(', '))
	if (x.learningDigest?.trim()) sec('자가학습 분석 요약 (암묵적 피드백·규칙 정밀도·루틴·실험·자가튜닝 후보)', x.learningDigest.trim())
	if (x.repairFeedback?.length) {
		sec('직전 제안 사전 검증 오류 (이번 차례에서 고쳐서 다시 제출할 것)', x.repairFeedback.map(e => `- ${e.title}: ${e.error}`).join('\n'))
	}

	const recent = changeLines(x.ring.filter(c => x.now - c.t < 2 * 3600000), globs(x.noise))
	sec('최근 2시간 주요 상태 변화', recent.length ? recent.join('\n') : '(없음)')
	const sd = x.sysDelta
	if (sd && (sd.newErrors?.length || sd.increasedErrors?.length || sd.newOther?.length || sd.increasedOther?.length || sd.newRepairs?.length)) {
		const sLines = [
			...(sd.newErrors ?? []).map(e => `- [신규 ${e.level}] ${e.name}: ${e.message} (${e.count}회, ${e.last})`),
			...(sd.increasedErrors ?? []).map(e => `- [증가 ${e.level}] ${e.name}: ${e.message} (${e.prev_count} → ${e.count}회, +${e.count - e.prev_count}, ${e.last})`),
			...(sd.newOther ?? []).map(e => `- [신규 ${e.level}] ${e.name}: ${e.message} (${e.count}회, ${e.last})`),
			...(sd.increasedOther ?? []).map(e => `- [증가 ${e.level}] ${e.name}: ${e.message} (${e.prev_count} → ${e.count}회, +${e.count - e.prev_count}, ${e.last})`),
			...(sd.newRepairs ?? []).map(r => `- [신규 수리] ${r.domain}:${r.id} (${r.severity})`),
			'- 참고: 횟수·시각이 그대로인 기존 항목은 프로그램이 자동 추적하므로 메모에 따로 적어 비교하지 않아도 됩니다.',
		]
		sec('HA 시스템 오류·수리 변화', sLines.join('\n'))
	}
	sec(`날씨 (${x.weather?.entity ?? ''})`, weatherText(x.weather))
	sec('일정 (지금부터 내일까지)', calendarText(x.calendar))
	sec('참고 파일 (읽기 전용)', [
		'- run/states.json: 모든 엔티티 현재 상태 요약 (id, name, area, state, unit, class, changed, attrs)',
		'- run/automations.json: 이미 있는 HA 자동화 목록 (설명, 지켜보는 대상 watches, 하는 일 does, 마지막 실행)',
		'- run/automation-configs.json: 자동화 설정 원문 (트리거·조건·동작 전체)',
		'- run/daily.json: 최근 14일의 하루 요약 (엔티티별 변화 횟수·처음/마지막 시각·켜져 있던 분, 알림·피드백 수). 변화가 없던 엔티티는 빠져 있다',
		'- run/repairs.json: HA가 알리는 수리 항목, run/system-log.json: HA 오류·경고 기록',
		...(x.reasons.some(r => r.type === 'weekly') ? [
			'- run/weekly-automations.json: 자동화별 지난 7일 실행 횟수(runs)·날짜별(by_day)·시간대별(by_hour)·무엇이 실행시켰는지(triggers). period.oldest_record가 HA에 남은 가장 오래된 기록',
			'- run/weekly-devices.json: 기기별 지난 7일 상태 변화의 출처(by_source), 자동화가 아닌 조작(manual), 자동화가 한 일을 사람이 곧 되돌린 일(reverted)과 그 반대(overridden), 자동화가 남긴 설명(automation_notes)',
			'- run/weekly-health.json: 깨진 엔티티 참조, 통합 오류, 최근 오류 트레이스, 대기 업데이트 점검 결과',
		] : []),
		...(x.lastReport ? [`- run/weekly-last-report.md: 지난 주간 분석 보고서 (${x.lastReport.replace('.md', '')})`] : []),
		...(x.infoFiles ?? []).map(h => `- ${h.file}: ${h.entity_ids.join(', ')} 최근 ${h.hours}시간 ${INFO_KIND[h.kind]} (요청한 것)`),
	].join('\n'))
	if (x.infoFiles?.length) lines.push(x.lastRound ? '\n요청한 자료를 받았다. 더는 요청할 수 없으니 info_requests를 빈 배열로 두고 판단을 끝낸다.' : '\n요청한 자료를 받았다. 꼭 더 필요할 때만 info_requests를 다시 쓴다.')
	lines.push('\n위 지침과 자료로 판단하고, 최종 답은 스키마에 맞는 JSON 하나만 낸다.')
	return lines.join('\n')
}
