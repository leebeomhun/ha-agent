// 데몬 진입점 (systemd 사용자 서비스 ha-agent.service가 실행)
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { Agent } from './agent.mjs'
import { selfCheck, brainMode, brainSettings } from './brain.mjs'
import { startWatchdog } from './watchdog.mjs'
import { loadConfig } from './config.mjs'
import { P, log } from './util.mjs'

mkdirSync(P.inbox, { recursive: true })
writeFileSync(P.pid, String(process.pid))
const cfg = loadConfig()
// 주 루프(15초마다 tick)가 오래 멈추면 프로세스를 끝내 systemd가 다시 띄우게 한다.
const beat = cfg.watchdog_minutes > 0 ? startWatchdog(cfg.watchdog_minutes * 60000) : undefined
const agent = new Agent({ cfg, beat })
const bye = sig => {
	log(`종료 신호 ${sig}`)
	try { unlinkSync(P.pid) } catch {}
	agent.stop()
	process.exit(0)
}
process.on('SIGTERM', () => bye('SIGTERM'))
process.on('SIGINT', () => bye('SIGINT'))
log(`집 비서 시작 (알림 발송 ${agent.control.send ? '켜짐' : '꺼짐(시험 모드)'}, ${agent.control.paused ? '일시정지 중' : '동작 중'}, 행동 ${agent.tiers.size ? `${agent.tiers.size}개 엔티티` : '꺼짐'}, 대기열 ${agent.queue.length}건)`)
const mode = brainMode(cfg, agent.control)
log(`판단 방식: ${mode} (모델 ${brainSettings(cfg, mode).model})`)
const problem = selfCheck(cfg, mode)
if (problem) {
	log('시작 점검 실패:', problem)
	agent.startupProblem = problem
}
agent.start()
