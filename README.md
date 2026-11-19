# 집 비서 (ha-agent)

HA를 실시간으로 지켜보다가 필요할 때 AI(Codex 또는 OpenAI API)를 깨워 판단을 받고, 휴대폰으로 알려 주는 에이전트.

## 어떻게 돌아가나
1. **감시(AI 없음, 실시간)**: `src/agent.mjs`가 HA WebSocket으로 상태 변화를 받아 `state/rules.json`의 규칙으로 판정한다.
2. **깨움**: 규칙 발동, AI가 예약한 시각, 활동 시간의 매시 정각(`active_hours`), 하루 한 번 돌아보기(`reflection_hour`, 활동 시간 밖이어도 돈다), 주 1회 주간 분석, 사용자 요청·답장 때 Codex를 부른다. 깨움 대기열은 `state/queue.json`에 남아 재시작해도 이어진다.
3. **판단(Codex)**: 지침(`brain/GUIDE.md`)과 집 자료를 받아 알림·규칙 변경·다음 깨움·메모·행동을 JSON으로 답한다(`brain/response.schema.json`). 자료가 모자라면 기록·통계·활동 기록을 요청해 최대 3번까지 다시 묻는다.
4. **적용**: 이 프로그램이 답을 검사한 뒤 반영한다. 규칙은 AI가 직접 만들고 고친다.

## 판단 방식 (Codex 또는 API)
판단을 누구에게 물을지 둘 가운데 고른다. 지침·자료·답 형식·검사는 똑같고, 묻는 길만 다르다.

| | `codex` (기본) | `api` |
|---|---|---|
| 묻는 길 | Codex CLI를 격리해 실행 (`src/brain.mjs`) | OpenAI Responses API 직접 호출 (`src/api.mjs`) |
| 인증·요금 | Codex 로그인(ChatGPT 요금제 한도) | API 키, 쓴 토큰만큼 과금 |
| 자료 읽기 | 격리된 셸에서 `jq`·`grep` | 읽기 전용 도구 4개(`list_files`·`grep`·`json_get`·`read_file`), `brain/` 안에서만 |
| 필요한 것 | `codex` 실행 파일 | 키: 환경 변수 `OPENAI_API_KEY`, 프로젝트 `.env`, 또는 `api.key_file` |

- **고르기**: `config.json`의 `"brain": "codex"` 또는 `"api"`(재시작 필요). 실행 중에는 `node src/cli.mjs brain api`처럼 바꾸면 재시작 없이 다음 판단부터 따른다(`state/control.json`에 남고 `config.json`보다 먼저다. `brain default`로 되돌린다).
- **확인**: `node src/cli.mjs brain`은 지금 방식과 두 방식을 쓸 수 있는지 보여준다. `status`에도 나오고, `log`에는 API로 한 판단에 `[api]`가 붙는다.
- **견주기**: `node src/cli.mjs replay latest api`(또는 `codex`)로 같은 상황을 다른 방식에 물어 답·시간·토큰을 비교한다.
- **모델·노력**: `api.model`·`api.effort` 등을 적지 않으면 `codex`의 값을 그대로 쓴다. API는 토큰만큼 요금이 나가니 `api.effort`·`api.effort_deep`을 따로 낮게 잡을 수 있다.
- **자동 전환**: 고른 방식이 2번 연속 실패하면(예: Codex 로그인 만료) 다른 방식으로 넘어가 2시간 동안 그쪽에 묻고, 그 뒤 원래 방식을 다시 써 본다(`failover`). 넘어갈 쪽을 쓸 수 있을 때만(API 키 또는 Codex 실행 파일) 동작하고, 넘어가면 하루 한 번 알린다. `log`에 `(자동 전환)`으로 남는다. 둘 다 실패하면 번갈아 시도한다.
- API 방식은 대화를 OpenAI에 저장하지 않는다(`store: false`). 잠깐의 오류(429·5xx·연결 끊김)는 두 번까지 다시 보내고, 그래도 안 되면 Codex 때와 같이 깨움을 다시 넣는다.

