// 비상 알림 길: HA나 HA로 가는 연결이 끊겨 휴대폰 알림을 보낼 수 없을 때 쓰는 HA 밖의 통로.
// config.json의 oob.type을 정해야 동작한다(기본은 꺼짐). 토큰은 파일 또는 .env에서 읽는다.
import { readFileSync, writeFileSync, renameSync, chmodSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { expandHome, readEnvFile, newId } from './util.mjs'

const secret = f => (f ? readFileSync(expandHome(f), 'utf8').trim() : null)

const KAKAO_OAUTH_URL = 'https://kauth.kakao.com/oauth/token'
const KAKAO_FRIENDS_URL = 'https://kapi.kakao.com/v1/api/talk/friends'
const KAKAO_FRIEND_SEND_URL = 'https://kapi.kakao.com/v1/api/talk/friends/message/default/send'
const KAKAO_MEMO_SEND_URL = 'https://kapi.kakao.com/v2/api/talk/memo/default/send'

function clipKakaoText(text) {
	const s = String(text ?? '').trim()
	return s.length > 200 ? `${s.slice(0, 197)}...` : s
}

async function post(url, body, headers = {}, fetchFn = fetch) {
	const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
	if (!r.ok) throw new Error(`HTTP ${r.status}`)
	return r
}

async function kakaoRequest(url, { method = 'GET', token = null, form = null, fetchFn = fetch } = {}) {
	const headers = {}
	if (token) headers.authorization = `Bearer ${token}`
	let body
	if (form) {
		headers['content-type'] = 'application/x-www-form-urlencoded;charset=utf-8'
		body = new URLSearchParams(form).toString()
	}
	const r = await fetchFn(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(10000) })
	const raw = await r.text().catch(() => '')
	let data = null
	try { data = raw ? JSON.parse(raw) : null } catch {}
	return { ok: r.ok, status: r.status, data, raw }
}

function formatKakaoError(prefix, res) {
	const code = res?.data?.code
	const msg = res?.data?.msg ?? res?.data?.error_description ?? res?.data?.error
	const detail = [code !== undefined ? `code=${code}` : null, msg ? String(msg).slice(0, 120) : null].filter(Boolean).join(' ')
	return `${prefix}: HTTP ${res?.status ?? '?'}${detail ? ` (${detail})` : ''}`
}

const LOCK_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))

function tryOpenLock(lockPath, staleMs) {
	for (;;) {
		try {
			const fd = openSync(lockPath, 'wx', 0o600)
			try { writeFileSync(fd, `${process.pid}\n`) } catch {}
			return () => {
				try { closeSync(fd) } catch {}
				try { unlinkSync(lockPath) } catch {}
			}
		} catch (e) {
			if (e.code !== 'EEXIST') throw e
			try {
				const st = statSync(lockPath)
				if (Date.now() - st.mtimeMs > staleMs) {
					try { unlinkSync(lockPath) } catch {}
					continue
				}
			} catch (stErr) {
				if (stErr.code === 'ENOENT') continue
			}
			return null
		}
	}
}

function acquireFileLockSync(filePath, { timeoutMs = 5000, staleMs = 15000 } = {}) {
	const lockPath = `${expandHome(filePath)}.lock`
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const release = tryOpenLock(lockPath, staleMs)
		if (release) return release
		if (Date.now() >= deadline) throw new Error(`파일 락 시간 초과: ${lockPath}`)
		Atomics.wait(LOCK_SLEEP_BUF, 0, 0, 40)
	}
}

export async function withFileLock(filePath, fn, { timeoutMs = 5000, staleMs = 15000 } = {}) {
	const lockPath = `${expandHome(filePath)}.lock`
	const deadline = Date.now() + timeoutMs
	let release = null
	for (;;) {
		release = tryOpenLock(lockPath, staleMs)
		if (release) break
		if (Date.now() >= deadline) throw new Error(`파일 락 시간 초과: ${lockPath}`)
		await new Promise(r => setTimeout(r, 40))
	}
	try {
		return await fn()
	} finally {
		release()
	}
}

