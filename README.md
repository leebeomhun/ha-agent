# 집 비서 (ha-agent)

Home Assistant(HA)를 실시간으로 감시하고, **HA Assist 대화**·**기기 제어**·**자동화/스크립트 DevOps 관리**까지 수행하는 개인 자율형 AI 에이전트.

## 핵심 아키텍처
1. **실시간 감시·이상탐지**: `src/agent.mjs`가 HA WebSocket으로 상태 변화를 받아 결정론적 규칙(`src/rules.mjs`)과 숫자 센서 베이스라인 이상탐지(`src/engine/anomaly.mjs`)로 판정한다.
2. **Risk Tier 0~3 정책 엔진 (`src/core/policy.mjs`)**:
   - **Tier 0 (자율 읽기/진단)**: 상태·히스토리·트레이스(`trace/list`, `trace/get`)·통합(`config_entries`)·백업·템플릿 드라이런·`check_config`·고아 엔티티 감사.
   - **Tier 1 (`tier1_auto`)**: 환풍기·공기청정기·모드/속도·재실/연차 헬퍼 등 저위험 기기는 자율 제어 후 스냅샷 기반 `[되돌리기]` 버튼과 함께 사후 알림(재실 도우미 `on`·조용한 시간 하드 가드 적용).
   - **Tier 2 (`tier2_confirm`)**: 일반 조명·스위치·미디어 제어 및 **HA 관리 제안(`proposals`)** 은 사전 검증 + Diff 생성 후 사용자 승인([실행]/[승인] 또는 HA Assist 직접 요청)을 거쳐 실행하며, 설정 오류 시 자동 롤백 및 수동 `[롤백]`을 지원한다.
   - **Tier 3 (`tier3_blocked`)**: 도어락, 경보, 주방 하이라이트, 세탁/건조기 파워, 차량 원격 시동, HA 재시작/업데이트 설치는 코드 레벨에서 무조건 차단한다. 직접 호출뿐 아니라 HA 관리 제안(자동화·스크립트) 안의 동작도 제안할 때와 승인할 때 검사해, Tier 3 기기를 움직이거나 대상을 미리 알 수 없는 동작(방·기기 단위, 템플릿 대상)은 거절한다.
   - **스크립트 제어**: 스크립트가 받는 필드(`fields`)를 HA에서 읽어, 기본값 없는 필드를 `variables`로 다 넘겨야만 실행한다(필드 없이 불려 반대로 동작하는 일 방지). 스크립트·씬은 음성 빠른 경로에서 제외하고, 실행 확인은 `last_triggered` 변화로 한다.
   - **스크립트 최종 대상**: 스크립트 설정을 읽을 때 동작마다 움직이는 기기를 분석하고(`src/core/script-scope.mjs`, 다른 자동화 호출은 한 단계 따라감), 실행 직전(1분 이상 지났으면) 다시 읽는다. 고정 대상은 허용 목록 안이어야 하고, 대상이 실행 때 정해지는 스크립트(템플릿 대상·다른 스크립트 호출)는 `policy.script_targets`에 허용 기기·동작을 적지 않으면 Tier 1이어도·직접 요청이어도 승인을 거친다. 적었으면 넘기는 값과 스크립트 안의 기기가 그 범위 안일 때만 실행하고, Tier 3 기기는 어느 경우에도 막는다. 동작 이름이 템플릿(`switch.turn_{{ … }}`)이면 `services`를 `switch.turn_*`처럼 범위로 적어야 바로 실행되고, 정확한 이름 목록이면 승인을 거친다. 실행 직전 설정을 다시 읽지 못하면 예전 분석을 믿지 않고 승인을 거친다.
   - **실행 결과 판정**: 서비스마다 요청한 값(선택값·숫자값·밝기·색온도·팬 단계·온도·위치·음량 등)이 상태에 보일 때만 `done`, 기한(`actions.verify_seconds`) 안에 확인되지 않으면 `unverified`. 되돌리기는 이전 상태를 먼저 보고 만든다(켜져 있던 조명의 밝기만 바꿨으면 이전 밝기로 켬). 원래 행동은 복원이 확인됐을 때만 `undone`이 되고, 확인되지 않으면 그대로 두고 [다시 되돌리기]를 남긴다.
   - **운영 모드 공통 검사**: 기기 호출·설정 쓰기·휴대폰 알림 직전마다 control 파일을 다시 읽는다(진행 중이던 판단·Assist 요청·예전에 보낸 버튼에도 적용). 일시정지(`pause`)는 기기 제어·관리 제안 승인과 새 제안·하루 자가개선 작업·일반 알림을 막고 긴급(urgent) 알림과 버튼·답장 확인 문구만 보낸다. 판단(LLM)을 기다리는 사이 일시정지되면 그 판단의 결과(규칙·기억·예약·제안·알림·보고서)를 하나도 적용하지 않고, 감시·점검 이유만 재개 뒤 다시 판단한다(옛 사용자 명령은 버림). 시험 모드(`send-off`)는 알림·기기 제어를 기록만 하고 제안 승인과 주간 보고서 게시도 막는다(CLI `weekly publish`는 직접 시킨 것이라 허용). 두 모드 모두 CLI·웹 콘솔에서 직접 실행한 롤백만 허용한다(비상 탈출구).
   - **요청당 제어 한도**: 정기 판단(`actions.per_cycle`)과 Assist 요청(`assist.max_actions_per_turn`, 기본은 per_cycle)이 같은 실행기·같은 방식의 한도를 쓴다.
