// Phase 4 테스트: Kakao OOB(친구·401 토큰 갱신·나에게 보내기·Slack 대체) 및 OpenAI/Gemini 듀얼 AI(codex/api/agy/gemini) 호환성
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DATA = join(tmpdir(), `ha-agent-p4-${process.pid}`)
process.env.HAAGENT_DATA_DIR = DATA
mkdirSync(join(DATA, 'state'), { recursive: true })

const { mergeConfig, validateConfig, saveControl } = await import('../src/config.mjs')
const { P, readEnvFile, writeJson } = await import('../src/util.mjs')
const { sendOob, resolveKakaoConfig, checkOobKakaoConfig, updateEnvFileKeys } = await import('../src/oob.mjs')
const { MODES, brainMode, brainSettings, selfCheck } = await import('../src/brain.mjs')
const { agyArgs, parseAgyOutput, runAgy, resolveAgyModelAndEffort } = await import('../src/llm/providers/agy.mjs')
const { runGemini } = await import('../src/llm/providers/gemini.mjs')
const { LlmRouter } = await import('../src/llm/router.mjs')
const { Agent } = await import('../src/agent.mjs')

const T0 = Date.parse('2026-11-20T12:00:00+09:00')

function cleanTmp() {
	rmSync(DATA, { recursive: true, force: true })
	mkdirSync(join(DATA, 'state'), { recursive: true })
}

test('Kakao OOB: 친구 조회·전송, 401 토큰 갱신 및 .env 원자적 보존, memo/Slack 대체', async () => {
	cleanTmp()
	const envPath = join(DATA, 'reserve.env')
	writeFileSync(
		envPath,
		'# keep comment\nSLACK_BOT_TOKEN=xoxb-keep\nSLACK_CHANNEL_ID=C999\nKAKAO_ACCESS_TOKEN=old-access\nKAKAO_REFRESH_TOKEN=old-refresh\nKAKAO_REST_API_KEY=client-123\nKEEP_OTHER=preserved\n',
		{ mode: 0o600 },
	)

	const cfg = mergeConfig({
		oob: {
			type: 'kakao',
			mode: 'friend',
			recipient_name: '이범훈(알림)',
			fallback_memo: true,
			env_file: envPath,
			token_env: 'KAKAO_ACCESS_TOKEN',
			refresh_token_env: 'KAKAO_REFRESH_TOKEN',
			client_id_env: 'KAKAO_REST_API_KEY',
			fallback: { type: 'slack', env_file: envPath, token_env: 'SLACK_BOT_TOKEN', channel_env: 'SLACK_CHANNEL_ID' },
		},
	})

	assert.deepEqual(validateConfig(cfg).errors, [])
	assert.equal(checkOobKakaoConfig(cfg), null)

	// 1. 첫 호출 401 -> 토큰 갱신 -> 친구 목록 조회 -> 친구 메시지 전송 성공
	const calls = []
	const longMsg = '가'.repeat(230)
	const ok = await sendOob(cfg, '긴급 점검', longMsg, {
		urgent: true,
		fetchFn: async (url, init = {}) => {
			calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body })
			if (url.includes('/v1/api/talk/friends/message/default/send')) {
				const form = new URLSearchParams(init.body)
				const tpl = JSON.parse(form.get('template_object'))
				assert.ok(tpl.text.length <= 200, 'Kakao text 200자 제한 클리핑')
				assert.deepEqual(JSON.parse(form.get('receiver_uuids')), ['uuid-bh'])
				return { ok: true, status: 200, text: async () => JSON.stringify({ successful_receiver_uuids: ['uuid-bh'] }) }
			}
			if (url.includes('/v1/api/talk/friends')) {
				if (init.headers?.authorization === 'Bearer old-access') {
					return { ok: false, status: 401, text: async () => JSON.stringify({ code: -401, msg: 'expired' }) }
				}
				assert.equal(init.headers?.authorization, 'Bearer new-access')
				return { ok: true, status: 200, text: async () => JSON.stringify({ elements: [{ uuid: 'uuid-bh', profile_nickname: '이범훈(알림)' }] }) }
			}
			if (url.includes('kauth.kakao.com/oauth/token')) {
				const form = new URLSearchParams(init.body)
				assert.equal(form.get('grant_type'), 'refresh_token')
				assert.equal(form.get('client_id'), 'client-123')
				assert.equal(form.get('refresh_token'), 'old-refresh')
				return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }) }
			}
			throw new Error(`unexpected url: ${url}`)
		},
	})
	assert.equal(ok, true)
	assert.equal(calls.length, 4)

	const updatedEnv = readEnvFile(envPath)
	assert.equal(updatedEnv.KAKAO_ACCESS_TOKEN, 'new-access')
	assert.equal(updatedEnv.KAKAO_REFRESH_TOKEN, 'new-refresh')
	assert.equal(updatedEnv.SLACK_BOT_TOKEN, 'xoxb-keep', '다른 키 보존')
	assert.equal(updatedEnv.KEEP_OTHER, 'preserved')
	assert.ok(readFileSync(envPath, 'utf8').includes('# keep comment'), '주석 보존')
	assert.equal(statSync(envPath).mode & 0o777, 0o600, '권한 0600 유지')

	// 2. 친구 전송 실패 시 memo 대체 전송
	const hitEndpoints = []
	await sendOob(cfg, '테스트', '본문', {
		urgent: false,
		fetchFn: async url => {
			hitEndpoints.push(url)
			if (url.includes('/v1/api/talk/friends')) return { ok: false, status: 403, text: async () => '{"code":-5,"msg":"no scope"}' }
			if (url.includes('/v2/api/talk/memo/default/send')) return { ok: true, status: 200, text: async () => '{"result_code":0}' }
			throw new Error(`unexpected url: ${url}`)
		},
	})
	assert.ok(hitEndpoints.some(u => u.includes('/v2/api/talk/memo/default/send')))

	// 3. Kakao 모두 실패 시 Slack 대체 OOB 발송
	const slackHits = []
	await sendOob(cfg, '이중장애', '내용', {
		fetchFn: async (url, init) => {
			slackHits.push(url)
			if (url.includes('kapi.kakao.com')) return { ok: false, status: 500, text: async () => '{"msg":"err"}' }
			if (url.includes('slack.com/api/chat.postMessage')) {
				const b = JSON.parse(init.body)
				assert.equal(b.channel, 'C999')
				return { ok: true, status: 200, json: async () => ({ ok: true }) }
			}
			throw new Error(`unexpected url: ${url}`)
		},
	})
	assert.ok(slackHits.some(u => u.includes('slack.com/api/chat.postMessage')))

	// updateEnvFileKeys 누락/빈값 검증
	assert.equal(updateEnvFileKeys(envPath, {}), false)
	assert.equal(resolveKakaoConfig(mergeConfig({ oob: { type: 'kakao' } })).tokenEnv, 'KAKAO_ACCESS_TOKEN')
})

