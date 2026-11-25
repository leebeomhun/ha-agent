// Tool Broker 관리/메모리 도구: Tier 2 HA 관리 제안 생성, 사용자 명시 승인/거절/롤백 처리, 구조화 기억 갱신

// 기억 도구가 남길 출처. Assist 대화는 memorySource('assist_user')를 넘겨, LLM이 해석한 요청이
// 고정·사용자 등록 기억을 바꾸지 못하게 한다(src/core/store.mjs의 memoryWriteBlock).
const memorySourceOf = ctx => ctx.memorySource ?? (ctx.allowDirectRequest ? 'user' : (ctx.source ?? 'tool'))

export function adminTools() {
	return [
		{
			name: 'ha_propose_admin',
			description: '자동화/스크립트 생성·수정·삭제, 통합 리로드, 백업 생성, 엔티티 정리, 규칙 승격, 자가 튜닝(별칭·소음·STT·교훈)을 검증·Diff와 함께 Tier 2 승인 제안으로 등록한다',
			properties: {
				kind: {
					type: 'string',
					enum: [
						'automation_upsert', 'automation_delete', 'automation_toggle', 'script_upsert', 'script_delete',
						'reload_config_entry', 'backup_create', 'entity_admin', 'promote_rule',
						'self_alias_proposal', 'self_noise_proposal', 'self_stt_tune', 'self_lesson_proposal',
					],
					description: '관리 또는 자가개선 제안 종류',
				},
				target_id: { type: 'string', description: '대상 entity_id, entry_id, rule_id 또는 lesson key' },
				title: { type: 'string', description: '제안 제목(한국어)' },
				summary: { type: 'string', description: '변경 이유와 영향 요약(한국어)' },
				payload_json: { type: ['string', 'null'], description: '변경 설정 JSON 문자열. 없으면 null' },
			},
			async run(ctx, a) {
				if (!ctx.proposeAdmin) return '관리 제안 모듈이 연결되지 않음'
				let payload = null
				if (a.payload_json) {
					try { payload = JSON.parse(a.payload_json) } catch { return '오류: payload_json이 유효한 JSON이 아님' }
				}
				const res = await ctx.proposeAdmin({ kind: a.kind, target_id: a.target_id, title: a.title, summary: a.summary, payload })
				return JSON.stringify(res)
			},
		},
		{
			name: 'ha_proposal_action',
			description: '사용자가 대화(Assist/답장)에서 명시적으로 지시한 대기 제안 승인·거절·롤백을 처리한다',
			properties: {
				pid: { type: 'string', description: '제안 ID (예: p...)' },
				decision: { type: 'string', enum: ['approve', 'reject', 'rollback'], description: '처리 종류' },
			},
			async run(ctx, a) {
				if (!ctx.allowDirectRequest) return '오류: 제안 승인·거절·롤백은 사용자와의 직접 대화에서만 실행할 수 있다'
				if (!ctx.handleProposalDecision) return '제안 처리기가 연결되지 않음'
				const res = await ctx.handleProposalDecision(a.pid, a.decision)
				return JSON.stringify(res)
			},
		},
		{
			name: 'memory_upsert',
			description: '사용자의 선호·지시사항·장애 이력·패턴·임시 부재 일정을 구조화 장기 기억에 저장하거나 갱신한다',
			properties: {
				category: { type: 'string', enum: ['preference', 'standing_order', 'incident', 'pattern', 'rejection'], description: '기억 분류' },
				key: { type: 'string', description: '고유 키(영문·숫자·밑줄)' },
				content: { type: 'string', description: '기억할 내용(한국어)' },
				ttl_days: { type: ['integer', 'null'], description: '만료 일수(임시 부재·사건 등). 무기한 또는 카테고리 기본값이면 null' },
				confidence: { type: ['number', 'null'], description: '확신도 0~1. null이면 1.0' },
				pinned: { type: ['boolean', 'null'], description: '영구 고정 여부. 사용자가 "고정해"처럼 분명히 요청했을 때만 true. 그 밖에는 null(기존 유지)' },
				entity_ids: { type: ['array', 'null'], items: { type: 'string' }, description: '연관 HA entity_id 목록. 없으면 null' },
			},
			async run(ctx, a) {
				if (!ctx.memory) return '메모리 모듈이 없음'
				const src = memorySourceOf(ctx)
				const res = ctx.memory.applyOps([{
					op: 'upsert',
					category: a.category,
					key: a.key,
					content: a.content,
					...(a.ttl_days !== undefined ? { ttl_days: a.ttl_days } : {}),
					...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
					...(a.pinned !== undefined ? { pinned: a.pinned } : {}),
					...(a.entity_ids !== undefined ? { entity_ids: a.entity_ids } : {}),
				}], { source: src })
				if (ctx.onMemoryMutated) try { ctx.onMemoryMutated(res) } catch {}
				return JSON.stringify(res)
			},
		},
		{
			name: 'memory_delete',
			description: '더 이상 유효하지 않은 구조화 장기 기억 항목을 삭제한다. 고정됐거나 사용자가 콘솔·CLI로 등록한 기억은 지울 수 없으니, 그때는 웹 콘솔(메모리 관리)에서 지우도록 안내한다',
			properties: {
				key: { type: 'string', description: '삭제할 기억 키' },
			},
			async run(ctx, a) {
				if (!ctx.memory) return '메모리 모듈이 없음'
				const src = memorySourceOf(ctx)
				const res = ctx.memory.applyOps([{ op: 'delete', key: a.key }], { source: src })
				return JSON.stringify(res)
			},
		},
	]
}
