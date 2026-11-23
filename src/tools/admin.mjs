// Tool Broker 관리/메모리 도구: Tier 2 HA 관리 제안 생성, 사용자 명시 승인/거절/롤백 처리, 구조화 기억 갱신
export function adminTools() {
	return [
		{
			name: 'ha_propose_admin',
			description: '자동화/스크립트 생성·수정·삭제, 통합 리로드, 백업 생성, 엔티티 정리, 규칙 승격을 검증·Diff와 함께 Tier 2 승인 제안으로 등록한다',
			properties: {
				kind: {
					type: 'string',
					enum: ['automation_upsert', 'automation_delete', 'automation_toggle', 'script_upsert', 'script_delete', 'reload_config_entry', 'backup_create', 'entity_admin', 'promote_rule'],
					description: '관리 제안 종류',
				},
				target_id: { type: 'string', description: '대상 entity_id, entry_id 또는 rule_id' },
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
			description: '사용자의 선호·지시사항·장애 이력·패턴을 구조화 장기 기억에 저장하거나 갱신한다',
			properties: {
				category: { type: 'string', enum: ['preference', 'standing_order', 'incident', 'pattern', 'rejection'], description: '기억 분류' },
				key: { type: 'string', description: '고유 키(영문·숫자·밑줄)' },
				content: { type: 'string', description: '기억할 내용(한국어)' },
			},
			async run(ctx, a) {
				if (!ctx.memory) return '메모리 모듈이 없음'
				const res = ctx.memory.applyOps([{ op: 'upsert', category: a.category, key: a.key, content: a.content }], { source: ctx.source ?? 'tool' })
				return JSON.stringify(res)
			},
		},
		{
			name: 'memory_delete',
			description: '더 이상 유효하지 않은 구조화 장기 기억 항목을 삭제한다',
			properties: {
				key: { type: 'string', description: '삭제할 기억 키' },
			},
			async run(ctx, a) {
				if (!ctx.memory) return '메모리 모듈이 없음'
				const res = ctx.memory.applyOps([{ op: 'delete', key: a.key }], { source: ctx.source ?? 'tool' })
				return JSON.stringify(res)
			},
		},
	]
}