test('Antigravity CLI (agy) 어댑터: 인자·사용량 파싱·90KB 초과 파일 프롬프트·환경변수 비밀 차단', async () => {
	cleanTmp()
	const binDir = join(DATA, 'bin')
	const brainDir = join(DATA, 'brain')
	const runDir = join(brainDir, 'run')
	mkdirSync(binDir, { recursive: true })
	mkdirSync(runDir, { recursive: true })

	const fakeBin = join(binDir, 'agy')
	writeFileSync(
		fakeBin,
		`#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const args = process.argv.slice(2)
const pArg = args.find(a => a.startsWith('-p=')) ?? ''
const leaked = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'SLACK_BOT_TOKEN', 'KAKAO_ACCESS_TOKEN'].filter(k => process.env[k])
const refMatch = /run\\/agy-prompt-\\d+\\.md/.exec(pArg)
const promptLen = refMatch ? readFileSync(refMatch[0], 'utf8').length : pArg.length
console.log(JSON.stringify({
	status: 'SUCCESS',
	structured_output: { summary: 'ok', leaked, args, promptLen, usedFile: Boolean(refMatch) },
	usage: { input_tokens: 100, cache_read_tokens: 40, output_tokens: 20, thinking_tokens: 5, total_tokens: 125 },
}))
`,
		{ mode: 0o755 },
	)
	chmodSync(fakeBin, 0o755)
	const schemaPath = join(brainDir, 'schema.json')
	writeFileSync(schemaPath, JSON.stringify({ type: 'object' }))

	const argsPreview = agyArgs({ cfg: mergeConfig({}), model: 'gemini-3.8-flash-medium', effort: 'high', timeoutSec: 180, schema: schemaPath, promptArg: 'hello' })
	assert.ok(argsPreview.includes('--sandbox'))
	assert.ok(argsPreview.includes('--disable-slash-commands'))
	assert.ok(argsPreview.includes('-p=hello'))
	assert.equal(argsPreview[argsPreview.indexOf('--model') + 1], 'gemini-3.8-flash')
	assert.equal(argsPreview[argsPreview.indexOf('--effort') + 1], 'high')
	assert.deepEqual(resolveAgyModelAndEffort('gemini-4-hydrogen-medium', null), { model: 'gemini-4-hydrogen', effort: 'medium' })
	assert.deepEqual(resolveAgyModelAndEffort('gemini-4-hydrogen', 'max'), { model: 'gemini-4-hydrogen', effort: 'high' })
	assert.deepEqual(resolveAgyModelAndEffort('gemini-4-hydrogen', 'minimal'), { model: 'gemini-4-hydrogen', effort: 'low' })

	const parsed = parseAgyOutput(JSON.stringify({
		status: 'SUCCESS',
		response: '```json\n{"summary":"ok"}\n```',
		usage: { input_tokens: 10, cache_read_tokens: 2, output_tokens: 4, thinking_tokens: 1 },
	}))
	assert.deepEqual(parsed.result, { summary: 'ok' })
	assert.deepEqual(parsed.usage, { input: 10, cached: 2, output: 4, reasoning: 1 })
	assert.equal(parsed.tokens, 15)

	const prevSecrets = {
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		GEMINI_API_KEY: process.env.GEMINI_API_KEY,
		SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
		KAKAO_ACCESS_TOKEN: process.env.KAKAO_ACCESS_TOKEN,
	}
	process.env.OPENAI_API_KEY = 'secret-oa'
	process.env.GEMINI_API_KEY = 'secret-gem'
	process.env.SLACK_BOT_TOKEN = 'secret-slack'
	process.env.KAKAO_ACCESS_TOKEN = 'secret-kakao'

	try {
		const cfg = mergeConfig({ agy: { bin: fakeBin, model: 'gemini-3.8-flash-medium' } })
		assert.equal(selfCheck(cfg, 'agy'), null)

		// > 90KB UTF-8 한국어 프롬프트 전달 시 파일 우회
		const bigPrompt = '가'.repeat(35000) // ~105KB UTF-8
		const res = await runAgy({ cfg, prompt: bigPrompt, effort: 'low', timeoutSec: 30, brainDir, runDir, schema: schemaPath })
		assert.equal(res.result.usedFile, true)
		assert.equal(res.result.promptLen, 35000)
		assert.deepEqual(res.result.leaked, [], '자식 환경변수에서 모든 API/OOB 키 제거')
		assert.equal(res.tokens, 125)
	} finally {
		for (const [k, v] of Object.entries(prevSecrets)) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
	}
})