## 잃지 않기
- 판단이 실패하면 깨움을 다시 넣는다(규칙 발동·사용자 말 3번, 그 밖 2번). 끝내 안 되면 규칙 내용을 그대로 알린다. 실패가 이어지면 간격을 3분→최대 48분으로 늘린다.
- 밤사이 보류분은 판단이 성공한 뒤에만 지운다.
- urgent 규칙은 Codex를 기다리지 않고 규칙 설명을 바로 긴급 알림으로 보낸다. Codex의 후속 알림이 같은 자리를 덮어쓴다.
- urgent 규칙이 발동한 뒤 상황이 그대로이고 알림에 반응(버튼·답장)이 없으면 15분마다 3번까지 다시 알린다. 2번째부터는 비상 알림 길(`oob`)로도 보낸다(`escalation`). 상황이 풀리거나 버튼을 누르면 멈춘다.
- 쿨다운이나 [이건 그만]으로 쉬는 동안 다시 시작된 상황은 버리지 않고 미뤄 둔다. 그 시간이 끝났을 때 아직 이어지고 있으면 그때 발동한다.
- 하루 판단 한도에 닿아도 사용자 말·수동 깨움에는 10번 더 답한다(`limits.user_reserve_runs`). 그마저 넘으면 답하지 못했다고 알린다.
- 보내지 못한 알림은 `state/outbox.json`에 남아 1분마다 다시 보낸다(urgent 6시간, 정각 요약 1시간, 나머지 2시간까지). 못 보낸 요약은 새 요약이 나가면 버린다(같은 자리를 덮어써 새것을 가리지 않게). 23시 마감 요약처럼 다음 요약이 아침인 것도 잃지 않는다.
- 판단을 시작해 자료(날씨·일정 등)를 받는 사이 HA 연결이 끊기면, 받다 만 자료로 판단하지 않고 다시 연결된 뒤로 미룬다. 실패로 세지 않고 시도 횟수도 그대로이며, 깨움마다 3번까지만 미루고 그 뒤에는 받은 자료로 판단한다(`log`에 `(미룸)`).
- 규칙·메모가 바뀔 때마다 직전 판이 `state/history/`에 남는다(`history`, `restore`).

## 주간 분석 (자동화 개선안)
매주 정한 요일·시각(기본 일요일 21시)에 HA 자동화 설정과 지난 7일의 실행 기록을 분석해 개선안과 새 자동화 제안을 보고서로 남긴다.
- **보는 자료**: 자동화 설정 원문, 자동화별 실행 횟수·시간대·트리거(`run/weekly-automations.json`), 기기별 조작 출처와 자동화·사람이 서로 되돌린 일(`run/weekly-devices.json`), 하루 요약, 지난 보고서. 실행 기록은 HA 활동 기록(logbook)에서 읽으므로 HA에 남아 있는 기간만큼만 본다.
- **결과**: 보고서는 `state/weekly/YYYY-MM-DD.md`에 남고(최근 26개), 휴대폰에는 요약 알림 1개가 간다. 전문은 HA 앱의 알림 목록(🔔)에 올라가 휴대폰에서 읽을 수 있다(`weekly.publish`, 새 보고서가 지난 것을 덮어쓴다). 서버에서는 `node src/cli.mjs weekly`, 다시 올리려면 `weekly publish`.
- **제안만 한다**: HA 자동화를 고치는 권한은 없다. 보고서의 YAML 초안을 보고 직접 적용한다. 알림에 [답장]으로 "2번은 안 할래"처럼 답하면 메모에 남겨 다음 보고서에서 되풀이하지 않는다.
- 오래 걸리는 판단이라 다른 깨움과 섞지 않고 혼자 돈다. 그 시각에 꺼져 있었으면 그날 다시 켜질 때 돈다. 보고서 없이 끝나면 한 번 다시 시도한다.

