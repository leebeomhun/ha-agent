// Assist 평가 사례(벤치마크·빠른 경로 회귀 평가가 함께 쓴다). expect: [[entity_id, service, option?], ...], []는 "아무것도 제어하지 않음".
// 이 집의 기기 이름·별칭에 맞춘 사례다.
export const DEFAULT_CASES = [
	{ text: '주방 불 켜줘', expect: [['switch.setagsil_seuwici_seuwici_2', 'turn_on']] },
	{ text: '거실 불 꺼줘', expect: [['switch.geosil_seuwici', 'turn_off']] },
	{ text: '화장실 환풍기 켜 줘', expect: [['light.hwanpunggi', 'turn_on']] },
	{ text: '공기청정기 속도 높음으로 바꿔줘', expect: [['select.geosil_gonggiceongjeonggi_speed', 'select_option', 'high']] },
	{ text: '환풍기 자동 제어 꺼줘', expect: [['input_boolean.hwanpunggi_auto', 'turn_off']] },
	{ text: '공기청정기 끄고 거실 불도 꺼줘', expect: [['switch.geosil_gonggiceongjeonggi_power', 'turn_off'], ['switch.geosil_seuwici', 'turn_off']] },
	{ text: '지금 화장실 습도 몇 퍼센트야?', expect: [] },
	{ text: '거실 TV 켜져 있어?', expect: [] },
	{ text: '오늘 화장실 환풍기 몇 번 켜졌어?', expect: [] },
	{ text: '코나 시동 걸어줘', expect: [] },
	{ text: '주방 하이라이트 꺼줘', expect: [] },
	{ text: '안녕', expect: [] },
]