test('Gemini Interactions API 어댑터: response_format·step_list·도구 루프·429 재시도·usage 집계', async () => {
	cleanTmp()
	const brainDir = join(DATA, 'brain')
	const runDir = join(brainDir, 'run')
	mkdirSync(runDir, { recursive: true })
	writeFileSync(join(runDir, 'note.txt'), '라인1\n거실 온도 23도\n라인3\n')
	const schemaPath = join(brainDir, 'schema.json')
	writeFileSync(schemaPath, JSON.stringify({
		type: 'object',
		additionalProperties: false,
		required: ['summary', 'tag'],
		properties: { summary: { type: 'string' }, tag: { type: ['string', 'null'] } },
	}))

	const cfg = mergeConfig({ gemini: { key_env: 'TEST_GEMINI_P4_KEY', model: 'gemini-2.5-flash' } })
	const prev = process.env.TEST_GEMINI_P4_KEY
	process.env.TEST_GEMINI_P4_KEY = 'test-gem-key'
	try {
		let attempt = 0
		const bodies = []
		const urls = []
		const broker = {
			tools: () => [{ name: 'ha_ping', description: 'ping', parameters: { type: 'object', properties: {}, required: [] } }],
			has: name => name === 'ha_ping',
			run: async () => 'ha_pong',
		}
		const res = await runGemini({
			cfg,
			prompt: '확인해',
			brainDir,
			runDir,
			schema: schemaPath,
			toolBroker: broker,
			fetchFn: async (url, init) => {
				attempt++
				if (attempt === 1) {
					return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), text: async () => '{"error":{"message":"rate limit"}}' }
				}
				urls.push(url)
				const reqBody = JSON.parse(init.body)
				bodies.push(reqBody)
				if (attempt === 2) {
					return {
						ok: true,
						status: 200,
						text: async () => JSON.stringify({
							status: 'requires_action',
							usage: { total_input_tokens: 50, total_cached_tokens: 10, total_output_tokens: 8, total_thought_tokens: 4, total_tokens: 62 },
							steps: [
								{ type: 'thought', signature: 'sig-1' },
								{ type: 'function_call', id: 'fc_read_1', name: 'read_file', arguments: { path: 'run/note.txt', start_line: 2, end_line: 2 } },
							],
						}),
					}
				}
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({
						status: 'completed',
						usage: { total_input_tokens: 70, total_cached_tokens: 10, total_output_tokens: 12, total_thought_tokens: 3, total_tokens: 85 },
						steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ summary: '온도 확인', tag: null }) }] }],
					}),
				}
			},
		})
		assert.equal(attempt, 3)
		assert.ok(urls[0].endsWith('/v1beta/interactions'), 'Interactions API 엔드포인트 사용')
		assert.equal(bodies[0].store, false)
		assert.ok(bodies[0].response_format, 'response_format 사용')
		assert.equal(bodies[0].generation_config, undefined, 'gemini-2.5에는 thinking_level 미첨부')
		assert.ok(bodies[0].tools.some(t => t.type === 'function' && t.name === 'read_file' && t.parameters), '파일 도구 parameters 포함')
		assert.ok(bodies[0].tools.some(t => t.type === 'function' && t.name === 'ha_ping' && t.parameters), 'ToolBroker 도구 포함')
		assert.equal(bodies[1].input[0].type, 'user_input')
		assert.equal(bodies[1].input[1].type, 'thought')
		assert.equal(bodies[1].input[2].type, 'function_call')
		assert.equal(bodies[1].input[3].type, 'function_result')
		assert.equal(bodies[1].input[3].call_id, 'fc_read_1')
		assert.match(bodies[1].input[3].result, /거실 온도 23도/)
		assert.deepEqual(res.result, { summary: '온도 확인', tag: null })
		assert.deepEqual(res.usage, { input: 120, cached: 20, output: 20, reasoning: 7 })
		assert.equal(res.tokens, 147)

		// gemini-4-hydrogen 및 CLI 접미사 모델 정규화 + thinking_level 검증
		const seenReqs = []
		const fakeResp = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"summary":"ok","tag":null}' }] }] }) })
		await runGemini({
			cfg: mergeConfig({ gemini: { key_env: 'TEST_GEMINI_P4_KEY', model: 'gemini-4-hydrogen', effort: 'medium' } }),
			prompt: '확인', brainDir, runDir, schema: schemaPath,
			fetchFn: async (u, i) => { seenReqs.push({ u, b: JSON.parse(i.body) }); return fakeResp() },
		})
		assert.ok(seenReqs[0].u.endsWith('/v1beta/interactions'))
		assert.equal(seenReqs[0].b.model, 'gemini-4-hydrogen')
		assert.equal(seenReqs[0].b.generation_config.thinking_level, 'medium')

		await runGemini({
			cfg, model: 'gemini-4-hydrogen-low',
			prompt: '확인', brainDir, runDir, schema: schemaPath,
			fetchFn: async (u, i) => { seenReqs.push({ u, b: JSON.parse(i.body) }); return fakeResp() },
		})
		assert.equal(seenReqs[1].b.model, 'gemini-4-hydrogen', 'CLI 접미사 제거 정규화')
		assert.equal(seenReqs[1].b.generation_config.thinking_level, 'low')

		await runGemini({
			cfg, model: 'gemini-2.5-flash', effort: 'medium',
			prompt: '확인', brainDir, runDir, schema: schemaPath,
			fetchFn: async (u, i) => { seenReqs.push({ u, b: JSON.parse(i.body) }); return fakeResp() },
		})
		assert.equal(seenReqs[2].b.model, 'gemini-2.5-flash')
		assert.equal(seenReqs[2].b.generation_config, undefined, 'gemini-2.5에는 thinking_level 미첨부')
	} finally {
		if (prev === undefined) delete process.env.TEST_GEMINI_P4_KEY
		else process.env.TEST_GEMINI_P4_KEY = prev
	}
})