3. **주력 대화·음성 채널 — HA Assist (`src/channels/assist-server.mjs`, `src/voice/gemini-voice.mjs`)**:
   - 내장 HTTP 서버(기본 포트 `8787`, Bearer 토큰 인증)가 HA 네이티브 커스텀 컴포넌트(`ha/custom_components/ha_agent_assist` — Conversation·STT·TTS), OpenAI 호환 `/v1/chat/completions`, 그리고 Tailscale 웹 관리 콘솔(`/`)을 제공한다.
   - Gemini Interactions API 기반 빠른 음성·대화 파이프라인(`/api/assist/stt`: `gemini-3.5-transcribe`, `/api/assist/converse`: 단순 켜기/끄기는 LLM 없는 로컬 빠른 경로, 그 밖에는 `gpt-6-luna` `low`(복잡한 요청·실패 시 `gemini-4-hydrogen` `low`), `/api/assist/tts`: `gemini-3.8-flash-lite-tts` + WAV 캐시)과 멀티턴 대화 세션(`src/orchestrator/session.mjs`)·정책 검증 도구(`src/tools/`)를 통해 음성 입력→조회·제어→음성 응답까지 한 번에 처리한다.
4. **HA DevOps 관리 (`src/admin/ha-admin.mjs`)**:
   - 자동화/스크립트 CRUD, 엔티티·Jinja 템플릿 사전 검증, Unified Diff, 승인/거절, 적용 후 `check_config` 검증 및 실패 시 자동 롤백, 감시 규칙의 HA 자동화 승격(`promote_rule`), 종합 건강 감사(`auditHealth`).