## 사람 없이 굴러가기
- **heartbeat**: 60초마다 HA로 `haagent_heartbeat` 이벤트를 보낸다. `ha/heartbeat-automation.yaml`을 HA에 추가하면 10분 넘게 끊길 때 HA가 휴대폰으로 알린다. 신호가 `heartbeat.alert_minutes`(기본 10분) 넘게 끊겼다 돌아오면(재시작 포함) 집 비서가 같은 tag로 '다시 연결됐어요'를 소리 없이 보내 그 경고를 바꿔 놓는다. 이벤트에는 상태(오늘 판단·알림 수, 실패 횟수, 판단 방식, 마지막 판단 요약)가 실려 있어 `ha/status-sensors.yaml`을 추가하면 대시보드에서 볼 수 있다.
- **비상 알림 길**: HA에 15분 넘게 연결하지 못하거나 urgent 알림을 못 보내면 HA 밖의 길로 알린다. `config.json`의 `oob`를 채워야 동작한다(아래 설정). `node src/cli.mjs oob-test`로 확인.
- **멈춤 감시**: 주 루프가 5분 넘게 멈추면 프로세스를 끝내고 systemd가 다시 띄운다(`src/watchdog.mjs`).
- **시작 점검**: 시작할 때 고른 판단 방식에 필요한 것(Codex 실행 파일 또는 API 키)과 지침·스키마를 확인하고 문제가 있으면 알린다. `codex.fallback_model`(API는 `api.fallback_model`)을 정하면 두 번 연속 실패한 뒤 그 모델로 시도한다.
- **하루 정리**: 날짜가 바뀌면 전날 하루 요약을 `state/daily/`에 남기고, 커진 기록 파일은 한 세대(`.1`)만 남긴다.

## 행동 (기기 켜기/끄기, 기본은 꺼짐)
`config.json`에 직접 적은 엔티티만 움직인다. 적지 않은 엔티티와 도어락·경보·차량 같은 도메인은 코드에서 막힌다(`src/ha.mjs`의 `checkMessage`).
```json
"actions": { "enabled": true, "auto": ["light.hwanpunggi"], "confirm": ["switch.geosil_seuwici"] }
```
- `auto`: AI가 스스로 실행한다. 실행 뒤 상태가 바뀌었는지 확인하고, 결과를 [되돌리기] 버튼과 함께 알린다.
- `confirm`: [실행] [아니요]를 묻는 알림이 가고, 30분 안에 눌러야 실행된다.
- 직접 시킨 행동: 답장이나 `say`로 "작은방 불 꺼줘"처럼 직접 시킨 것은 `confirm` 엔티티여도 다시 묻지 않고 바로 실행하고(조용한 시간에도), [되돌리기] 버튼과 함께 알린다. 사용자 말로 깨어난 판단에서, 목록에 있는 엔티티에만 적용된다. 끄려면 `actions.on_request: false`.
- 쓸 수 있는 것: light·switch·fan·humidifier·input_boolean의 켜기/끄기, media_player 끄기. 하루 20회, 한 번에 3개, 조용한 시간에는 스스로 끄는 것만.
- 거절하거나 되돌린 행동은 다음 판단에 보여 AI가 같은 제안을 줄인다. `node src/cli.mjs actions`로 기록을 본다.
- 처음에는 `confirm`에만 넣어 어떤 제안이 오는지 본 뒤 `auto`로 옮기는 것을 권한다.

## 안전 장치
- Codex는 HA에 접속하지 못한다. `--ignore-user-config`로 사용자 Codex 설정(플러그인·MCP·메모리)을 쓰지 않고, 네트워크를 끄며, `brain/` 폴더만 읽을 수 있게 격리한다(`src/brain.mjs`).
- API 방식의 모델도 HA·셸·네트워크에 닿지 않는다. 받는 도구는 `brain/` 안의 파일을 읽는 것뿐이고, 폴더 밖 경로와 링크는 거절한다. 도구 호출은 한 판단에 30번(`api.max_tool_calls`)까지. API 키는 Codex 프로세스에 넘기지 않는다.
- HA 호출은 코드에서 허용 목록으로 막는다: 읽기(날씨·일정·상태·기록·통계·영역·자동화 설정), `notify.<설정한 대상>`, heartbeat 이벤트, 주간 보고서를 올리는 `persistent_notification.create`(`weekly.publish`가 켜져 있을 때만), 그리고 `actions`에 적은 엔티티의 켜기/끄기뿐. 그 밖의 서비스는 보내기 전에 거절된다(`src/ha.mjs`).
- 휴대폰 앱이 명령으로 알아듣는 문구(`remove_channel`, `command_*` 등)는 알림으로 보내지 않는다.
- 조용한 시간(`active_hours` 밖)에는 urgent 알림만 나가고 나머지는 아침에 다시 판단한다. 하루 돌아보기의 요약만 예외로 소리 없이 나간다.
- 하루 한도: 판단 80회, 알림 25개, 정각 요약 20개(`config.json`의 `limits`).
- 버튼 action 이름은 `HAAGENT_`로 시작해 기존 자동화와 겹치지 않는다. [이건 그만]은 관련 규칙을 7일 쉬게 할 뿐 기기를 건드리지 않는다.
- 정각 요약에는 [줄여 줘]가 붙는다. 누르면 그 요약 내용과 함께 피드백으로 남고, 다음 판단부터 AI가 그런 내용을 줄인다(돌아보기 지표 `summary_less`).
- [답장]으로 보낸 말은 AI에게 지시로 전달된다. 답장 버튼의 action 이름은 안드로이드 규칙상 `REPLY`라서, `haagent-`로 시작하는 tag의 알림에 단 답장만 받는다.

