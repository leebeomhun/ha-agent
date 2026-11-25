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
   - 집 특화 정보는 `state/home-profile.md`로 분리하고, `state/memory.md`는 단기 작업 메모, 선호·지시·거절 이력은 `memory_items`로 관리한다.
6. **다중 LLM 라우터 및 OpenAI / Gemini 듀얼 플랫폼 (`src/llm/router.mjs`, `src/brain.mjs`)**:
   - **OpenAI**: `codex` (Codex CLI 샌드박스) ↔ `api` (OpenAI Responses API)
   - **Gemini**: `agy` (Antigravity CLI `--sandbox`) ↔ `gemini` (Gemini Interactions API `/v1beta/interactions`, `response_format` + `step_list` 도구 루프)
   - 작업 유형별(`assist`, `default` 등) 라우팅과 쌍 기반 자동 페일오버(`codex↔api`, `agy↔gemini`), CLI/API 런타임 전환(`brain` 명령)을 지원한다.
7. **비상 알림 길 (`src/oob.mjs`)**:
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
node src/cli.mjs rules                            # 감시 규칙 목록
node src/cli.mjs log [n]                          # 최근 판단 기록
node src/cli.mjs stats [일수]                     # 운영·토큰·빈 호출 통계
node src/cli.mjs weekly [list|run|publish|날짜]   # 주간 분석 보고서
node src/cli.mjs brain [codex|api|agy|gemini|default]  # 판단 방식 전환 (OpenAI CLI/API · Gemini CLI/API)
node src/cli.mjs oob-test                         # 비상 알림 길 시험
npm test                                          # 전체 단위·통합 테스트
```

서비스 관리: `systemctl --user status|restart|stop ha-agent` · 로그: `journalctl --user -u ha-agent -f`
