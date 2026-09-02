---
id: monthly-report
title: 월간 리포트
type: system
status: verified
source: api/monthlyReportModule.js:1-783
updated: 2026-09-01
tags: [report, monthly, gemini, cron]
---

## 한 줄

한 달치 진도를 모아 학생별 월간 리포트를 만든다. **매월 1일 09:00(KST)에 지난달** 것을 전원 생성.

## 흐름

```
매월 1일 09:00 크론 → prevMonth(kstToday()) 로 '지난달' 을 정하고
  → runMonthlyReportBatch(지난달)
       명부를 100명씩 이어 읽으며 학생마다
       generateMonthlyReport() → 1일~말일 진도 → 통계 → Gemini → MONTHLY_REPORT_DB
  → 결과 한 줄을 원장 DM 으로 (실패 명단 + 복구 명령 포함)
```

수동 전체: `POST /api/monthly-report/tick?month=YYYY-MM` (requireAuth, 없으면 지난달).
수동 한 명: `GET /api/manual-monthly-report-gen?studentName=&month=&force=` (requireAuth).
보기: `/monthly-report?studentId=&month=` · URL 조회 `GET /api/monthly-report-url` (둘 다 공개 🔓) → [[routes]]

## 계약 (건드리면 안 되는 것)

- 🔴 **한 달이 완전히 닫힌 뒤에 집계한다 — 1일 생성을 그 달 안으로 되돌리지 마라** (2026-09-01 원장 확정). 이전 두 방식(4번째 토요일 → 마지막 토요일)은 조회 범위가 1일~말일인데 돌리는 날이 그 달 안이라 **매달 마지막 며칠이 통째로 빠졌다**(2026-08 기준 9일치).
- 🔴 **이 크론은 월 1회뿐이다.** 배포와 겹쳐 건너뛰면 다음 기회가 **한 달 뒤**다. 다른 크론처럼 저절로 복구되지 않으므로 `POST /api/monthly-report/tick` 으로 직접 돌린다 → [[render-manual-deploy]]
- **09:00 인 이유**: 1일이 월요일이면 10:00 에 조교 장보기 크론이 있다. 95명 × 2초 ≈ 4분이라 10:20 데일리 리포트 생성 전에 끝난다 → [[cron-jobs]]
- 🔴 **생성 로직은 `generateMonthlyReport()` 한 곳뿐이다** (`:294`). 수동 라우트와 크론이 이걸 공유한다. 2026-09-01 이전엔 통계·프롬프트·저장이 **두 벌로 복사**돼 있어 한쪽만 고치면 자동/수동 결과가 조용히 갈렸다. **다시 복사하지 마라.**
- 🔴 **점수는 `getScoreFromFormula()` 로만 읽는다** (`:29`). 노션 수식이 `87.77777777777779` 를 돌려주므로 여기서 정수로 맞춘다. 이 함수를 우회하면 소수점이 막대 그래프·AI 프롬프트·학부모 화면까지 샌다 → [[monthly-report-float-leak]]
- 🔴 **AI 요약은 `fitForNotion()` 을 거쳐 저장한다** (`:80`). 노션 rich_text 상한 2000자를 그냥 `substring` 하면 문장 한가운데서 끊긴 채 학부모에게 나갔다. 프롬프트도 1,200자 이내를 요구한다.
- **이미 리포트가 있으면 통계만 PATCH 하고 AI 재생성은 건너뛴다** [비용 절감]. `force=true` 일 때만 다시 만든다. `aiSummary === null` 이면 `AI 요약` 속성을 아예 안 건드려 기존 본문을 보존한다.
- **날짜는 `monthRange()`** (`:45`). `new Date(y, m, 0).toISOString()` 은 서버 시간대에 따라 하루 밀린다 → [[kst-time]]
- **크론 콜백 안에서 `new Date()` 를 쓰지 마라.** `kstToday()` (`:59`) · 지난달은 `prevMonth()` (`:66`). `timezone: 'Asia/Seoul'` 은 발화 시각만 정한다.
- 명부·진도 조회는 **`has_more` 커서를 끝까지 돈다**. 명부는 95명이라 곧 100명을 넘는다 → [[notion-latency]]
- 학생 한 명이 실패해도 루프는 계속 돈다. 예전엔 거기서 전체가 멈췄다.
- 배포는 **매월 1일 08:55~09:10을 피하라** → [[render-manual-deploy]]

## 남은 것

- **1일 00:00~09:00 사이에는 지난달 리포트가 아직 없다.** 그 시간대에 선생님이 `📅 월간` 을 누르면 404 → "월간 리포트 로드 실패". `/api/monthly-report-url` 은 항상 **지난달**을 찾는다 (`:623`).
- 모듈이 `node-cron` 을 직접 import 한다. 다른 모듈은 주입받는다 → [[module-di]]

## 주입받는 것

`api/index.js:950` — `app, fetchNotion, geminiModel, requireAuth, dbIds{STUDENT/PROGRESS/KOR_BOOKS/ENG_BOOKS/MONTHLY_REPORT/GRAMMAR}, domainUrl, publicPath` + 노션 헬퍼 5종(`getPropByKeywords` 포함) + `notifyOwner`(원장 DM, `KAKAOWORK_APPROVAL_CONV`) → [[module-di]] · [[notion-prop-read]] · [[kakaowork-notify]]

관련: [[daily-report]] · [[cron-jobs]] · [[student-profile]] · [[monthly-report-float-leak]]
