// 멈춤 감시: 주 루프가 오래 신호를 주지 않으면(멈춤·무한 대기) 프로세스를 끝낸다. systemd(Restart=always)가 다시 띄운다.
// 주 루프와 따로 도는 worker라서 주 루프가 막혀 있어도 동작한다.
import { Worker } from 'node:worker_threads'

const CODE = `
const { workerData: d } = require('node:worker_threads')
const fs = require('node:fs')
const a = new BigInt64Array(d.buf)
setInterval(() => {
	const age = Date.now() - Number(Atomics.load(a, 0))
	if (age <= d.limitMs) return
	try { fs.writeSync(2, '[watchdog] 주 루프가 ' + Math.round(age / 1000) + '초째 멈춰 있어 프로세스를 끝냅니다\\n') } catch {}
	process.kill(d.pid, 'SIGKILL')
}, d.checkMs)
`

// 돌려주는 함수를 주기적으로 불러 살아 있음을 알린다.
export function startWatchdog(limitMs, checkMs = 5000) {
	const buf = new SharedArrayBuffer(8)
	const a = new BigInt64Array(buf)
	const beat = () => { Atomics.store(a, 0, BigInt(Date.now())) }
	beat()
	// execArgv를 비워 둔다: 부모의 실행 옵션(--input-type 등)을 물려받으면 위 코드가 다른 방식으로 읽혀 깨질 수 있다.
	const w = new Worker(CODE, { eval: true, execArgv: [], workerData: { buf, limitMs, checkMs, pid: process.pid } })
	w.on('error', e => console.error('[watchdog] 감시 worker 오류:', e.message))
	w.unref()
	return beat
}
