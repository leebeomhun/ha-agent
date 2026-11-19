// 관리 명령: node src/cli.mjs <명령>
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, cpSync, copyFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { P, ROOT, readJson, writeJson, readJsonlAll, latestBy, fmt, kst, newId, expandHome } from './util.mjs'
import { loadConfig, loadControl, saveControl, validateConfig } from './config.mjs'
import { MODES, MODE_LABEL, brainMode, brainSettings, selfCheck } from './brain.mjs'
import { recentFires } from './rules.mjs'
import { rangeStats } from './records.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const daemonPid = () => { const p = Number(existsSync(P.pid) ? readFileSync(P.pid, 'utf8') : 0); try { return p && process.kill(p, 0) ? p : 0 } catch { return 0 } }
const toInbox = obj => {
	mkdirSync(P.inbox, { recursive: true })
	writeJson(join(P.inbox, `${Date.now()}-${newId()}.json`), obj)
}
const VERB = { turn_on: '켜기', turn_off: '끄기' }
const MODE_DESC = { codex: 'Codex CLI', api: 'OpenAI API 직접 호출' }
// 지금 판단 방식 한 줄: 방식, 모델, 추론 노력, 어디서 정해졌는지
const brainLine = (cfg, c) => {
	const mode = brainMode(cfg, c), s = brainSettings(cfg, mode)
	const from = MODES.includes(c.brain) ? `cli brain으로 바꿈, config.json은 ${brainMode(cfg)}` : 'config.json'
	return `판단 방식: ${mode} (${MODE_DESC[mode]}) | 모델 ${s.model}, 노력 ${s.effort_hourly}/${s.effort}/${s.effort_deep} | ${from}`
}

