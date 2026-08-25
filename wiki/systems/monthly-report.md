---
id: monthly-report
title: 월간 리포트
type: system
status: inferred
source: api/monthlyReportModule.js (744줄, 부분 확인)
updated: 2026-08-15
tags: [report, monthly, gemini, cron]
---

> ⚠️ `status: inferred` — 크론·초기화·라우트는 코드로 확인했지만 **생성 로직 본문은 아직 정독하지 않았다.** 여기 적힌 동작을 믿고 고치기 전에 `api/monthlyReportModule.js`를 열어 볼 것.

## 한 줄

한 달치 진도를 모아 학생별 월간 리포트를 만든다. **매달 4번째 토요일** 자동 생성.

## 흐름

```
토요일 10:00 크론 발화
  → today.getDate() / 7 을 올림해 '몇 째 주'인지 계산
  → 4주차가 아니면 아무것도 안 함
  → 4주차면: 학생 명부 전체 조회
       → 학생마다 그 달 1일~말일 진도 조회
       → Gemini로 리포트 생성 → MONTHLY_REPORT_DB_ID 에 기록
```

수동 실행: `GET /api/manual-monthly-report-gen` (requireAuth). 보기: `/monthly-report`, URL 조회 `GET /api/monthly-report-url`(공개).

## 계약

- 🔴 **"4번째 토요일" 판정이 `Math.ceil(today.getDate() / 7) === 4`다** (`api/monthlyReportModule.js:593`). 날짜 기준이라 달의 시작 요일에 따라 사람이 세는 "네 번째 토요일"과 어긋날 수 있다. 옮기려면 이 식을 봐야 한다.
- 🔴 **크론 콜백 안의 `new Date()`는 서버 시간이다.** `timezone: 'Asia/Seoul'`은 발화 시각만 정한다 → [[kst-time]]
- **학생 명부 전체를 조회한다**(필터 없음). 95명 기준 4.3초 + 학생마다 진도 조회가 이어진다 — 이 시스템이 가장 무거운 배치다 → [[notion-latency]]
- 배포는 **토 09:55~10:05를 피하라** → [[render-manual-deploy]]

## 주입받는 것

`api/index.js:1095` — `app, fetchNotion, geminiModel, requireAuth, dbIds{STUDENT/PROGRESS/KOR_BOOKS/ENG_BOOKS/MONTHLY_REPORT/GRAMMAR}, domainUrl, publicPath` + 노션 헬퍼 4종. → [[module-di]]

## 확인해야 할 것

- 생성 실패 시 통지 경로가 있는가? (다른 시스템은 카카오워크로 올린다)
- 이미 있는 달을 다시 돌리면 멱등한가?
- `/api/student-history`, `/api/monthly-report-url`이 인증 없이 열려 있는데 의도된 것인가 → [[routes]]

관련: [[daily-report]] · [[cron-jobs]] · [[module-di]] · [[notion-latency]] · [[kst-time]]