5. **영속 저장소 & 지능형 계층 기억 (`src/core/store.mjs`, `src/core/memory.mjs`, `src/core/memory-extractor.mjs`, `src/core/embeddings.mjs`)**:
   - Node 22 내장 `node:sqlite`(WAL 모드)에 이벤트, 센서 표본, 컨텍스트별 베이스라인(`weekday`/`weekend`/`away`), 결정 로그, 제어 스냅샷, 관리 제안, 대화 세션, 구조화 장기 기억(`memory_items` + FTS5 + 변경 이력 `memory_history`), 절차적 교훈(`lessons`), 암묵적 피드백(`implicit_feedback`), 사후 검증 실험 원장(`experiments`), 장기 일·월 롤업(`daily_rollups`/`monthly_rollups`)을 저장한다.
   - 구조화 기억은 `pinned`·카테고리 우선순위(`standing_order → preference → rejection → pattern → incident`) 순으로 예산을 우선 보장해 영구 지시·선호가 일회성 사건에 밀려 잘리지 않으며, `ttl_days`/`expires_at` 자동 만료·아카이브, `pinned`/사용자 등록 기억 자동 삭제 차단, FTS5 + 한국어 2-gram + **Gemini Embedding 2(`gemini-embedding-2`, 768d MRL + 공식 접두어, 오프라인 시 512d 로컬 폴백)** 하이브리드 의미 검색, 맥락 기반 회상(Contextual Recall), 대화 직후 비동기 기억 추출기(Post-Turn Extractor)를 제공한다.
   - 알림·피드백·행동·상태 변화 기록의 원본은 SQLite(`src/core/journal.mjs`)이며 일일·주간·기간 통계(`src/records.mjs`)도 SQLite 단일 원본으로 집계한다. `maintain()`으로 원시 기록을 정리하기 전 일/월 롤업을 영구 보존한다.
   - 이상탐지는 5분마다 숫자 센서의 지금 값을 컨텍스트(`weekday`/`weekend`[공휴일·연차 포함]/`away`)와 함께 표본으로 쌓아 지난 14일 범위를 벗어날 때만 이상으로 본다.
   - 자가개선 엔진(`src/engine/learning.mjs`)이 암묵적 피드백(제어 되돌림·Assist 재발화/정정/거짓 제어·제안 실패), HA 재시작 스파이크를 제외한 통계적 루틴 마이너, 규칙 정밀도 스코어카드, 실패→회귀 평가셋(`state/evals/cases.json`), Tier 2 자가 튜닝 제안(`self_alias_proposal`/`self_noise_proposal`/`self_stt_tune`/`self_lesson_proposal`, 불변 코어 보호 + 롤백), 사전 백테스트 과다발동 게이트, 제안 검증 실패 1회 Self-Repair, 변경 후 7일 효과 검증 실험을 수행한다.
   - 관리 제안의 이전 설정은 HA에서 새로 읽고, 승인 직전에 다시 읽어 그사이 HA에서 바뀌었으면 덮어쓰지 않는다.
   - 적용 직후 값(`proposals.post_snapshot`)을 남겨 롤백은 그 제안이 바꾼 항목에만 적용한다(소음 목록·별칭은 넣은 항목만 빼고, 음성 설정은 바꾼 키만 되돌린다). 적용 뒤 같은 항목이 다시 바뀌었으면 덮어쓰지 않고 `롤백 충돌`로 표시하며, 롤백 뒤 `check_config` 결과까지 확인한다. 예전 판이 승인한 제안은 제안 내용과 제안 때의 이전 값으로 바꾼 항목을 짐작한다. 제안이 새로 만든 헬퍼를 그 뒤 고쳤거나, 지운 헬퍼와 같은 이름이 다시 생겼으면 충돌로 본다. 적용 실패 뒤 자동 롤백도 되돌린 다음 `check_config`를 다시 확인하고, 실패하면 `rollback_failed`로 남긴다.
   - 승격 제안은 판단이 옮겨 적은 규칙이 아니라 지금 감시 중인 규칙 정의로 만들고, 승인 직전에 그 규칙이 그사이 바뀌었거나 지워졌으면 승격하지 않는다(옛 조건이 HA에 올라가고 새 규칙이 지워지는 일 방지).
   - 감시 규칙을 HA 자동화로 승격할 때 지운 규칙 정의를 제안에 보관하고, 롤백하면 규칙을 먼저 되살린 뒤 HA 자동화를 지우고 다시 감시 중인지 확인한다(규칙 정의가 없는 예전 제안은 롤백하지 않음).
   - 집 특화 정보는 `state/home-profile.md`로 분리하고, `state/memory.md`는 단기 작업 메모, 선호·지시·거절 이력은 `memory_items`로 관리한다.