// .env 파일의 특정 키만 기존 주석·다른 키·권한(0600)을 보존한 채 원자적으로 갱신한다.
export function updateEnvFileKeys(filePath, updates = {}, { locked = false } = {}) {
	const entries = Object.entries(updates).filter(([, v]) => v !== undefined && v !== null)
	if (!entries.length) return false
	const target = expandHome(filePath)
	const release = locked ? null : acquireFileLockSync(target)
	try {
		let existing = ''
		let mode = 0o600
		try {
			existing = readFileSync(target, 'utf8')
			mode = (statSync(target).mode & 0o777) || 0o600
		} catch {}
		const eol = existing.includes('\r\n') ? '\r\n' : '\n'
		const lines = existing ? existing.split(/\r?\n/) : []
		if (lines.length && lines[lines.length - 1] === '') lines.pop()
		const map = new Map(entries)
		const seen = new Set()
		const fmt = v => `'${String(v).replace(/\r?\n/g, '').replace(/'/g, '')}'`
		const next = lines.map(line => {
			const m = /^(\s*(?:export\s+)?)([A-Za-z_]\w*)(\s*=\s*)(.*)$/.exec(line)
			if (m && map.has(m[2])) {
				seen.add(m[2])
				return `${m[1]}${m[2]}${m[3]}${fmt(map.get(m[2]))}`
			}
			return line
		})
		for (const [k, v] of entries) {
			if (!seen.has(k)) next.push(`${k}=${fmt(v)}`)
		}
		const tmp = `${target}.${process.pid}.${newId()}.tmp`
		writeFileSync(tmp, `${next.join(eol)}${eol}`, { mode })
		chmodSync(tmp, mode)
		renameSync(tmp, target)
		return true
	} finally {
		release?.()
	}
}

export function resolveSlackConfig(cfg, { env = process.env } = {}) {
	const o = cfg?.oob ?? {}
	const tokenEnv = o.token_env && !o.token_env.startsWith('KAKAO_') ? o.token_env : 'SLACK_BOT_TOKEN'
	const channelEnv = o.channel_env || 'SLACK_CHANNEL_ID'
	const envMap = o.env_file ? readEnvFile(o.env_file) : {}
	const token = (o.token_file ? secret(o.token_file) : null) || env[tokenEnv]?.trim() || envMap[tokenEnv]?.trim() || null
	const channel = o.channel_id?.trim() || env[channelEnv]?.trim() || envMap[channelEnv]?.trim() || null
	return { token, channel, tokenEnv, channelEnv, envFile: o.env_file ?? null }
}

export function resolveKakaoConfig(cfg, { env = process.env } = {}) {
	const o = cfg?.oob ?? {}
	const tokenEnv = o.token_env && o.token_env !== 'SLACK_BOT_TOKEN' ? o.token_env : 'KAKAO_ACCESS_TOKEN'
	const refreshEnv = o.refresh_token_env || 'KAKAO_REFRESH_TOKEN'
	const clientIdEnv = o.client_id_env || 'KAKAO_REST_API_KEY'
	const clientSecretEnv = o.client_secret_env || 'KAKAO_CLIENT_SECRET'
	const envFile = o.env_file ? expandHome(o.env_file) : null
	const envMap = envFile ? readEnvFile(envFile) : {}
	const pick = (fileVal, k) => fileVal || envMap[k]?.trim() || env[k]?.trim() || null
	const accessToken = pick(o.token_file ? secret(o.token_file) : null, tokenEnv)
	const refreshToken = pick(null, refreshEnv)
	const clientId = pick(null, clientIdEnv)
	const clientSecret = pick(null, clientSecretEnv)
	const recipientName = o.recipient_name?.trim() || null
	const recipientUuid = o.recipient_uuid?.trim() || null
	const mode = o.mode ?? (recipientUuid || recipientName ? 'friend' : 'memo')
	return {
		accessToken,
		refreshToken,
		clientId,
		clientSecret,
		tokenEnv,
		refreshEnv,
		clientIdEnv,
		envFile,
		mode,
		recipientName,
		recipientUuid,
		fallbackMemo: o.fallback_memo !== false,
	}
}

export function checkOobSlackConfig(cfg, opts) {
	try {
		const s = resolveSlackConfig(cfg, opts)
		if (!s.token) return `Slack 토큰 없음 (${s.tokenEnv})`
		if (!s.channel) return `Slack 채널 없음 (${s.channelEnv})`
		return null
	} catch (e) {
		return `Slack 설정 오류: ${e.message}`
	}
}

