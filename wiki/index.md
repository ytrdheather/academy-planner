# 위키 카탈로그

**여기서 시작한다.** 코드를 grep하기 전에 이 목록에서 관련 페이지를 찾아 그것만 열어라. 규칙은 [SCHEMA.md](SCHEMA.md), 이력은 [log.md](log.md).

🔴 = 사고가 났거나 원장이 확정한 것. 바꾸기 전에 반드시 읽어라.

---

## patterns — 재사용 코드 자산 "이걸 또 짜지 마라"

| 페이지 | 한 줄 |
|---|---|
| [notion-fetch](patterns/notion-fetch.md) | Notion 호출은 전부 `fetchNotion()`을 거친다. 409 재시도·헤더·GET body 제거 |
| [notion-prop-read](patterns/notion-prop-read.md) | 롤업·rich_text 읽는 헬퍼 4종. **속성명이 바뀌어도 잡는 법** |
| [notion-find-page](patterns/notion-find-page.md) | 제목으로 페이지 ID 찾기. 속성 타입별 필터 분기 |
| [auth-jwt](patterns/auth-jwt.md) | 학생 30일 / 교사 24시간. `requireAuth` · `requireStudent` |
| [kst-time](patterns/kst-time.md) | `getKSTTodayRange()`. 서버는 해외, 사용자는 한국 |
| [module-di](patterns/module-di.md) | **새 기능 모듈 추가하는 정석.** `initializeXxx({ ... })` 주입 |
| [dashboard-cache](patterns/dashboard-cache.md) | TTL 캐시. 쓰기 라우트를 만들면 무효화를 넣어라 |
| [alimtalk-send](patterns/alimtalk-send.md) | 🔴 학부모 발송. 문자 폴백 금지, 변수 비우지 말 것 |
| [kakaowork-notify](patterns/kakaowork-notify.md) | 내부 알림. 채널 분리 원칙, 담임 DM 폴백 |

## entities — 구체적 사물

| 페이지 | 한 줄 |
|---|---|
| [notion-databases](entities/notion-databases.md) | **Notion DB 18개 맵.** 이 프로젝트엔 RDB가 없다 |
| [env-vars](entities/env-vars.md) | 환경변수 전체. 🔴 `.env.example`은 낡았으니 믿지 마라 |
| [cron-jobs](entities/cron-jobs.md) | **크론 13개 전체 표.** 시각·파일·하는 일 |
| [routes](entities/routes.md) | 라우트 맵. 공개 🔓 / 인증 필요 구분 |
| [views](entities/views.md) | `public/views` HTML 28개가 각각 무슨 화면인지 |
| [external-services](entities/external-services.md) | Notion · Gemini · Solapi · KakaoWork · 카카오채널 · Render |
| [solapi-facts](entities/solapi-facts.md) | 🔴 승인 템플릿 목록 + **보낸 본문은 되읽을 수 있다** |
| [kakaowork-platform-limits](entities/kakaowork-platform-limits.md) | 🔴 **봇은 채널을 못 만든다.** 되는 엔드포인트 목록 |

## systems — 업무 시스템 동작 계약

| 페이지 | 한 줄 |
|---|---|
| [textbook-fee](systems/textbook-fee.md) | 🔴 교재비. 금요일 21시 학부모 일괄 발송. **중복 발송이 최악의 사고** |
| [absence-notice](systems/absence-notice.md) | 🔴 결석·지각·조퇴 + 달력·공지. **알림 늘리자는 제안 금지** · 기간 일정은 시작일 달이 주인 |
| [counsel](systems/counsel.md) | 🔴 상담 **두 갈래** — 재원생(자체 폼) / 신입생(구글폼+Apps Script) |
| [homework-automation](systems/homework-automation.md) | 11시 크론이 전원 생성. 결석 자동 롤백. 버튼 3종 구분 |
| [daily-report](systems/daily-report.md) | 🔴 AI 코멘트 프롬프트 확정안 (`~니다`체, 압축 금지) |
| [grammar-comment](systems/grammar-comment.md) | 반별 문법을 한 번 쓰면 학생 코멘트에 원문 그대로 삽입 |
| [exam-analyzer](systems/exam-analyzer.md) | 시험지 분석 + 학생 채점. 원장 전용. **유일하게 Claude 사용** |
| [monthly-report](systems/monthly-report.md) | ⚠️ `inferred` — 4번째 토요일 자동 생성. 코드 미정독 |
| [kakao-channel-bot](systems/kakao-channel-bot.md) | 🔴 **봇은 안내판이다.** "봇이 안 뜬다"는 상담 연결 모드 때문 |

## decisions — 왜 그렇게 골랐나

| 페이지 | 한 줄 |
|---|---|
| [render-manual-deploy](decisions/render-manual-deploy.md) | 🔴 **자동 배포 꺼져 있음.** push해도 반영 안 됨 + 배포 피할 시간대 |
| [supabase-deferred](decisions/supabase-deferred.md) | Notion을 계속 쓴다 — **노션이 곧 UI라서** |
| [make-migration](decisions/make-migration.md) | Make 완전 해지가 목표. 리포트 **발송**만 아직 남음 |
| [readiplan-brand](decisions/readiplan-brand.md) | 리디플랜 브랜드·민트 테마. 🔴 **손대면 안 되는 보라색**이 있다 |

## pitfalls — 밟은 지뢰와 그 규칙

| 페이지 | 한 줄 |
|---|---|
| [teacher-rollup-name](pitfalls/teacher-rollup-name.md) | 🔴 롤업 이름이 바뀌어 14건이 묻혔다. **"고치면 되는 실패"에 플래그 금지** |
| [solapi-sender-typo](pitfalls/solapi-sender-typo.md) | 🔴 발신번호 오타로 문자 6일 전멸. **실패 통지를 실패하는 경로로 보내지 마라** |
| [notion-latency](pitfalls/notion-latency.md) | 15초 → 1~2초. **노션에 필터를 넘겨라. JS로 거르지 마라** |

---

## 미작성 (링크는 있지만 페이지가 없다)

| id | 어디서 참조 | 원본 |
|---|---|---|
| `progress-automation-design` | [homework-automation](systems/homework-automation.md) | `docs/진도자동화-핸드오프.md`, memory |

## 원본 소스 (raw)

위키는 이들을 **인용만 한다. 복사하지 않는다.** 상세가 필요하면 여기로.

| 파일 | 무엇 |
|---|---|
| `docs/교재비관리-설계.md` (977줄) | 교재비 설계·실측값 **전문**. 교재비 작업 전 필독 |
| `docs/입학상담-appsscript.md` | 신입생 상담 Apps Script 코드 |
| `docs/진도자동화-핸드오프.md` | 진도 자동화 설계 |
| `docs/카카오챗봇-연결.md` | 오픈빌더 연결 절차 |
| `docs/학생앱-핸드오프.md` | 학생 앱 |
| `EXAM_GRADER_HANDOFF.md` | 시험 채점기 핸드오프 |
| `~/.claude/.../memory/` | 자동 로드되는 얕은 층 → [SCHEMA.md](SCHEMA.md#메모리와의-관계) |
| `replit.md` · `vercel.json` · `.replit` | ⚠️ 옛 배포 흔적. **현행은 Render** |