## 명령
```
node src/cli.mjs status        # 동작 상태, 오늘 횟수, 예약, 마지막 판단
node src/cli.mjs rules         # 감시 규칙
node src/cli.mjs log [n]       # 최근 판단 기록
node src/cli.mjs notes [날짜]   # 그날 알림
node src/cli.mjs memory        # AI 메모
node src/cli.mjs weekly [list|run|publish|날짜]  # 주간 분석 보고서(최근 것 / 목록 / 지금 분석 / HA 알림에 다시 올리기 / 그날 것)
node src/cli.mjs actions [n]   # 행동 기록
node src/cli.mjs wake [이유]    # 지금 판단시키기
node src/cli.mjs say <말>      # 집 비서에게 말하기(휴대폰 [답장]과 같음)
node src/cli.mjs brain [codex|api|default]  # 판단 방식 보기 / 바꾸기(재시작 없이) / config.json 값으로
node src/cli.mjs pause|resume  # 판단·알림·행동 멈춤/다시
node src/cli.mjs send-off|send-on  # 알림 발송 끔(알림·행동을 기록만)/켬
node src/cli.mjs history       # 규칙·메모 이전 판 목록
node src/cli.mjs restore <파일> # 이전 판으로 되돌리기
node src/cli.mjs runs [n]      # 보관된 판단 원문 목록 (logs/runs/)
node src/cli.mjs replay [이름] [codex|api]  # 보관된 판단을 지금의 GUIDE.md로 다시 물어 비교 (AI 1회, 아무것도 바꾸지 않음)
node src/cli.mjs oob-test      # 비상 알림 길 시험
node src/cli.mjs once hourly   # 데몬을 끈 상태에서 판단만 미리 보기
npm test                       # 단위 시험 + 통합 시험(가짜 HA·가짜 Codex·가짜 API)
```
서비스: `systemctl --user status|restart|stop ha-agent` · 기록: `journalctl --user -u ha-agent -f`