export function checkOobKakaoConfig(cfg, opts) {
	try {
		const k = resolveKakaoConfig(cfg, opts)
		if (!k.accessToken && !(k.refreshToken && k.clientId)) return `Kakao 토큰 없음 (${k.tokenEnv})`
		if (k.mode === 'friend' && !k.recipientUuid && !k.recipientName) return 'Kakao 친구 수신자(recipient_name 또는 recipient_uuid) 없음'
		return null
	} catch (e) {
		return `Kakao 설정 오류: ${e.message}`
	}
}

export async function refreshKakaoToken(kCfg, { fetchFn = fetch, failedToken = null } = {}) {
	const doRefresh = async () => {
		if (kCfg.envFile) {
			const latest = readEnvFile(kCfg.envFile)
			const latestAccess = latest[kCfg.tokenEnv]?.trim()
			const latestRefresh = latest[kCfg.refreshEnv]?.trim()
			if (latestRefresh) kCfg.refreshToken = latestRefresh
			if (latestAccess && failedToken && latestAccess !== failedToken) {
				kCfg.accessToken = latestAccess
				return { accessToken: kCfg.accessToken, refreshToken: kCfg.refreshToken }
			}
		}
		if (!kCfg.refreshToken || !kCfg.clientId) throw new Error('Kakao 토큰 갱신 정보 없음 (refresh_token/client_id)')
		const form = {
			grant_type: 'refresh_token',
			client_id: kCfg.clientId,
			refresh_token: kCfg.refreshToken,
			...(kCfg.clientSecret ? { client_secret: kCfg.clientSecret } : {}),
		}
		const res = await kakaoRequest(KAKAO_OAUTH_URL, { method: 'POST', form, fetchFn })
		if (!res.ok || !res.data?.access_token) throw new Error(formatKakaoError('Kakao 토큰 갱신 실패', res))
		kCfg.accessToken = res.data.access_token
		if (res.data.refresh_token) kCfg.refreshToken = res.data.refresh_token
		if (kCfg.envFile) {
			updateEnvFileKeys(kCfg.envFile, {
				[kCfg.tokenEnv]: kCfg.accessToken,
				...(res.data.refresh_token ? { [kCfg.refreshEnv]: kCfg.refreshToken } : {}),
			}, { locked: true })
		}
		return { accessToken: kCfg.accessToken, refreshToken: kCfg.refreshToken }
	}
	if (kCfg.envFile) return withFileLock(kCfg.envFile, doRefresh)
	return doRefresh()
}

async function withKakaoAuth(kCfg, fetchFn, fn) {
	if (!kCfg.accessToken) await refreshKakaoToken(kCfg, { fetchFn })
	const triedToken = kCfg.accessToken
	let res = await fn(triedToken)
	if (res.status === 401 || res.data?.code === -401) {
		await refreshKakaoToken(kCfg, { fetchFn, failedToken: triedToken })
		res = await fn(kCfg.accessToken)
	}
	return res
}

function buildKakaoTemplate(title, message, urgent) {
	const text = clipKakaoText(`${urgent ? '🚨 ' : ''}${title}\n${message}`)
	return JSON.stringify({
		object_type: 'text',
		text,
		link: { web_url: '', mobile_web_url: '' },
		button_title: '자세히 보기',
	})
}

async function resolveKakaoFriendUuid(kCfg, fetchFn) {
	if (kCfg.recipientUuid) return kCfg.recipientUuid
	if (!kCfg.recipientName) throw new Error('Kakao 친구 수신자(recipient_name)가 비어 있음')
	const res = await withKakaoAuth(kCfg, fetchFn, token => kakaoRequest(KAKAO_FRIENDS_URL, { token, fetchFn }))
	if (!res.ok) throw new Error(formatKakaoError('Kakao 친구 목록 조회 실패', res))
	const list = Array.isArray(res.data?.elements) ? res.data.elements : []
	const target = kCfg.recipientName.trim()
	const hit = list.find(e => String(e?.profile_nickname ?? '').trim() === target)
	if (!hit?.uuid) throw new Error(`Kakao 친구를 찾지 못함 (${target})`)
	return hit.uuid
}

