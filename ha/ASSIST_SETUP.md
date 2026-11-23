# HA Assist 연동 안내 (`ha_agent_assist`)

`ha-agent`를 Home Assistant Assist(음성·앱 챗)의 **주력 대화 에이전트**로 연결하는 방법입니다.

## 1. 준비 확인
1. 서버에서 서비스가 실행 중인지 확인합니다.
   ```bash
   node src/cli.mjs doctor
   ```
2. Assist Bearer 토큰을 확인합니다(최초 시작 시 자동 생성, `chmod 600`).
   ```bash
   cat ~/.config/ha-agent/assist-token
   ```
3. 이 서버의 Tailscale IP와 포트: `http://100.121.130.25:8787` (같은 LAN이면 `http://10.0.0.192:8787`)

## 2. HA에 커스텀 컴포넌트 설치
1. 이 저장소의 `ha/custom_components/ha_agent_assist` 폴더 전체를 HA 설정 폴더의 `/config/custom_components/ha_agent_assist/` 로 복사합니다.
2. Home Assistant를 재시작합니다.
3. **설정 → 기기 및 서비스 → 통합 구성 요소 추가 → "집 비서 (ha-agent) Assist"** 선택:
   - **서버 URL**: `http://100.121.130.25:8787`
   - **Assist Bearer 토큰**: `~/.config/ha-agent/assist-token` 내용 입력

## 3. Assist Pipeline 기본 에이전트로 지정 (대화·음성 STT/TTS)
1. **설정 → 음성 비서 (Voice assistants)** → 한국어 Pipeline(예: `Home Assistant`) 열기
2. 각 항목을 다음과 같이 지정하고 저장합니다:
   - **대화 에이전트 (Conversation agent)**: `집 비서 (ha-agent)` (단순 켜기/끄기는 로컬 빠른 경로, 그 밖에는 OpenAI `gpt-6-luna` `low` → 복잡한 요청은 Gemini `gemini-4-hydrogen` `low`, 아래 5절)
   - **음성-텍스트 변환 (Speech-to-text)**: `집 비서 STT` (`ko`, Gemini `gemini-3.5-transcribe`)
   - **텍스트-음성 변환 (Text-to-speech)**: `집 비서 TTS` (`ko`, Gemini `gemini-3.8-flash-lite-tts`, 목소리 `Kore`)
3. 이제 HA 앱 상단 말풍선(Assist) 마이크 버튼, 위젯, 음성 위성, 또는 iPad 키오스크에서 음성으로 말하고 음성으로 답변을 들을 수 있습니다:
   - `"거실 공기청정기 터보 모드로 바꿔줘"`
   - `"어젯밤 심야 조명 자동화가 왜 실패했는지 trace 확인해줘"`
   - `"화장실 습도 70% 넘으면 환풍기 켜는 자동화 만들어줘"` (Tier 2 검증·Diff 생성 → `"승인해줘"`로 적용)
   - *참고*: iPad·모바일 브라우저에서 마이크를 쓰려면 HA 접속 주소가 **HTTPS**(`external_url`)여야 합니다.

## 4. Tailscale 웹 콘솔 및 음성 엔드포인트
- 브라우저에서 `http://100.121.130.25:8787/` 접속 후 Assist Bearer 토큰을 입력하면 채팅(마이크 `🎤`·`🔊 음성 응답` 포함)·승인/Diff 리뷰·롤백·상태/정책 대시보드를 바로 사용할 수 있습니다.
- `ha-agent` 서버 API: `POST /api/assist/stt` (WAV/OGG/PCM → 텍스트), `POST /api/assist/converse` (대화), `POST /api/assist/tts` (텍스트 → WAV, 인메모리 LRU 캐시).
- 음성 모델·목소리·인식 힌트는 `config.json`의 `assist.voice`에서 조정할 수 있습니다.
- STT는 `gemini-3.5-transcribe`에 `transcription_config`(`language_codes: ["ko-KR"]`, `custom_vocabulary`: 방·기기 이름, `mode`: `assist.voice.stt_mode`)로 요청합니다. 언어를 지정하지 않으면 짧은 한국어가 다른 언어로 인식될 수 있습니다.
- 인식 결과가 비면 해당 오디오와 길이·음량 정보가 `state/stt-failures/`에 최근 `assist.voice.stt_debug_keep`개(기본 20, 0이면 끔)만 서버 안에 저장됩니다. 서비스 로그의 `Assist STT (...)` 줄에도 길이·최대/평균 dBFS·말소리 추정 구간이 함께 남습니다.

