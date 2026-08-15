---
id: cron-jobs
title: 크론 잡 전체 (13개)
type: entity
status: verified
source: api/index.js, api/confirmNotifyModule.js, api/textbookFeeModule.js, api/monthlyReportModule.js, api/admissionModule.js
updated: 2026-08-15
tags: [cron, schedule, automation]
---

## 정체

`node-cron`으로 서버 프로세스 안에서 도는 스케줄 13개. **전부 `{ timezone: 'Asia/Seoul' }`을 명시**하므로 아래 시각은 한국 시간이다.

## 표

| 시각(KST) | cron | 위치 | 하는 일 |
|---|---|---|---|
| 5분마다 | `*/5 * * * *` | `textbookFeeModule.js:707` | 교재비 tick — 원장 알림·발송·보류·정리 |
| 5분마다 | `*/5 * * * *` | `admissionModule.js:162` | 신입생 상담 예약확인 알림톡. 노션 `발송` 체크박스가 방아쇠 |
| 5분마다 | `*/5 * * * *` | `confirmNotifyModule.js:369` | 보강 확정 + 통화 확정 알림톡. 노션 `확정발송` 체크가 방아쇠 |
| 04:00 매일 | `0 4 * * *` | `confirmNotifyModule.js:386` | 지난 보강·지각·상담 건 자동 마감 |
| 08:00 매일 | `0 8 * * *` | `confirmNotifyModule.js:378` | 그날 보강 명단 발송 (없으면 조용) |
| 10:00 월요일 | `0 10 * * 1` | `textbookFeeModule.js:739` | 조교 장보기 목록 → `KAKAOWORK_ASSISTANT_CONV` |
| 10:00 토요일 | `0 10 * * 6` | `monthlyReportModule.js:591` | **그 달 4번째 토요일이면** 월간 리포트 생성 |
| 10:20 매일 | `20 10 * * *` | `api/index.js:2865` | 데일리 리포트 행 자동 생성 |
| 11:00 매일 | `0 11 * * *` | `api/index.js:3589` | 숙제 자동 생성. 정지 기간이면 건너뜀 |
| 14:00 평일 | `0 14 * * 1-5` | `textbookFeeModule.js:729` | 교재비 담당쌤 알림 — 하루치를 **묶어서 한 통** |
| 16:00 매일 | `0 16 * * *` | `api/index.js:715` | 방치된 상담 건 리마인드 (담임 → 없으면 원장) |
| 21:00 금요일 | `0 21 * * 5` | `textbookFeeModule.js:720` | **교재비 학부모 묶음 발송** |
| 22:00 매일 | `0 22 * * *` | `api/index.js:2798` | 그날 진도 행에 `데일리리포트URL` 채우기 |

## 쓰는 곳

주간 리듬이 요일로 갈려 있다 — 선생 신청(월~목 밤10시) → 원장 승인(금) → 학부모 발송(금 21시) → 조교 장보기(월·화). 시각 하나를 바꾸면 이 사슬이 흔들린다. [[textbook-fee]] 참고.

5분 크론 3개는 **노션 체크박스가 방아쇠**인 구조다. 사람이 노션에서 체크 → 5분 안에 나감. 즉시 발송이 필요하면 대응하는 `/api/*/tick` 라우트를 직접 부르면 된다.

## 주의

- 🔴 **크론은 서버 프로세스 안에 있다.** Render가 슬립하거나 재시작하면 그 시각 잡은 그냥 안 돈다. 재시도 큐가 없다.
- 🔴 **새 크론에 `{ timezone: 'Asia/Seoul' }`을 빠뜨리지 마라.** 지금 13개 전부 갖고 있다.
- 크론 콜백 안의 맨 `new Date()`는 서버 시간이다 → [[kst-time]]
- 각 크론은 `try/catch`로 감싸져 있어 실패해도 다음 회차는 돈다. 다만 **실패가 콘솔에만 남는다** — 조용한 실패를 잡으려면 Render 로그를 봐야 한다.

관련: [[kst-time]] · [[textbook-fee]] · [[homework-automation]] · [[daily-report]] · [[absence-notice]] · [[counsel]]