const cmds = {
	status() {
		const c = loadControl(), cfg = loadConfig(), rules = readJson(P.rules, null), rt = readJson(P.runtime, { rules: {} }).rules ?? {}
		const cnt = readJson(P.counters, {}), sched = readJson(P.schedule, []), held = readJson(P.held, [])
		const q = readJson(P.queue, {}), outbox = readJson(P.outbox, [])
		const pending = latestBy(readJsonlAll(P.actions), 'aid').filter(a => a.status === 'pending')
		const last = readJsonlAll(P.decisions).slice(-1)[0]
		console.log(`데몬: ${daemonPid() ? `실행 중 (pid ${daemonPid()})` : '꺼짐'} | ${c.paused ? '일시정지' : '동작'} | 알림 발송 ${c.send ? '켜짐' : '꺼짐(시험 모드)'}`)
		console.log(brainLine(cfg, c))
		console.log(`오늘(${cnt.date ?? '-'}): 판단 ${cnt.runs ?? 0}회, 알림 ${cnt.alerts ?? 0}개, 요약 ${cnt.summaries ?? 0}개, 행동 ${cnt.actions ?? 0}회`)
		console.log(`규칙 ${rules?.rules?.length ?? 0}개 (지금 조건 참: ${Object.values(rt).filter(r => r.fired).length}개), 예약 ${sched.length}개, 밤사이 보류 ${held.length}개`)
		console.log(`대기 중인 깨움 ${(q.queue ?? []).length}건, 다시 보낼 알림 ${outbox.length}개, 승인 기다리는 행동 ${pending.length}개`)
		const a = cfg.actions
		console.log(`행동: ${a.enabled ? `켜짐 (스스로 ${a.auto.length}개, 승인 뒤 ${a.confirm.length}개 엔티티)` : '꺼짐(알림만)'} | 비상 알림 길: ${cfg.oob.type ?? '꺼짐'} | heartbeat: ${cfg.heartbeat.enabled ? '켜짐' : '꺼짐'}`)
		const wk = cfg.weekly, lastWeekly = readJson(P.runtime, {}).last_weekly
		console.log(`주간 분석: ${wk.enabled ? `매주 ${wk.weekday}요일 ${wk.hour}시` : '꺼짐'}${lastWeekly ? ` | 마지막 ${lastWeekly}` : ''} | 하루 돌아보기: ${cfg.reflection_hour == null ? '꺼짐' : `${cfg.reflection_hour}시`} | 활동 시간 ${cfg.active_hours.start}~${cfg.active_hours.end}시`)
		console.log(`자동 전환(codex↔api): ${cfg.failover.enabled ? `${cfg.failover.after_failures}번 연속 실패 시, ${MODES.filter(m => m !== brainMode(cfg, c)).map(m => `${m} ${selfCheck(cfg, m) ? '쓸 수 없음' : '쓸 수 있음'}`).join('')}` : '꺼짐'} | urgent 다시 알림: ${cfg.escalation.enabled ? `${cfg.escalation.remind_minutes}분마다 ${cfg.escalation.max_reminders}번` : '꺼짐'}`)
		for (const w of sched) console.log(`  예약 ${fmt(Date.parse(w.at))} ${w.reason}`)
		if (last) console.log(`마지막 판단 ${fmt(Date.parse(last.ts))} (${Math.round(last.total_ms / 1000)}초): ${last.error ? `실패 ${last.error}` : last.summary}`)
	},
	rules() {
		const rules = readJson(P.rules, null)?.rules ?? [], rt = readJson(P.runtime, { rules: {} }).rules ?? {}
		const now = Date.now()
		const cond = c => `${c.entity_id}${c.attribute ? `[${c.attribute}]` : ''} ${c.op} ${c.value ?? ''}`.trim()
		for (const r of rules) {
			const x = rt[r.id] ?? {}
			const extra = [...(r.also ?? []).map(c => `그리고 ${cond(c)}`), ...(r.hour_from != null ? [`${r.hour_from}~${r.hour_to}시만`] : [])]
			console.log(`${r.id}  [${r.priority}] ${r.description}\n    ${cond(r)}${extra.length ? ` · ${extra.join(' · ')}` : ''} · ${r.for_minutes}분 · 쿨다운 ${r.cooldown_minutes}분 · 7일 발동 ${recentFires(x, now).length}회${x.backtest ? ` · 백테스트 ${x.backtest.days}일 ${x.backtest.fires}회` : ''}${x.waiting ? ' · 쿨다운·쉼 뒤 발동 대기' : ''}${x.muted_until > now ? ` · ${fmt(x.muted_until)}까지 쉼` : ''}`)
		}
		if (!rules.length) console.log('규칙 없음')
	},
	log() {
		const n = Number(rest[0]) || 10
		for (const d of readJsonlAll(P.decisions).slice(-n)) {
			const u = d.usage ? ` (입력 ${d.usage.input}/캐시 ${d.usage.cached}/출력 ${d.usage.output}/추론 ${d.usage.reasoning})` : ''
			console.log(`${fmt(Date.parse(d.ts))} [${d.reasons.join(', ')}] ${Math.round(d.total_ms / 1000)}초 토큰 ${d.tokens ?? '?'}${u}${d.rounds > 1 ? ` (${d.rounds}번 물음)` : ''}${d.skipped ? ' (건너뜀)' : ''}${d.deferred ? ' (미룸)' : ''}${d.brain === 'api' ? ' [api]' : ''}${d.failover ? ' (자동 전환)' : ''}`)
			console.log(`  ${d.error ? `실패: ${d.error}` : d.summary}`)
			const a = d.applied
			if (a) {
				const parts = []
				if (a.added?.length) parts.push(`규칙 추가 ${a.added.join(', ')}`)
				if (a.changed?.length) parts.push(`규칙 수정 ${a.changed.join(', ')}`)
				if (a.deleted?.length) parts.push(`규칙 삭제 ${a.deleted.join(', ')}`)
				if (a.wakes?.length) parts.push(`예약 ${a.wakes.join(', ')}`)
				if (a.memory !== 'keep') parts.push(`메모 ${a.memory}`)
				if (a.report) parts.push(`주간 보고서 ${a.report}`)
				if (a.rejected?.length) parts.push(`거절 ${a.rejected.length}건`)
				if (a.backtest?.length) parts.push(`백테스트 ${a.backtest.join(', ')}`)
				if (parts.length) console.log(`  ${parts.join(' · ')}`)
				for (const x of a.actions ?? []) console.log(`  행동 ${x}`)
				for (const n of a.notifications ?? []) console.log(`  알림 ${n}`)
			}
		}
	},
	notes() {
		const day = rest[0] ?? kst().date
		for (const n of latestBy(readJsonlAll(P.notifications), 'nid').filter(n => kst(new Date(n.ts)).date === day)) console.log(`${kst(new Date(n.ts)).hm} [${n.kind}/${n.level}/${n.status}] ${n.title} — ${n.message}`)
	},
	actions() {
		const n = Number(rest[0]) || 20
		const list = latestBy(readJsonlAll(P.actions), 'aid').slice(-n)
		for (const a of list) console.log(`${fmt(Date.parse(a.ts))} [${a.tier}/${a.status}] ${a.name} ${VERB[a.action]} — ${a.reason}${a.error ? ` (${a.error})` : ''}`)
		if (!list.length) console.log('행동 기록 없음')
	},
	memory() { console.log(existsSync(P.memory) ? readFileSync(P.memory, 'utf8') : '(비어 있음)') },
	// 주간 분석 보고서: 인자 없으면 가장 최근 것, list는 목록, run은 지금 분석시키기, publish는 최근 것을 HA 알림 목록에 올리기, 날짜(YYYY-MM-DD)는 그날 것.
	async weekly() {
		const { listWeekly, readWeekly } = await import('./records.mjs')
		const arg = rest[0]
		if (arg === 'run') {
			toInbox({ cmd: 'weekly' })
			return console.log(daemonPid() ? '주간 분석을 요청했어요. 몇 분 걸리고, 끝나면 알림이 가요.' : '데몬이 꺼져 있어 요청만 넣어 두었어요.')
		}
		if (arg === 'publish') {
			if (!readWeekly()) return console.log('올릴 보고서가 아직 없어요.')
			toInbox({ cmd: 'weekly-publish' })
			return console.log(daemonPid() ? '가장 최근 보고서를 HA 앱의 알림(🔔)에 올리도록 요청했어요.' : '데몬이 꺼져 있어 요청만 넣어 두었어요.')
		}
		if (arg === 'list') {
			const names = listWeekly()
			for (const n of names) console.log(n.replace('.md', ''))
			if (!names.length) console.log('보고서 없음')
			return
		}
		const r = arg ? readWeekly(`${arg}.md`) : readWeekly()
		const w = loadConfig().weekly
		console.log(r ? r.text : arg ? `그 날짜의 보고서가 없어요: ${arg}. 'weekly list'로 확인하세요.` : `아직 보고서가 없어요. ${w.enabled ? `매주 ${w.weekday}요일 ${w.hour}시에 분석합니다.` : '주간 분석이 꺼져 있어요(config.json의 weekly.enabled).'} 지금 하려면 'weekly run'.`)
	},
	wake() {
		toInbox({ cmd: 'wake', reason: rest.join(' ') || '수동 점검' })
		console.log(daemonPid() ? '깨움 요청을 넣었어요. 15초 안에 판단을 시작합니다.' : '데몬이 꺼져 있어 요청만 넣어 두었어요.')
	},
	say() {
		if (!rest.length) return console.log('쓰는 법: say <집 비서에게 할 말>')
		toInbox({ cmd: 'say', text: rest.join(' ') })
		console.log(daemonPid() ? '말을 전했어요. 15초 안에 판단을 시작합니다.' : '데몬이 꺼져 있어 말만 넣어 두었어요.')
	},
	// 판단 방식 보기·바꾸기. 바꾼 값은 state/control.json에 남고, 데몬은 재시작 없이 다음 판단부터 따른다.
	brain() {
		const cfg = loadConfig(), c = loadControl(), want = rest[0]
		if (!want) {
			console.log(brainLine(cfg, c))
			for (const m of MODES) console.log(`  ${m}: ${selfCheck(cfg, m) ?? '쓸 수 있음'}`)
			return console.log('바꾸기: node src/cli.mjs brain codex|api  (config.json 값으로 되돌리기: brain default)')
		}
		if (want === 'default') {
			const { brain, ...keep } = c
			saveControl(keep)
			return console.log(`config.json 값으로 되돌렸어요.\n${brainLine(cfg, keep)}`)
		}
		if (!MODES.includes(want)) return console.log(`쓰는 법: brain [${MODES.join('|')}|default]`)
		const problem = selfCheck(cfg, want)
		if (problem) return console.log(`바꾸지 않았어요. ${want} 방식을 쓸 수 없어요: ${problem}`)
		const next = { ...c, brain: want }
		saveControl(next)
		console.log(`${brainLine(cfg, next)}\n${daemonPid() ? '다음 판단부터 이 방식으로 묻습니다(재시작 필요 없음).' : '데몬이 꺼져 있어요. 켜지면 이 방식으로 묻습니다.'}`)
		if (want === 'api') console.log('API 방식은 쓴 토큰만큼 요금이 나가요. 쓴 양은 `log`의 토큰으로 봅니다.')
	},
	pause() { saveControl({ ...loadControl(), paused: true }); console.log('일시정지: 규칙 감시는 계속하지만 AI 판단·알림·행동을 멈춥니다.') },
	resume() { saveControl({ ...loadControl(), paused: false }); console.log('다시 동작합니다.') },
	'send-on'() { saveControl({ ...loadControl(), send: true }); console.log('알림 발송을 켰어요.') },
	'send-off'() { saveControl({ ...loadControl(), send: false }); console.log('알림 발송을 껐어요(시험 모드: 알림·행동을 기록만 남김).') },
	async history() {
		const { listSnapshots } = await import('./records.mjs')
		const names = listSnapshots()
		for (const n of names) console.log(n)
		console.log(names.length ? '\n되돌리기: node src/cli.mjs restore <파일 이름>' : '이전 판 없음 (규칙·메모가 바뀔 때마다 직전 판이 state/history/에 남습니다)')
	},
	async restore() {
		const { readSnapshot } = await import('./records.mjs')
		try { readSnapshot(rest[0] ?? '') } catch (e) { return console.log(`되돌릴 수 없어요: ${e.message}. 'history'로 파일 이름을 확인하세요.`) }
		toInbox({ cmd: 'restore', file: rest[0] })
		console.log(daemonPid() ? '되돌리기 요청을 넣었어요. 지금 판은 state/history/에 남습니다.' : '데몬이 꺼져 있어 요청만 넣어 두었어요.')
	},
	async 'oob-test'() {
		const { sendOob } = await import('./oob.mjs')
		try {
			const sent = await sendOob(loadConfig(), '집 비서 비상 알림 시험', 'HA가 끊겼을 때 이 길로 알려 드려요.', { urgent: false })
			console.log(sent ? '보냈어요.' : 'config.json의 oob.type이 비어 있어요(꺼짐).')
		} catch (e) { console.log(`실패: ${e.message}`) }
	},
	async runs() {
		const { listRuns } = await import('./records.mjs')
		for (const n of listRuns().slice(-(Number(rest[0]) || 20))) console.log(n)
	},
	// 보관해 둔 판단을 지금의 지침(GUIDE.md)으로 다시 물어본다. 결과만 보여주고 아무것도 바꾸지 않는다. AI를 한 번 쓴다.
	// 둘째 인자로 codex나 api를 주면 그 방식으로 묻는다(같은 상황에서 두 방식 견주기).
	async replay() {
		const { listRuns } = await import('./records.mjs')
		const { buildPrompt } = await import('./context.mjs')
		const { runBrain, validateResponse } = await import('./brain.mjs')
		if (rest[1] && !MODES.includes(rest[1])) return console.log(`쓰는 법: replay [이름|latest] [${MODES.join('|')}]`)
		const name = !rest[0] || rest[0] === 'latest' ? listRuns().at(-1) : rest[0]
		const dir = join(P.runs, name ?? '')
		if (!name || !existsSync(join(dir, 'input.json'))) return console.log(`보관된 판단이 없어요: ${rest[0] ?? '(없음)'}. 'runs'로 이름을 확인하세요.`)
		const cfg = loadConfig()
		const mode = rest[1] ?? brainMode(cfg, loadControl()), bs = brainSettings(cfg, mode)
		const problem = selfCheck(cfg, mode)
		if (problem) return console.log(`${mode} 방식을 쓸 수 없어요: ${problem}`)
		// 데몬이 쓰는 brain/run/과 겹치지 않게 replay/ 폴더에서 돌린다.
		rmSync(P.replay, { recursive: true, force: true })
		mkdirSync(join(P.replay, 'run'), { recursive: true })
		if (existsSync(join(dir, 'files'))) cpSync(join(dir, 'files'), join(P.replay, 'run'), { recursive: true })
		const replayAutoCfg = join(P.replay, 'run', 'automation-configs.json')
		if (!existsSync(replayAutoCfg) && existsSync(join(P.run, 'automation-configs.json'))) {
			copyFileSync(join(P.run, 'automation-configs.json'), replayAutoCfg)
		}
		let input = readJson(join(dir, 'input.json'), null)
		if (typeof input === 'string') input = JSON.parse(input) // 예전 보관분은 문자열로 한 번 더 감싸여 있다
		const weekly = input.reasons.some(r => r.type === 'weekly')
		const deep = weekly || input.reasons.some(r => r.type === 'bootstrap' || r.type === 'reflection')
		const pureHourly = !deep && input.reasons.length === 1 && input.reasons[0].type === 'hourly'
		const prompt = buildPrompt({ ...input, guide: readFileSync(P.guide, 'utf8'), infoFiles: [], lastRound: true })
		console.log(`다시 묻는 중: ${name} (${MODE_LABEL[mode]} ${bs.model}, 지금의 GUIDE.md, 추가 자료 요청 없이 한 번)`)
		const r = await runBrain({ cfg, mode, prompt, model: bs.model, effort: deep ? bs.effort_deep : pureHourly ? bs.effort_hourly : bs.effort, timeoutSec: weekly ? cfg.weekly.timeout_seconds : deep ? bs.timeout_deep_seconds : bs.timeout_seconds, brainDir: P.replay, runDir: join(P.replay, 'run') })
		let last = 1
		while (existsSync(join(dir, `answer-${last + 1}.json`))) last++
		const old = readJson(join(dir, `answer-${last}.json`), null)
		console.log('── 그때의 답 ──')
		console.log(JSON.stringify(old && validateResponse(old), null, 1))
		console.log(`── 지금의 답 (${MODE_LABEL[mode]}, ${Math.round(r.ms / 1000)}초, 토큰 ${r.tokens ?? '?'}${r.tool_calls != null ? `, 파일 도구 ${r.tool_calls}번` : ''}) ──`)
		console.log(JSON.stringify(validateResponse(r.result), null, 1))
	},
	doctor() {
		const cfg = loadConfig(), c = loadControl(), rt = readJson(P.runtime, {})
		let errors = 0, warnings = 0
		const ok = msg => console.log(`[OK]   ${msg}`)
		const warn = msg => { warnings++; console.log(`[WARN] ${msg}`) }
		const fail = msg => { errors++; console.log(`[FAIL] ${msg}`) }

		const pid = daemonPid()
		if (pid) ok(`데몬 실행 중 (pid ${pid}, ${c.paused ? '일시정지' : '동작'}, 알림 ${c.send ? '켜짐' : '꺼짐'})`)
		else warn('데몬이 꺼져 있음')

		const cfgRes = validateConfig(cfg)
		if (!cfgRes.errors.length && !cfgRes.warnings.length) ok('config.json 설정 유효')
		for (const e of cfgRes.errors) fail(`설정: ${e}`)
		for (const w of cfgRes.warnings) warn(`설정: ${w}`)

		const mode = brainMode(cfg, c)
		const mainChk = selfCheck(cfg, mode)
		if (mainChk) fail(`주 판단 방식(${mode}): ${mainChk}`)
		else ok(`주 판단 방식(${mode}): 사용 가능 (모델 ${brainSettings(cfg, mode).model})`)
		const other = MODES.find(m => m !== mode)
		const altChk = selfCheck(cfg, other)
		if (altChk) warn(`대체 판단 방식(${other}): ${altChk}`)
		else ok(`대체 판단 방식(${other}): 사용 가능 (모델 ${brainSettings(cfg, other).model})`)

		const checkPerm = (label, filePath, required = false) => {
			if (!filePath) return
			const p = expandHome(filePath)
			if (!existsSync(p)) return required ? fail(`${label} 파일 없음: ${filePath}`) : null
			const modeBits = statSync(p).mode & 0o777
			if (modeBits & 0o077) warn(`${label} 권한 과다 (${modeBits.toString(8)}): chmod 600 ${filePath} 권장`)
			else ok(`${label} 권한 안전 (${modeBits.toString(8)})`)
		}
		checkPerm('HA 토큰', cfg.token_file, true)
		checkPerm('.env', join(ROOT, '.env'), false)
		checkPerm('API 키 파일', cfg.api.key_file, false)
		checkPerm('OOB 토큰 파일', cfg.oob.token_file, false)

		const baks = []
		for (const dir of [ROOT, join(ROOT, 'src'), join(ROOT, 'test'), P.brain]) {
			try {
				for (const f of readdirSync(dir)) if (/\.bak($|-)/.test(f)) baks.push(join(dir, f).replace(ROOT + '/', ''))
			} catch {}
		}
		if (baks.length) warn(`잔여 백업 파일 ${baks.length}개: ${baks.join(', ')}`)
		else ok('잔여 백업 파일 없음')

		if (cfg.oob?.type) ok(`비상 알림 길(oob): ${cfg.oob.type} 설정됨`)
		else warn('비상 알림 길(oob) 꺼짐 (HA 단절 시 외부 알림 없음)')

		if (cfg.heartbeat?.enabled) {
			const beatAgeMin = rt.last_beat_ok ? Math.round((Date.now() - rt.last_beat_ok) / 60000) : null
			if (beatAgeMin == null) warn('heartbeat 전달 기록 없음')
			else if (beatAgeMin > cfg.heartbeat.alert_minutes) warn(`마지막 heartbeat ${beatAgeMin}분 전 (임계 ${cfg.heartbeat.alert_minutes}분 초과)`)
			else ok(`heartbeat 정상 (${beatAgeMin}분 전)`)
		}

		const autos = readJson(join(P.run, 'automations.json'), null)
		if (Array.isArray(autos)) {
			const hb = autos.find(a => (a.watches ?? []).includes('haagent_heartbeat') || a.id === 'automation.jib_biseo_eungdab_eobseum_gyeonggo')
			if (!hb) warn('HA에 heartbeat 응답 없음 경고 자동화 미설치 (ha/heartbeat-automation.yaml 참고)')
			else if (hb.state !== 'on') warn(`HA heartbeat 자동화 꺼짐 (${hb.id})`)
			else ok(`HA heartbeat 자동화 활성 (${hb.id})`)
		}
		const states = readJson(join(P.run, 'states.json'), null)
		if (Array.isArray(states)) {
			const hasSensors = states.some(s => /jib_biseo_yeongyeol|jib_biseo_sangtae|haagent_alive|haagent_status/i.test(s.id))
			if (hasSensors) ok('HA 상태 센서(status-sensors.yaml) 적용됨')
			else warn('HA 상태 센서(ha/status-sensors.yaml) 미적용 — 대시보드 표시·경량 heartbeat 전환 권장')
		}
		console.log(`점검 요약: 오류 ${errors}건, 주의 ${warnings}건`)
		if (errors) process.exitCode = 1
	},
	stats() {
		const days = Math.max(1, Number(rest[0]) || 7)
		const s = rangeStats(days)
		console.log(`=== 최근 ${s.days}일 통계 ===`)
		console.log(`판단: 전체 ${s.total}회 (실행 ${s.real}, 건너뜀 ${s.skipped}, 미룸 ${s.deferred}, 실패 ${s.errors})`)
		console.log(`빈 호출(알림·행동·규칙변경 없음): ${s.noop}회 (${s.noop_pct}%)`)
		console.log(`토큰: 합계 ${s.tokens.toLocaleString()} (성공 회당 평균 ${s.avg_tokens.toLocaleString()})`)
		if (s.usage) console.log(`세부 토큰(API): 입력 ${s.usage.input.toLocaleString()}, 캐시 ${s.usage.cached.toLocaleString()}, 출력 ${s.usage.output.toLocaleString()}, 추론 ${s.usage.reasoning.toLocaleString()}`)
		const brains = Object.entries(s.by_brain).map(([k, v]) => `${k} ${v.runs}회(${v.tokens.toLocaleString()}tok${v.errors ? `, 실패 ${v.errors}` : ''})`)
		if (brains.length) console.log(`방식별: ${brains.join(' | ')}`)
		const reasons = Object.entries(s.by_reason).sort((a, b) => b[1].runs - a[1].runs)
		if (reasons.length) {
			console.log('이유별:')
			for (const [k, v] of reasons) console.log(`  - ${k}: ${v.runs}회 (빈 호출 ${v.noop}회, 토큰 ${v.tokens.toLocaleString()})`)
		}
		console.log(`알림: 경고 ${s.notifications.sent_alerts}, 정보 ${s.notifications.sent_infos}, 요약 ${s.notifications.sent_summaries}, 미발송·기타 ${s.notifications.other}`)
		console.log(`피드백: 도움됐어요 ${s.feedback.up}, 그만 ${s.feedback.mute}, 줄여 줘 ${s.feedback.less}, 답장 ${s.feedback.reply}`)
		console.log(`행동: 실행 ${s.actions.done}, 거절 ${s.actions.declined}, 되돌림 ${s.actions.undone}, 실패 ${s.actions.error}`)
		const rules = readJson(P.rules, null)?.rules ?? [], rt = readJson(P.runtime, { rules: {} }).rules ?? {}, now = Date.now()
		const fired = rules.map(r => [r.id, recentFires(rt[r.id], now).length]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
		if (fired.length) console.log(`규칙 7일 발동: ${fired.map(([id, n]) => `${id}(${n}회)`).join(', ')}`)
	},
	async once() {
		// 데몬과 따로 한 번 판단해 보고 결과만 보여준다(상태 파일·알림은 건드리지 않음).
		if (daemonPid()) { console.log('데몬이 실행 중이라 once는 쓰지 않아요. wake를 쓰세요.'); return }
		const { Agent } = await import('./agent.mjs')
		const a = new Agent({ dry: true })
		a.start()
		await a.waitReady()
		const type = rest[0] ?? 'manual'
		const e = await a.cycle([{ type, reason: rest.slice(1).join(' ') || '시험 판단', text: rest.slice(1).join(' '), hour: kst().h }])
		console.log(JSON.stringify(e, null, 1))
		a.stop()
		process.exit(0)
	},
}

if (!cmds[cmd]) {
	console.log('명령: status | rules | log [n] | notes [YYYY-MM-DD] | actions [n] | memory | stats [일수] | doctor | weekly [list|run|publish|YYYY-MM-DD] | wake [이유] | say <말> | brain [codex|api|default] | pause | resume | send-on | send-off | history | restore <파일> | runs [n] | replay [이름|latest] [codex|api] | oob-test | once [bootstrap|hourly|weekly|manual] [이유]')
	process.exit(cmd ? 1 : 0)
}
await cmds[cmd]()