test('4모드(codex/api/agy/gemini) 설정 상속, 쌍 기반 failover, Assist gemini 라우팅', async () => {
	cleanTmp()
	assert.deepEqual(MODES, ['codex', 'api', 'agy', 'gemini'])

	const cfg = mergeConfig({
		brain: 'antigravity',
		agy: { model: 'gemini-4-hydrogen-medium', effort: 'high', effort_hourly: 'low', effort_deep: 'high', timeout_seconds: 180 },
		gemini: { key_env: 'TEST_GEMINI_P4_KEY', model: 'gemini-2.5-pro' },
		llm: { routes: { assist: 'gemini-api', default: 'agy' } },
		assist: { model: 'gemini-4-hydrogen', effort: 'low' },
	})
	assert.equal(cfg.brain, 'agy')
	assert.equal(brainMode(cfg, { brain: 'gemini-api' }), 'gemini')
	assert.equal(brainMode(cfg, { brain: 'openai' }), 'api')
	assert.equal(validateConfig(cfg).errors.length, 0)

	const gemS = brainSettings(cfg, 'gemini')
	assert.equal(gemS.model, 'gemini-2.5-pro')
	assert.equal(gemS.effort, 'high', 'gemini 미지정 effort는 agy에서 상속')
	assert.equal(gemS.timeout_seconds, 180)

	const gemDefaultModel = brainSettings(mergeConfig({ agy: { model: 'gemini-4-hydrogen-medium' } }), 'gemini')
	assert.equal(gemDefaultModel.model, 'gemini-4-hydrogen', 'CLI 전용 모델명이 Gemini REST API로 잘못 내려가지 않음')

	const router = new LlmRouter({ cfg, canUse: (_c, m) => m === 'gemini' || m === 'agy' })
	assert.equal(router.resolveMode({ task: 'assist' }), 'gemini')

	// Agent failover: agy -> gemini (2회 연속 실패 후 쌍 전환)
	writeJson(P.control, { paused: false, send: true })
	const seen = []
	const fakeHa = {
		connected: true,
		sent: [],
		on() {},
		async call(type) { return type === 'get_states' ? [] : {} },
		async callService(d, _s, { data }) { if (d === 'notify') this.sent.push(data) },
		async heartbeat() {},
	}
	const agent = new Agent({
		cfg,
		ha: fakeHa,
		clock: () => T0,
		canUse: () => true,
		brain: async a => {
			seen.push({ mode: a.mode, model: a.model, effort: a.effort })
			if (a.mode === 'agy') throw new Error('agy 일시 오류')
			return {
				result: a.customSchema
					? { speech: '제미니로 답했어요.', continue_conversation: false }
					: { summary: '제미니 정상', notifications: [], rule_changes: { upsert: [], delete: [] }, next_wakes: [], memory: { mode: 'keep', text: '' }, memory_ops: [], report: '', info_requests: [] },
				ms: 5,
				tokens: 42,
			}
		},
	})
	await agent.cycle([{ type: 'manual', reason: '테스트' }])
	await agent.cycle([{ type: 'manual', reason: '테스트' }])
	const e3 = await agent.cycle([{ type: 'manual', reason: '테스트' }])
	assert.deepEqual(seen.map(x => x.mode), ['agy', 'agy', 'gemini'])
	assert.deepEqual([e3.brain, e3.failover, e3.error], ['gemini', true, undefined])
	assert.match(fakeHa.sent[0].message, /Antigravity CLI 판단이 2번 연속 실패해 Gemini API.*요금/)

	// handleAssist가 routes.assist='gemini' 및 assist.model/effort('gemini-4-hydrogen', 'low')로 직접 라우팅
	const aRes = await agent.handleAssist({ text: '거실 온도 어때?' })
	assert.equal(aRes.speech, '제미니로 답했어요.')
	assert.deepEqual(seen.at(-1), { mode: 'gemini', model: 'gemini-4-hydrogen', effort: 'low' })

	cleanTmp()
})
