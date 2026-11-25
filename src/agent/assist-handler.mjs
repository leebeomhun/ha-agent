// HA Assist 실시간 대화 및 음성(STT/TTS) 처리기
import { readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runBrain, brainSettings, normalizeMode } from '../brain.mjs'
import { loadControl } from '../config.mjs'
import { buildDirectory, buildAssistInstructions, buildDynamicContext, withDynamicContext, matchFastCommand, controlSpeech, wantsDeep, modelFitsProvider, claimsUnexecutedControl, DEFAULT_DEEP_KEYWORDS } from '../orchestrator/assist-context.mjs'
import { hasMemorySignal, extractMemoryFromTurn } from '../core/memory-extractor.mjs'
import { cleanSpeechForTts, isWavBuffer, pcmToWav, parsePcmParams, wavStats, MAX_STT_VOCAB } from '../voice/gemini-voice.mjs'
import { P, kst, log } from '../util.mjs'

const iso = ms => new Date(ms).toISOString()
const dbText = v => (v == null ? '?' : Number.isFinite(v) ? `${v}dBFS` : '무음')
// STT 로그용 오디오 요약: "2.8초 최대 -12dBFS 평균 -38dBFS 소리 0.9초 87KB"
const describeAudio = (bytes, s) => [
	s ? `${(s.durationMs / 1000).toFixed(1)}초` : null,
	s?.peakDbfs !== undefined && s?.peakDbfs !== null ? `최대 ${dbText(s.peakDbfs)} 평균 ${dbText(s.rmsDbfs)} 소리 ${(s.activeMs / 1000).toFixed(1)}초` : null,
	`${Math.round(bytes / 1024)}KB`,
].filter(Boolean).join(' ')
const EP_REASON = { silence: '말 끝', max: '상한', no_speech: '말 없음', stream_end: 'HA VAD' }
// HA STT 컴포넌트의 말 끝 감지 요약: "말 끝 2.5초(시작 0.9초, 앞 0.4초부터 보냄) 바닥 -60dB 배경 -37dB 말 -17dB"
const describeEndpoint = e => [
	`${EP_REASON[e.reason] ?? e.reason} ${((e.cut_ms ?? 0) / 1000).toFixed(1)}초`,
	e.start_ms ? `(시작 ${(e.start_ms / 1000).toFixed(1)}초${e.keep_ms ? `, ${(e.keep_ms / 1000).toFixed(1)}초부터 보냄` : ''})` : null,
	Number.isFinite(e.noise_db) ? `바닥 ${e.noise_db}dB` : null,
	Number.isFinite(e.bg_db) ? `배경 ${e.bg_db}dB` : null,
	Number.isFinite(e.speech_db) ? `말 ${e.speech_db}dB` : null,
].filter(Boolean).join(' ')
const audioExt = mime => (/wav|pcm|l16/i.test(mime) ? 'wav' : /ogg/i.test(mime) ? 'ogg' : /webm/i.test(mime) ? 'webm' : /mp4|m4a|aac/i.test(mime) ? 'm4a' : 'bin')

const ASSIST_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['speech', 'continue_conversation'],
	properties: {
		speech: { type: 'string' },
		continue_conversation: { type: 'boolean' },
	},
}

export class AssistHandler {
	constructor(agent) {
		this.agent = agent
		this.lastExtractPromise = null
	}