## 설정 (`config.json`, 바꾼 뒤 `systemctl --user restart ha-agent`)
- `brain` 판단 방식: `"codex"`(기본) 또는 `"api"` (위 "판단 방식")
- `api` API 방식 설정: `key_env`(기본 `OPENAI_API_KEY`), `key_file`(키를 둔 파일 경로), `base_url`, `max_tool_calls`(기본 30), 그리고 `model`·`fallback_model`·`effort`·`effort_deep`·`timeout_seconds`·`timeout_deep_seconds`(적지 않으면 `codex` 값)
- `codex.model` 모델(기본 `gpt-6.1-sol`), `codex.effort` 평소 추론 노력(기본 `low`), `codex.effort_deep` 처음 시작·하루 돌아보기·주간 분석용(기본 `medium`)
- `notify_targets` 알림 받을 기기(`mobile_app_ibeomhun` 휴대폰, iPad는 `mobile_app_bh_s_ipad`)
- `active_hours` 활동 시간(`start`~`end`시. 이 안의 매시 정각에 점검하고, 밖은 조용한 시간), `reflection_hour` 하루 돌아보기 시각(0~23, 활동 시간 밖이어도 된다. `null`이면 끔)
- `limits` 한도, `hourly_skip_unchanged` 달라진 것이 없으면 정각 점검에서 Codex를 부르지 않음(기본 켜짐), `reply_button` 알림의 [답장] 버튼(기본 켜짐)
- `noise_entities` 자주 바뀌지만 집 상태와 상관없는 엔티티(별표 가능, 예: `"sensor.seoul_*"`). 프롬프트에서는 횟수만 남기고, 달라진 것이 있는지 따질 때 세지 않는다. 기록(`events.jsonl`, 하루 요약)에는 그대로 남는다. TV·셋톱의 재생↔일시정지 출렁임은 적지 않아도 달라진 것으로 치지 않는다.
- `rule_backtest` 새로 만들거나 고친 규칙을 지난 7일 기록에 돌려 보고 몇 번 발동했을지 AI에게 보여 줌(기본 켜짐. `rules`·`log`에도 나온다)
- `failover` 판단 방식 자동 전환: `enabled`, `after_failures`(기본 2), `hold_minutes`(기본 120)
- `escalation` urgent 다시 알림: `enabled`, `remind_minutes`(기본 15), `max_reminders`(기본 3), `oob_from`(비상 길로도 보내기 시작하는 회차, 기본 2)
- `weekly` 주간 분석: `enabled`(기본 켜짐), `weekday` 요일(`"일"`~`"토"`, 기본 `"일"`), `hour` 시각(기본 21), `timeout_seconds`(기본 900), `publish` 전문을 HA 알림 목록에 올림(기본 켜짐). 추론 노력은 `codex.effort_deep`을 쓴다.
- `actions` 행동 권한(위 "행동"), `heartbeat` 살아 있음 신호, `watchdog_minutes` 멈춤 감시
- `oob` 비상 알림 길. 토큰은 파일에 두고 경로만 적는다.
  - ntfy: `{ "type": "ntfy", "url": "https://ntfy.sh", "topic": "<추측하기 어려운 이름>" }` (자체 서버면 `token_file` 추가)
  - 텔레그램: `{ "type": "telegram", "token_file": "~/.config/ha-agent/telegram-token", "chat_id": "<숫자>" }`
  - 그 밖: `{ "type": "webhook", "url": "https://..." }` (`{title, message, urgent}`를 POST)

## 파일
- `state/`: 규칙, 규칙 실행 상태, 예약, 메모, 알림·피드백·행동 기록, 대기열(`queue.json`), 다시 보낼 알림(`outbox.json`), 상태 변화 기록(`events.jsonl`), 하루 요약(`daily/`), 주간 분석 보고서(`weekly/`), 이전 판(`history/`), 스위치(`control.json`)
- `logs/decisions.jsonl`: 판단마다 이유·요약·적용 결과·토큰
- `logs/runs/`: 판단마다 프롬프트·답 원문과 그때의 자료(최근 100개). 지침을 고친 뒤 `replay`로 같은 상황을 다시 물어볼 수 있다.
- `brain/run/`: 매 판단마다 새로 쓰는 AI 자료(상태 요약, 자동화 목록·설정, 하루 요약, 수리 항목, 요청한 기록, 지난 주간 보고서, 주간 분석 때는 7일 실행·조작 집계)
- `ha/heartbeat-automation.yaml`: HA에 추가할 응답 없음 경고 자동화
- `ha/status-sensors.yaml`: HA에 추가할 상태 센서(연결·상태·오늘 판단/알림 수·마지막 판단)와 대시보드 카드 예. heartbeat에 실려 가는 값을 받아 거실 iPad 같은 대시보드에 보여 준다.
- `brain/GUIDE.md`: AI 지침. `<!-- only: weekly -->` … `<!-- /only -->`로 감싼 절은 그 종류의 깨움에만 프롬프트에 들어간다(주간 분석 절은 주간 깨움에만, 정각 점검 절은 정각·돌아보기에만).
- `src/backtest.mjs`: 규칙 백테스트(실제 판정과 같은 규칙 엔진을 지난 기록에 돌린다)
- Codex 버전이 바뀌어 격리 실행이 깨지면 `config.json`의 `codex.vendor_dir`로 실행 파일 폴더를 직접 지정한다.
