// 비상 알림 길: HA나 HA로 가는 연결이 끊겨 휴대폰 알림을 보낼 수 없을 때 쓰는 HA 밖의 통로.
// config.json의 oob.type을 정해야 동작한다(기본은 꺼짐). 토큰은 파일에서 읽는다.
import { readFileSync } from 'node:fs'
import { expandHome } from './util.mjs'

const secret = f => (f ? readFileSync(expandHome(f), 'utf8').trim() : null)

async function post(url, body, headers = {}) {
	const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
	if (!r.ok) throw new Error(`HTTP ${r.status}`)
}

// 보냈으면 true, 꺼져 있으면 false. 실패하면 던진다.
export async function sendOob(cfg, title, message, { urgent = true } = {}) {
	const o = cfg.oob ?? {}
	if (!o.type) return false
	if (o.type === 'ntfy') {
		const token = secret(o.token_file)
		await post(o.url ?? 'https://ntfy.sh', { topic: o.topic, title, message, priority: urgent ? 5 : 3 }, token ? { authorization: `Bearer ${token}` } : {})
	} else if (o.type === 'telegram') {
		await post(`https://api.telegram.org/bot${secret(o.token_file)}/sendMessage`, { chat_id: o.chat_id, text: `${title}\n${message}` })
	} else if (o.type === 'webhook') {
		await post(o.url, { title, message, urgent })
	} else throw new Error(`알 수 없는 oob.type: ${o.type}`)
	return true
}