	#schedulePostTurnExtract({ text, speech, usedMode, usedModel, now }) {
		const ag = this.agent
		if (ag.dry || !ag.store || ag.cfg.memory?.post_turn_extract === false) return
		if (!hasMemorySignal(text)) return
		const existingKeys = ag.memoryMgr.list(null, { now }).map(m => m.key)
		const p = extractMemoryFromTurn({
			text,
			assistantText: speech,
			now,
			cfg: ag.cfg,
			llmRouter: ag.brain === runBrain ? ag.llmRouter : null,
			existingKeys,
			mode: usedMode,
			model: usedModel,
		}).then(ops => {
			if (!ops?.length) return []
			const res = ag.memoryMgr.applyOps(ops, { source: 'extractor', now })
			if (res.upserted.length) log(`Post-Turn 기억 자동 저장: ${res.upserted.join(', ')}`)
			return res.upserted
		}).catch(e => {
			log('Post-Turn 기억 추출 실패:', e.message)
			return []
		})
		this.lastExtractPromise = p
	}

	voiceHints() {
		const a = this.agent
		const base = Array.isArray(a.cfg.assist?.voice?.stt_hints) ? a.cfg.assist.voice.stt_hints : []
		const out = [...base]
		for (const id of a.tiers.keys()) {
			const area = a.meta.areaOf?.get(id)
			if (area) out.push(area)
			const name = a.states.get(id)?.attributes?.friendly_name
			if (name) out.push(name)
		}
		return [...new Set(out.map(s => String(s ?? '').trim()).filter(Boolean))].slice(0, MAX_STT_VOCAB)
	}

	async handleStt({ audioBuffer, mimeType = 'audio/wav', language = 'ko', endpoint = null }) {
		const a = this.agent
		const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer ?? [])
		const wrapped = /pcm|l16/i.test(mimeType) && !isWavBuffer(buf)
		const wav = wrapped ? pcmToWav(buf, parsePcmParams(mimeType)) : buf
		const sendMime = wrapped ? 'audio/wav' : mimeType
		const stats = wavStats(wav)
		const hints = this.voiceHints()
		let res = await a.sttFn({
			cfg: a.cfg,
			audioBuffer: wav,
			mimeType: sendMime,
			language,
			hints,
		})
		let text = String(res.text ?? '')
		const v = a.cfg.assist?.voice ?? {}
		const fallbackModel = String(v.stt_fallback_model ?? '').trim()
		const primaryModel = String(res.model ?? v.stt_model ?? '').trim()
		// 분명한 말소리가 있었는데 전사 전용 모델이 빈 값을 낸 경우 일반 멀티모달 모델로 1회 폴백한다.
		if (!text.trim() && stats && stats.activeMs >= 160 && stats.peakDbfs > -32 && fallbackModel && fallbackModel !== primaryModel) {
			try {
				const fbRes = await a.sttFn({
					cfg: a.cfg,
					audioBuffer: wav,
					mimeType: sendMime,
					language,
					hints,
					model: fallbackModel,
				})
				if (String(fbRes.text ?? '').trim()) {
					res = fbRes
					text = String(fbRes.text ?? '')
					log(`Assist STT 폴백 성공 (${primaryModel} → ${res.model}, ${res.ms}ms): "${text.slice(0, 120)}"`)
				}
			} catch (e) {
				log(`Assist STT 폴백 실패 (${fallbackModel}):`, e.message)
			}
		}
		log(`Assist STT (${res.model}, ${res.ms}ms, ${describeAudio(buf.length, stats)}${endpoint ? `, ${describeEndpoint(endpoint)}` : ''}): "${text.slice(0, 120)}"`)
		// 빈 결과이거나, 말 끝을 못 잡고 상한·무음 시간에 끊긴 오디오는 조정용으로 남긴다.
		if (!text.trim() || ['max', 'no_speech'].includes(endpoint?.reason)) {
			this.saveSttFailure({ audio: wav, mimeType: sendMime, language, stats, res, endpoint, text })
		}
		return { text, language, model: res.model, ms: res.ms }
	}

	// 빈 결과가 난 오디오를 state/stt-failures/에 최근 N개만 남긴다(로컬 전용). 나중에 다른 설정으로 다시 돌려 원인을 가린다.
	saveSttFailure({ audio, mimeType, language, stats, res, endpoint = null, text = '' }) {
		const a = this.agent
		const keep = Math.max(0, Math.floor(Number(a.cfg.assist?.voice?.stt_debug_keep ?? 20)) || 0)
		if (a.dry || !keep) return
		try {
			const dir = P.sttFailures
			mkdirSync(dir, { recursive: true, mode: 0o700 })
			const now = a.clock()
			// 이름순 = 시간순이 되게: 20261120-173603-123-0001 (같은 밀리초면 순번으로 구분)
			a.sttFailSeq = ((a.sttFailSeq ?? 0) + 1) % 10000
			const base = `${kst(new Date(now)).iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${String(now % 1000).padStart(3, '0')}-${String(a.sttFailSeq).padStart(4, '0')}`
			writeFileSync(join(dir, `${base}.${audioExt(mimeType)}`), audio, { mode: 0o600 })
			writeFileSync(join(dir, `${base}.json`), JSON.stringify({
				ts: iso(now), mime_type: mimeType, language, bytes: audio.length, stats, endpoint, text: text || null,
				model: res.model ?? null, ms: res.ms ?? null, usage: res.usage ?? null,
			}, null, 2) + '\n', { mode: 0o600 })
			const bases = [...new Set(readdirSync(dir).map(f => f.replace(/\.[^.]+$/, '')))].sort()
			for (const old of bases.slice(0, Math.max(0, bases.length - keep))) {
				for (const f of readdirSync(dir).filter(f => f.startsWith(`${old}.`))) rmSync(join(dir, f), { force: true })
			}
		} catch (e) {
			log('STT 실패 오디오 저장 실패:', e.message)
		}
	}

	async handleTts({ text, language = null, voice = null }) {
		const a = this.agent
		const v = a.cfg.assist?.voice ?? {}
		const cleaned = cleanSpeechForTts(text)
		if (!cleaned) throw new Error('TTS로 변환할 텍스트가 비어 있음')
		const lang = language ?? v.tts_language ?? 'ko-KR'
		const voiceName = voice ?? v.tts_voice ?? 'Kore'
		const model = v.tts_model ?? 'gemini-3.8-flash-lite-tts'
		const cacheKey = `${model}|${lang}|${voiceName}|${cleaned}`
		const maxCache = Math.max(0, Number(v.tts_cache_max ?? 32))
		if (maxCache > 0 && a.ttsCache.has(cacheKey)) {
			const hit = a.ttsCache.get(cacheKey)
			a.ttsCache.delete(cacheKey)
			a.ttsCache.set(cacheKey, hit)
			log(`Assist TTS 캐시 적중 (${hit.model}, ${hit.audio.length}B)`)
			return { ...hit, ms: 0, cached: true }
		}
		const res = await a.ttsFn({ cfg: a.cfg, text: cleaned, language: lang, voice: voiceName, model })
		if (maxCache > 0) {
			a.ttsCache.set(cacheKey, res)
			while (a.ttsCache.size > maxCache) {
				const oldest = a.ttsCache.keys().next().value
				a.ttsCache.delete(oldest)
			}
		}
		log(`Assist TTS (${res.model}, ${res.ms}ms, ${res.audio.length}B)`)
		return { ...res, cached: false }
	}

	async handleAssist({ text, conversationId = null, language = 'ko', deviceId = null, userId = null, channel = 'ha_assist' }) {
		const a = this.agent
		const sid = a.sessions.ensure(conversationId, { channel, metadata: { language, deviceId, userId } })
		const prev = a.sessionLocks.get(sid) ?? Promise.resolve()
		let release
		const mine = new Promise(r => { release = r })
		const chain = prev.then(() => mine, () => mine)
		a.sessionLocks.set(sid, chain)
		await prev
		try {
			return await this.runAssistTurn({ sid, text, language, channel })
		} finally {
			release()
			if (a.sessionLocks.get(sid) === chain) a.sessionLocks.delete(sid)
		}
	}

	// Assist 준비: 방·엔티티 분류 정보를 강제로 새로 받는다(벤치마크·진단용).
	async prepareAssist() { await this.agent.refreshMeta(this.agent.clock(), true) }

	// 제어 가능 기기·센서·차단 기기 목록과 빠른 경로 색인(벤치마크에서도 쓴다)
	assistDirectory() {
		const a = this.agent
		const as = a.cfg.assist ?? {}
		return buildDirectory({
			policy: a.policy, states: a.states, areaOf: a.meta.areaOf, catOf: a.meta.catOf,
			aliases: as.aliases ?? {}, isNoise: a.isNoise, scriptFields: a.meta.scriptFields,
			...(Array.isArray(as.sensor_classes) ? { sensorClasses: as.sensor_classes } : {}),
			maxSensors: as.max_sensors ?? 20,
		})
	}

	// 단계(fast/deep)별 프로바이더·모델·노력. 모델 이름이 프로바이더와 안 맞으면(예: api 라우트에 gemini 모델) 무시하고 프로바이더 기본값을 쓴다.
	assistPlan(mode, model, effort, tier) {
		const a = this.agent
		const known = ['codex', 'api', 'agy', 'gemini'].includes(mode)
		const bs = brainSettings(a.cfg, known ? mode : 'api')
		const providerDefault = known ? bs.model : (a.cfg.llm?.[mode]?.model ?? null)
		let m = model ?? null, e = effort ?? null
		if (m && !modelFitsProvider(m, mode)) {
			const key = `${tier}|${mode}|${m}`
			if (!a.assistWarned.has(key)) {
				a.assistWarned.add(key)
				log(`Assist ${tier} 모델 ${m}은 ${mode} 프로바이더 모델이 아니라서 무시하고 ${providerDefault ?? '기본값'}을 씀 (config.json assist 확인)`)
			}
			m = null
			e = null
		}
		return { tier, mode, model: m ?? providerDefault, effort: m ? e : (e ?? bs.effort) }
	}

	// 이번 말에 쓸 단계 순서. 복잡한 요청은 deep만, 그 밖에는 fast를 먼저 쓰고 실패하면 deep으로 한 번 더.
	assistPlans(text) {
		const a = this.agent
		const as = a.cfg.assist ?? {}
		const fastMode = a.llmRouter.resolveMode({ task: 'assist', control: a.control })
		const fast = this.assistPlan(fastMode, as.model, as.effort, 'fast')
		const d = as.deep ?? {}
		if (!d.model) return [fast]
		const deepRoute = d.route ? normalizeMode(d.route) : null
		const deepMode = deepRoute && a.llmRouter.canUseProvider(deepRoute) ? deepRoute : fastMode
		const deep = this.assistPlan(deepMode, d.model, d.effort, 'deep')
		if (deep.mode === fast.mode && deep.model === fast.model && deep.effort === fast.effort) return [fast]
		return wantsDeep(text, Array.isArray(d.keywords) ? d.keywords : DEFAULT_DEEP_KEYWORDS) ? [deep] : [fast, deep]
	}

	recordAssistDecision(dec) {
		const a = this.agent
		if (a.dry) return
		a.lastAssist = dec
		a.journal.decision(dec)
	}

	async runAssistTurn({ sid, text, language, channel }) {
		const ag = this.agent
		const now = ag.clock()
		const a = ag.cfg.assist ?? {}
		ag.control = loadControl()
		if (ag.control.paused) {
			return { conversation_id: sid, speech: '지금은 집 비서가 일시정지 중이에요. 재개한 뒤 다시 말씀해 주세요.', continue_conversation: false, actions: [], proposals: [], ms: 0 }
		}
		const prevUserMsgs = ag.sessions.history(sid, now).filter(m => m.role === 'user')
		ag.sessions.append(sid, 'user', text, { channel }, now)
		const exec = ag.assistControl ?? ((req, opts) => ag.actionExecutor.executeControlItem(req, opts))
		const dir = this.assistDirectory()

		// 1) 로컬 빠른 경로: "주방 불 켜줘" 같은 단순 켜기/끄기는 LLM 없이 정책 게이트만 거쳐 바로 실행
		const fast = a.fast_path === false ? null : matchFastCommand(text, dir.index)
		if (fast) {
			const r = await exec({ entity_id: fast.entity_id, action: fast.service, service_data: {}, reason: `Assist 직접 요청: ${text.slice(0, 60)}`, requested: true }, { byUser: true })
			const speech = controlSpeech(fast.label, fast.service, r)
			const ms = ag.clock() - now
			ag.sessions.append(sid, 'assistant', speech, { mode: 'local' }, ag.clock())
			ag.implicitFeedback?.onAssistTurn({ text, speech, prevUserMsgs, actions: [r], now })
			log(`Assist 빠른 경로 (${ms}ms): "${text.slice(0, 60)}" → ${fast.entity_id} ${fast.service} = ${r.status}${r.error ? ` (${r.error})` : ''}`)
			this.recordAssistDecision({ ts: iso(now), reasons: ['assist'], brain: 'local', model: null, path: 'fast', total_ms: ms, tokens: 0, usage: null, rounds: 0, tool_calls: 0, summary: speech.slice(0, 200), applied: { actions: [r.status], proposals: [] } })
			return { conversation_id: sid, speech, continue_conversation: false, actions: [r], proposals: [], ms, meta: { path: 'fast', tier: null, mode: 'local', model: null, rounds: 0, tool_calls: 0, tokens: 0 } }
		}

		if (ag.overLimit([{ type: 'user' }])) {
			return { conversation_id: sid, speech: '오늘 판단 한도를 모두 사용해서 지금은 답하기 어려워요. 내일 다시 말씀해 주세요.', continue_conversation: false, actions: [], proposals: [], ms: 0 }
		}

		const plans = this.assistPlans(text)
		if (['codex', 'agy'].includes(plans[0].mode) && ag.brain === runBrain) {
			// CLI 샌드박스 방식(codex/agy)은 직렬화된 cycle 경로로 처리(cycle 내부에서 카운터 증가)
			const entry = await ag.runCycleSerialized([{ type: 'user', text, about: 'HA Assist', urgent: true, at: now }])
			const speech = entry.error
				? `죄송해요, 처리 중 오류가 났어요: ${entry.error}`
				: (entry.summary || '확인하고 처리했어요.')
			ag.sessions.append(sid, 'assistant', speech, { mode: plans[0].mode }, ag.clock())
			return { conversation_id: sid, speech, continue_conversation: false, actions: entry.applied?.actions ?? [], proposals: entry.applied?.proposals ?? [], ms: ag.clock() - now }
		}
		if (!ag.dry) ag.bump('runs')

		// 2) LLM 경로: 고정 지시(캐시)와 매번 바뀌는 상황(마지막 사용자 메시지 앞)을 나눠 보낸다.
		const pendingProps = ag.haAdmin.listProposals({ status: 'pending', limit: 10 })
		const aoId = ag.cfg.away_override_entity
		const earlyFinish = a.early_finish !== false
		const sysInstr = buildAssistInstructions({
			policyDesc: ag.policy.describe(),
			directoryText: dir.staticText,
			profile: ag.memoryMgr.loadHomeProfile(),
			memory: await ag.memoryMgr.renderForPromptAsync(2500, { contextText: text, now, touch: !ag.dry }),
			lessons: ag.memoryMgr.renderLessons('assist', 900, { now, touch: !ag.dry }),
			earlyFinish,
		})
		const dynamic = buildDynamicContext({
			now, language, aoId, aoState: aoId ? ag.states.get(aoId)?.state : null, pendingProps, directoryDynamic: dir.dynamicText,
		})
		const promptMsgs = withDynamicContext(ag.sessions.history(sid, now), dynamic)
		const turnActions = [], turnProposals = []
		let roundCtl = [], turnMemoryMutated = false
		const toolCtx = {
			allowDirectRequest: true,
			adminEnabled: Boolean(ag.cfg.policy?.admin_enabled),
			source: channel,
			memorySource: 'assist_user',
			onMemoryMutated: () => { turnMemoryMutated = true },
			executeControl: async (req, opts) => {
				const r = await exec(req, opts)
				turnActions.push(r)
				roundCtl.push({ r, req })
				return r
			},
			proposeAdmin: async req => {
				const r = await ag.createAndNotifyProposal(req)
				if (r.ok) turnProposals.push(r.proposal.pid)
				return r
			},
			// 프로바이더가 도구 한 차례를 마칠 때마다 부른다. 제어만 했고 다 성공했으면 마지막 답을 받으러 다시 왕복하지 않는다.
			takeEarlyResult: names => {
				const got = roundCtl
				roundCtl = []
				if (!earlyFinish || !names.length || got.length !== names.length || names.some(n => n !== 'ha_control_device')) return null
				const speech = String(got.at(-1).req?.speech_if_success ?? '').trim()
				if (speech && got.every(g => g.r?.status === 'done')) return { speech, continue_conversation: false }
				const only = got.length === 1 ? got[0] : null
				const service = only?.req?.action ?? only?.req?.service
				if (only?.r?.status === 'noop' && (service === 'turn_on' || service === 'turn_off')) {
					return { speech: controlSpeech(dir.labels.get(only.req.entity_id) ?? only.req.entity_id, service, only.r), continue_conversation: false }
				}
				return null
			},
		}

		const started = ag.clock()
		const budgetSec = a.timeout_seconds ?? 90
		let r = null, used = null, lastErr = null, hadUnexecutedClaim = false, fellBack = false
		for (const [i, plan] of plans.entries()) {
			const left = Math.max(5, budgetSec - Math.round((ag.clock() - started) / 1000))
			const timeoutSec = i === 0 && plans.length > 1 ? Math.min(a.fast_timeout_seconds ?? 30, left) : left
			roundCtl = []
			try {
				const out = await ag.llmRouter.run({
					cfg: ag.cfg,
					mode: plan.mode,
					prompt: promptMsgs,
					effort: plan.effort,
					timeoutSec,
					model: plan.model,
					runDir: null,
					toolBroker: ag.toolBroker,
					toolContext: toolCtx,
					instructions: sysInstr,
					customSchema: ASSIST_SCHEMA,
					includeFileTools: false,
				})
				if (claimsUnexecutedControl(text, out.result?.speech, turnActions.length)) {
					hadUnexecutedClaim = true
					throw new Error(`도구 호출 없이 제어했다고 답함: "${String(out.result?.speech ?? '').slice(0, 60)}"`)
				}
				r = out
				used = plan
				if (i > 0) fellBack = true
				break
			} catch (e) {
				lastErr = e
				log(`Assist ${plan.tier} 단계 실패 (${plan.mode}/${plan.model}): ${e.message}`)
				// 이미 기기를 움직였거나 제안을 만들었으면 다른 모델로 다시 돌리지 않는다(중복 실행 방지).
				if (turnActions.length || turnProposals.length) break
			}
		}

		const elapsedMs = ag.clock() - started
		if (!r) {
			const speech = /^도구 호출 없이/.test(lastErr?.message ?? '')
				? '죄송해요, 제어 명령이 실제로 실행되지 않았어요. 한 번만 다시 말씀해 주세요.'
				: `죄송해요, 요청을 처리하지 못했어요: ${lastErr?.message ?? '알 수 없는 오류'}`
			ag.sessions.append(sid, 'assistant', speech, { error: lastErr?.message }, ag.clock())
			ag.implicitFeedback?.onAssistTurn({ text, speech, prevUserMsgs, hadUnexecutedClaim, fellBack: true, actions: turnActions, now })
			return { conversation_id: sid, speech, continue_conversation: false, actions: turnActions, proposals: turnProposals, ms: elapsedMs, meta: { path: 'error', tier: plans.at(-1).tier, mode: plans.at(-1).mode, model: plans.at(-1).model } }
		}
		const speech = String(r.result?.speech ?? '처리했어요.').trim()
		const cont = Boolean(r.result?.continue_conversation)
		const path = r.early ? 'early' : 'llm'
		ag.sessions.append(sid, 'assistant', speech, { mode: used.mode, tokens: r.tokens }, ag.clock())
		ag.implicitFeedback?.onAssistTurn({ text, speech, prevUserMsgs, hadUnexecutedClaim, fellBack, actions: turnActions, now })
		if (!turnMemoryMutated) {
			this.#schedulePostTurnExtract({ text, speech, usedMode: used.mode, usedModel: used.model, now })
		}
		this.recordAssistDecision({
			ts: iso(started), reasons: ['assist'], brain: used.mode, model: used.model, effort: used.effort, tier: used.tier, path,
			total_ms: elapsedMs, rounds: r.rounds ?? null, tool_calls: r.tool_calls ?? null, tokens: r.tokens ?? null, usage: r.usage ?? null,
			summary: speech.slice(0, 200), applied: { actions: turnActions.map(x => x.status), proposals: turnProposals },
		})
		log(`Assist ${used.tier} (${used.mode}/${used.model}, ${elapsedMs}ms, 왕복 ${r.rounds ?? '?'}회, 도구 ${r.tool_calls ?? '?'}회${r.early ? ', 조기 종료' : ''})`)
		return {
			conversation_id: sid, speech, continue_conversation: cont, actions: turnActions, proposals: turnProposals, ms: elapsedMs,
			meta: { path, tier: used.tier, mode: used.mode, model: used.model, effort: used.effort, rounds: r.rounds ?? null, tool_calls: r.tool_calls ?? null, tokens: r.tokens ?? null, usage: r.usage ?? null },
		}
	}
}