async function sendKakaoFriend(kCfg, templateJson, fetchFn) {
	const uuid = await resolveKakaoFriendUuid(kCfg, fetchFn)
	const res = await withKakaoAuth(kCfg, fetchFn, token => kakaoRequest(KAKAO_FRIEND_SEND_URL, {
		method: 'POST',
		token,
		form: { receiver_uuids: JSON.stringify([uuid]), template_object: templateJson },
		fetchFn,
	}))
	if (!res.ok) throw new Error(formatKakaoError('Kakao 친구 메시지 전송 실패', res))
	const okList = res.data?.successful_receiver_uuids
	if (Array.isArray(okList) && !okList.length) throw new Error('Kakao 친구 메시지 전송 결과 수신자 0건')
}

async function sendKakaoMemo(kCfg, templateJson, fetchFn) {
	const res = await withKakaoAuth(kCfg, fetchFn, token => kakaoRequest(KAKAO_MEMO_SEND_URL, {
		method: 'POST',
		token,
		form: { template_object: templateJson },
		fetchFn,
	}))
	if (!res.ok || (res.data?.result_code !== undefined && res.data.result_code !== 0)) {
		throw new Error(formatKakaoError('Kakao 나에게 보내기 실패', res))
	}
}

async function sendKakao(cfg, title, message, { urgent = true, fetchFn = fetch, env = process.env } = {}) {
	const kCfg = resolveKakaoConfig(cfg, { env })
	if (!kCfg.accessToken && !(kCfg.refreshToken && kCfg.clientId)) throw new Error('Kakao 토큰을 찾지 못함')
	const templateJson = buildKakaoTemplate(title, message, urgent)
	if (kCfg.mode === 'memo') {
		await sendKakaoMemo(kCfg, templateJson, fetchFn)
		return
	}
	try {
		await sendKakaoFriend(kCfg, templateJson, fetchFn)
	} catch (friendErr) {
		if (!kCfg.fallbackMemo) throw friendErr
		try {
			await sendKakaoMemo(kCfg, templateJson, fetchFn)
		} catch (memoErr) {
			throw new Error(`${friendErr.message}; memo 대체도 실패: ${memoErr.message}`)
		}
	}
}

async function dispatchOob(cfg, title, message, { urgent = true, fetchFn = fetch, env = process.env } = {}) {
	const o = cfg.oob ?? {}
	if (o.type === 'ntfy') {
		const token = secret(o.token_file)
		await post(o.url ?? 'https://ntfy.sh', { topic: o.topic, title, message, priority: urgent ? 5 : 3 }, token ? { authorization: `Bearer ${token}` } : {}, fetchFn)
	} else if (o.type === 'telegram') {
		await post(`https://api.telegram.org/bot${secret(o.token_file)}/sendMessage`, { chat_id: o.chat_id, text: `${title}\n${message}` }, {}, fetchFn)
	} else if (o.type === 'slack') {
		const { token, channel } = resolveSlackConfig(cfg, { env })
		if (!token) throw new Error('Slack 토큰을 찾지 못함')
		if (!channel) throw new Error('Slack 채널 ID를 찾지 못함')
		const text = `${urgent ? '🚨 ' : ''}${title}\n${message}`
		const res = await post('https://slack.com/api/chat.postMessage', { channel, text }, { authorization: `Bearer ${token}` }, fetchFn)
		const body = await res.json().catch(() => null)
		if (!body?.ok) throw new Error(`Slack API 오류: ${body?.error ?? 'invalid_response'}`)
	} else if (o.type === 'kakao') {
		await sendKakao(cfg, title, message, { urgent, fetchFn, env })
	} else if (o.type === 'webhook') {
		await post(o.url, { title, message, urgent }, {}, fetchFn)
	} else throw new Error(`알 수 없는 oob.type: ${o.type}`)
}

// 보냈으면 true, 꺼져 있으면 false. 실패하면 fallback을 시도하고, 모두 실패하면 던진다.
export async function sendOob(cfg, title, message, opts = {}) {
	const o = cfg?.oob ?? {}
	if (!o.type) return false
	try {
		await dispatchOob(cfg, title, message, opts)
		return true
	} catch (primaryErr) {
		if (!o.fallback?.type || opts._isFallback) throw primaryErr
		try {
			await dispatchOob({ ...cfg, oob: o.fallback }, title, message, { ...opts, _isFallback: true })
			return true
		} catch (fbErr) {
			throw new Error(`${primaryErr.message} (대체 ${o.fallback.type} 실패: ${fbErr.message})`)
		}
	}
}