## 5. 응답 속도 설정 (`config.json` → `assist`)
Assist 한 번의 지연은 대부분 **LLM 왕복 횟수 × 왕복당 시간**입니다. 다음 장치로 왕복을 줄입니다.

| 키 | 기본 | 설명 |
|---|---|---|
| `fast_path` | `true` | "주방 불 켜줘"처럼 **별칭/기기 이름 + 켜/꺼**만 있는 말은 LLM 없이 정책 게이트만 거쳐 바로 실행(약 0.1~0.5초). 복합·모호한 말은 LLM으로 넘깁니다. |
| `aliases` | `{}` | `entity_id → ["주방 불", "주방 조명"]`. 빠른 경로와 LLM 기기 목록 양쪽에 쓰입니다. 첫 별칭이 음성 응답 이름이 됩니다. |
| `early_finish` | `true` | LLM이 `ha_control_device`를 부를 때 성공 시 읽을 문장(`speech_if_success`)을 같이 받아, 제어가 `done`이면 마지막 답을 받으러 다시 왕복하지 않습니다. |
| `model` / `effort` | — | 기본(fast) 단계 모델. `llm.routes.assist` 프로바이더와 맞지 않는 모델 이름은 무시하고 프로바이더 기본값을 씁니다. |
| `deep` | `null` | `{ "route", "model", "effort", "keywords"? }`. 자동화·트레이스·기록 분석 같은 말(키워드)은 deep 모델로 바로 보내고, fast 단계가 실패하거나 **도구 호출 없이 "켰어요"라고 답하면** deep으로 한 번 더 돌립니다. |
| `fast_timeout_seconds` | `30` | deep 재시도가 있을 때 fast 단계에 주는 시간. 전체 한도는 `timeout_seconds`. |

프롬프트는 캐시가 맞도록 **고정 부분**(규칙·기기 목록·프로필·기억 → 시스템 지시)과 **바뀌는 부분**(시각·기기 상태·센서 값·대기 제안 → 마지막 사용자 메시지 앞 `[현재 상황]`)으로 나뉩니다. 대화 기록에는 사용자 원문만 남습니다.

`logs/decisions.jsonl`의 Assist 항목에 `path`(`fast`/`early`/`llm`), `tier`, `rounds`(LLM 왕복), `tool_calls`가 남습니다. 서비스 로그에도 `Assist fast (...ms, 왕복 N회, 도구 N회)` 줄이 찍힙니다.

현재 설정(2026-11-20 벤치마크 기준, 발화 12개 × 2회, 기기 미작동):

| 모델 | 정확 | 중앙값 | 제어 중앙값 | 1000회 비용 |
|---|---|---|---|---|
| `gpt-6-luna` low (**fast**) | 24/24 | 1.8초 | 1.8초 | 약 $0.15 |
| `gpt-6.1-terra` none | 24/24 | 2.5초 | 2.6초 | 약 $1.3 |
| `gemini-4-hydrogen` low (**deep**) | 24/24 | 2.9초 | 2.9초 | 약 $11.7 |
| `gpt-6-luna` none | 22/24 | 1.8초 | 1.9초 | 약 $0.16 |
| `gemini-3.5-flash-lite` low/minimal | 17·14/24 | 3.1·7.2초 | 8.4·7.1초 | 약 $2 |

`gemini-3.5-flash-lite`는 제어 요청에 도구를 부르지 않고 "켰어요"라고 답하는 경우가 잦아 쓰지 않습니다. 개선 전(같은 hydrogen, 기기 목록·조기 종료 없음) 제어 한 번은 12~25초, LLM 왕복 4~6회였습니다.

### 모델 비교 벤치마크
```bash
node src/cli.mjs bench-assist                                   # 기본 모델 6개 × 기본 발화 12개
node src/cli.mjs bench-assist gemini:gemini-3.5-flash-lite:low api:gpt-6-luna:low --repeat 3
node src/cli.mjs bench-assist gemini:gemini-4-hydrogen:low --case "거실 불 꺼줘"
```
실제 HA 상태·프롬프트·도구로 돌리지만 **기기는 움직이지 않습니다**(HA 쓰기 호출 차단, 제어는 정책 판정만 하고 성공으로 흉내, 기억·제안 저장 생략). 결과는 `logs/bench/assist-*.json`에 남습니다.

