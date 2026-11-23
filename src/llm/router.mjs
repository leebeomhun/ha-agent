// 다중 LLM 프로바이더 라우터 (작업 유형별 모델/프로바이더 분배)
import { runBrain, selfCheck, brainMode, normalizeMode } from '../brain.mjs'
import { runAnthropic, anthropicKey } from './providers/anthropic.mjs'
import { runOllama } from './providers/ollama.mjs'

export const ALL_PROVIDERS = ['codex', 'api', 'agy', 'gemini', 'anthropic', 'ollama']

export class LlmRouter {
	constructor({ cfg, brainFn = runBrain, canUse = null } = {}) {
		this.cfg = cfg
		this.brainFn = brainFn
		this.canUse = canUse ?? ((c, m) => !selfCheck(c, m))
	}

	canUseProvider(provider, cfg = this.cfg) {
		const p = normalizeMode(provider)
		if (['codex', 'api', 'agy', 'gemini'].includes(p)) return this.canUse(cfg, p)
		if (p === 'anthropic') { try { anthropicKey(cfg); return true } catch { return false } }
		if (p === 'ollama') return Boolean(cfg.llm?.ollama?.base_url && cfg.llm?.ollama?.model)
		return false
	}

	resolveMode({ task = 'default', control = {}, cfg = this.cfg } = {}) {
		const routes = cfg.llm?.routes ?? {}
		const raw = routes[task] ?? routes.default ?? null
		const candidate = raw ? normalizeMode(raw) : null
		if (candidate && ALL_PROVIDERS.includes(candidate) && this.canUseProvider(candidate, cfg)) {
			return candidate
		}
		return brainMode(cfg, control)
	}

	async run(args) {
		const mode = normalizeMode(args.mode ?? this.resolveMode(args))
		if (mode === 'anthropic') return runAnthropic(args)
		if (mode === 'ollama') return runOllama(args)
		return this.brainFn({ ...args, mode })
	}
}
