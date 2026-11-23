// Tool Broker 제어 도구: PolicyEngine 검사 후 Tier 1 즉시 실행(스냅샷 Undo) 또는 Tier 2 승인 요청
export function controlTools() {
	return [
		{
			name: 'ha_control_device',
			description: '허용된 HA 기기를 제어한다(밝기/온도/속도/옵션 등 파라미터 포함). Tier 1 또는 사용자 직접 지시는 즉시 실행하고, Tier 2는 승인 알림을 보낸다. Tier 3는 차단된다.',
			properties: {
				entity_id: { type: 'string', description: '대상 엔티티 ID' },
				service: { type: 'string', description: '서비스 이름(turn_on, turn_off, set_percentage, select_option 등)' },
				service_data_json: { type: ['string', 'null'], description: '파라미터 JSON 문자열(예: {"option":"turbo"}). 없으면 null' },
				reason: { type: 'string', description: '사용자에게 보여줄 제어 이유(한국어)' },
				requested: { type: ['boolean', 'null'], description: '사용자가 이번 대화에서 직접 요청한 제어이면 true, 자율 판단이면 false' },
				speech_if_success: { type: ['string', 'null'], description: 'Assist 대화에서 제어가 성공하면 사용자에게 바로 들려줄 짧은 한국어 문장(예: "주방 불을 켰어요."). 대화가 아니면 null' },
			},
			async run(ctx, a) {
				if (!ctx.executeControl) return '제어 실행기가 연결되지 않음'
				let data = {}
				if (a.service_data_json) {
					try { data = JSON.parse(a.service_data_json) } catch { return '오류: service_data_json이 유효한 JSON이 아님' }
				}
				const direct = Boolean(ctx.allowDirectRequest && a.requested === true)
				const res = await ctx.executeControl({
					entity_id: a.entity_id,
					action: a.service,
					service_data: data,
					reason: a.reason,
					requested: direct,
					speech_if_success: typeof a.speech_if_success === 'string' ? a.speech_if_success.trim().slice(0, 300) : null,
				}, { byUser: Boolean(ctx.allowDirectRequest) })
				return JSON.stringify(res)
			},
		},
	]
}