## 6. 주변 소음이 있을 때 말 끝 감지 (`ha_agent_assist` 1.2.0)
HA 코어의 VAD는 "사람 목소리처럼 들리는가"로 말 끝을 판단합니다. 그래서 작게 깔린 옆방 TV·대화 소리가 있으면 말이 끝나도 끝을 못 잡고 **15초 제한까지 녹음**합니다. 2026-11-20 로그의 `15.0초 … 소리 1.7초` 두 건이 이 경우입니다.

1.2.0부터 STT 컴포넌트가 오디오를 받는 동안 직접 말 끝을 판정합니다(`endpoint.py`, 소리 크기 기준).
- 말하기 전 0.3~1.3초의 **배경 소리 큰 쪽(90백분위)**과 **바닥 소음(10백분위)**을 잽니다. 그보다 6~10dB 이상 큰 소리만 사용자 말로 봅니다.
- 말이 시작된 뒤 최근 0.7초 중 90% 이상이 "말보다 15dB 작고 배경 수준 근처"면 그 즉시 수신을 멈추고 전사합니다.
- 말 시작 0.5초 전부터만 보내서, 앞쪽의 TV 말소리가 전사에 섞이지 않게 합니다.
- 녹음과 동시에 말해도 첫 0.7초의 가까운 큰 소리(-32dBFS 이상)를 말로 보고 처리합니다.
- 안전장치: 말이 6초 안에 시작되지 않으면 끊고, 최대 10초에서 끊습니다(HA 기본 15초). 어느 경우든 녹음은 그대로 전사합니다.

실제 한국어 음성(TTS)에 소음을 섞어 확인한 결과입니다(말 끝 → 끊은 시점, STT).

| 상황 | 말 끝 | 끊음 | STT |
|---|---|---|---|
| 조용한 방 | 2.2초 | 2.5초 | 주방 불 켜 줘 |
| 옆방 TV -42dB (15초 녹음 재현) | 2.2초 | 2.5초 | 주방 불 켜 줘 |
| 옆방 TV 중 2초 뒤에 말함 | 3.6초 | 3.9초 | 주방 불 켜 줘 (TV 말 제외) |
| 같은 방 TV -32dB, 말 -16dB | 2.4초 | 3.9초 | 주방 불 켜 줘 |
| 공기청정기·환풍기 -36dB | 2.4초 | 2.7초 | 주방 불 켜 줘 |
| 녹음과 동시에 말함 + 옆방 TV | 1.6초 | 1.9초 | 주방 불 켜 줘 |

**적용**: `ha/custom_components/ha_agent_assist/` 폴더 전체(`endpoint.py` 포함)를 HA의 `/config/custom_components/ha_agent_assist/`에 덮어쓰고 Home Assistant를 재시작합니다. 적용되면 ha-agent 로그의 STT 줄에 `말 끝 2.5초(시작 0.9초, 0.4초부터 보냄) 바닥 -60dB 배경 -37dB 말 -17dB`처럼 감지 결과가 붙습니다.

**조정**: `config.json` → `assist.voice.endpoint`(5분 안에 HA로 전달, HA 재시작 불필요)
- `silence_ms`(700): 말이 끝난 뒤 기다리는 시간. 말을 자주 끊어 말하면 늘립니다.
- `max_seconds`(10), `no_speech_seconds`(6): 상한과 "말 없음" 시간.
- `enabled: false`: 끄면 예전처럼 HA VAD만 씁니다.
- 세부 값: `bg_margin_db`(6), `start_margin_db`(10), `end_drop_db`(15), `near_field_db`(-32), `preroll_ms`(500), `quiet_ratio`(0.9)

상한(`max`)이나 "말 없음"(`no_speech`)으로 끊긴 오디오는 인식이 됐어도 `state/stt-failures/`에 감지 결과와 함께 남습니다. 값을 조정할 때 참고하세요.

**한계**: 소리 크기로 가르므로 사용자 목소리가 배경보다 커야 합니다(휴대폰·태블릿에 대고 말하는 보통의 경우). 같은 방에서 TV나 사람이 사용자만큼 크게 말하면 구분하지 못하고 6초나 10초에서 끊습니다. 그럴 때는 앱의 마이크 버튼을 다시 눌러 바로 끝낼 수 있습니다. 멀리서 말하는 용도라면 하드웨어 소음 제거·에코 제거가 있는 음성 위성(예: Home Assistant Voice PE)이 근본적인 해결책입니다.