6. **자가개선 루프 (`src/engine/origin.mjs`, `automation-suggest.mjs`, `scorecard.mjs`, `regression.mjs`, `device-health.mjs`)**:
   - **학습 신호**: 상태 변화마다 HA `context`로 조작 주체(사람·앱 / 사람·기기 / 자동화 / 집 비서)를 가려 `events.origin`에 남기고, 자동화가 한 일을 사람이 곧바로 뒤집음(`automation_overridden`), 규칙 알림 뒤 관련 기기 조작(`notification_acted`), 승인 없이 만료된 제안(`proposal_ignored`), 사용자의 자동화 직접 수정(`automation_user_edited`, 집 비서가 만든 자동화면 `proposal_edited_by_user` + 선호 기억)을 기록한다.
   - **루틴 → 자동화 제안**: 사람이 반복한 켜기/끄기 루틴을 logbook으로 사람 조작인지 확인하고(HA 사용자 조작 확인과, 조작자 기록 없이 기기에서 바뀐 "물리 조작 추정"을 나눠 센다. 물리 조작 추정은 HA에만 붙는 로컬 무선 통합(`learning.suggest.physical_platforms`, 기본 zha·zwave_js·deconz·matter)일 때만 인정하고, 클라우드·Wi-Fi 기기는 제조사 앱·예약·자동화일 수 있어 주체 불명으로 둔다. 주체 불명인 날은 최소 일수와 백테스트에서 빼고 따로 센다), 그 기기를 이미 움직이는 자동화가 있으면 빼고, "시각"·"귀가" 트리거를 지난 기록으로 백테스트해 정확도·재현율 기준을 넘는 것만 근거와 함께 Tier 2 제안으로 올린다(하루 최대 2건). 주간 보고서의 YAML 초안은 `proposals`로도 내도록 한 번 더 묻는다.
   - **루프 닫기**: 7일 실험이 악화면 규칙은 이전 판으로 자동 원복, 제안은 [롤백] 버튼으로 묻고, 약해진 교훈은 끈다. 별칭 제안은 빠른 경로 회귀 평가(LLM 없음)를 통과해야 올라가고 승인할 때 다시 평가한다.
   - **자기 성능 지표**: 알림 뒤 조치 비율, 제안 수락률, Assist 성공률·재요청·정정 비율·모델 전환 비율(요청마다 남기는 최종 결과 `applied.outcome` 기준. 처리 실패·기기 명령 실패·일부만 실행·오늘 한도 거절은 실패로 세고, 일시정지 중 받은 요청은 뺀다. 모델은 실제로 부른 단계만 적는다), 빈 판단 비율, 판단당 토큰, 자동화 뒤집힘의 주간 추세를 계산해 주간 보고서 끝과 콘솔·CLI에 보여 준다.
   - **관리 범위**: 기기 건강(오래 응답 없음·배터리·약한 신호) 새 문제 알림, 씬(`scene_upsert/delete`)·헬퍼(`helper_upsert/delete`) 생성·수정·삭제 제안과 롤백, 방 미지정 제어 기기 감사.
   - 위 작업은 매일 `learning.daily_hour`(기본 19시)에 한 번 돈다.
7. **다중 LLM 라우터 및 OpenAI / Gemini 듀얼 플랫폼 (`src/llm/router.mjs`, `src/brain.mjs`)**:
   - **OpenAI**: `codex` (Codex CLI 샌드박스) ↔ `api` (OpenAI Responses API)
   - **Gemini**: `agy` (Antigravity CLI `--sandbox`) ↔ `gemini` (Gemini Interactions API `/v1beta/interactions`, `response_format` + `step_list` 도구 루프)
   - 작업 유형별(`assist`, `default` 등) 라우팅과 쌍 기반 자동 페일오버(`codex↔api`, `agy↔gemini`), CLI/API 런타임 전환(`brain` 명령)을 지원한다.
8. **비상 알림 길 (`src/oob.mjs`)**:
   - **카카오톡(`kakao`)**: `/home/ubuntu/reserve/.env` 토큰을 공유해 친구(`이범훈(알림)`) 또는 나에게 보내기(`memo`)로 발송하며, `401` 시 리프레시 토큰으로 자동 갱신 후 `.env`에 원자적으로 재기록한다.
   - 카카오톡 실패 시 `fallback_memo` 및 `oob.fallback`(`slack` 등)을 지원하며, `ntfy`, `telegram`, `slack`, `webhook`도 지원한다.

## HA 연동 안내
- HA Assist 통합 설치 및 파이프라인 연결: [ha/ASSIST_SETUP.md](file:///home/ubuntu/ha-agent/ha/ASSIST_SETUP.md)
- 응답 없음 경고 및 대시보드 센서: [ha/heartbeat-automation.yaml](file:///home/ubuntu/ha-agent/ha/heartbeat-automation.yaml), [ha/status-sensors.yaml](file:///home/ubuntu/ha-agent/ha/status-sensors.yaml)

## 주요 CLI 명령
```bash
node src/cli.mjs status                           # 데몬·정책·연결·오늘 횟수 요약
node src/cli.mjs doctor                           # 설정·권한·Slack OOB·SQLite·Assist 서버 일괄 점검
node src/cli.mjs policy                           # Tier 0~3 자율성 경계 정책 확인
node src/cli.mjs assist <말>                      # HA Assist 대화(멀티턴 즉시 응답)
node src/cli.mjs audit                            # 깨진 자동화 참조·통합 오류·트레이스·고아 엔티티 감사
node src/cli.mjs traces [automation.id]           # 최근 자동화 실행 추적(trace) 조회
node src/cli.mjs proposals [list|show|approve|reject|rollback]  # HA 관리 제안 조회·승인·롤백
node src/cli.mjs memory [list|search|add|rm|pin|unpin|history|restore|consolidate|reindex]  # 계층 기억·고정·이력·통합·임베딩 재색인 관리
node src/cli.mjs learning                         # 암묵적 피드백·교훈·실험·루틴·규칙 정밀도·자가튜닝 현황
node src/cli.mjs routines [일수]                  # 통계적 출퇴근·기기 조작 루틴 분석
node src/cli.mjs experiments [eval]               # 변경 사후 검증 실험 조회·평가
node src/cli.mjs self-tune [propose]              # 자가 튜닝 제안 후보 조회·Tier 2 등록
node src/cli.mjs evals                            # 실패 사례에서 자동 축적된 회귀 평가셋 조회
node src/cli.mjs scorecard [주수] [--json]        # 자기 성능 지표(주간 추세)
node src/cli.mjs suggest-automations [apply]      # 생활 루틴 → 자동화 후보(기본 계산만, apply면 승인 대기 제안으로)
node src/cli.mjs health                           # 기기 건강(응답 없음·배터리·신호·방 미지정)
node src/cli.mjs regression                       # Assist 빠른 경로 회귀 평가(LLM 없음)
node src/cli.mjs daily-learning                   # 하루 자가개선 작업을 지금 한 번 실행(데몬 필요)
node src/cli.mjs rules                            # 감시 규칙 목록
node src/cli.mjs log [n]                          # 최근 판단 기록
node src/cli.mjs stats [일수]                     # 운영·토큰·빈 호출 통계
node src/cli.mjs weekly [list|run|publish|날짜]   # 주간 분석 보고서
node src/cli.mjs brain [codex|api|agy|gemini|default]  # 판단 방식 전환 (OpenAI CLI/API · Gemini CLI/API)
node src/cli.mjs oob-test                         # 비상 알림 길 시험
npm test                                          # 전체 단위·통합 테스트
```

서비스 관리: `systemctl --user status|restart|stop ha-agent` · 로그: `journalctl --user -u ha-agent -f`
