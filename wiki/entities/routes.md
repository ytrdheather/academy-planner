---
id: routes
title: 라우트 맵
type: entity
status: verified
source: api/index.js, api/*Module.js
updated: 2026-08-15
tags: [express, routes, api]
---

## 정체

Express 라우트 전체. 🔓 = 인증 없음(공개), 그 외는 `requireAuth`. 화면 라우트는 정적 HTML만 내려주고, 데이터는 별도 `/api/*` 호출로 가져온다.

## 화면 라우트 (전부 🔓 — 정적 파일만 내려줌)

| 경로 | 화면 | 대상 |
|---|---|---|
| `/` | `login.html` | 로그인 |
| `/planner` | `planner-modular.html` | 학생 플래너 |
| `/teacher-login` `/teacher` | 교사 대시보드 | 교사 |
| `/manual` | 사용 설명서 | **교사용. 학부모에게 공유 금지** |
| `/install` | 설치 안내 | **학생·학부모 공유용** |
| `/welcome` `/w/:code` `/welcome-admin` | 등록 전 안내서 + 링크 생성 도구 | 신규 학부모 / 교사 |
| `/unlock` `/passwords` | 잠금 해제 / 비번 재발급 | 교사 |
| `/notice` | 공지 허브 | **학부모 (카카오 채널 홈)** |
| `/counsel` `/absence` `/calendar` | 상담·결석 신청 폼, 달력 | **학부모** |
| `/past-grammar` | 과거 문법 기록 | 교사 |
| `/exam-analyzer` `/student-grader` `/results-viewer` `/student-report` | 시험지 분석 4종 | 교사 |
| `/textbook-toc` `/shopping` | 교재 목차 파싱 / 장보기 목록 | 교사·조교 |
| `/messages` | 발송함 | 교사 |
| `/monthly-report` `/my-report` `/report` | 리포트 뷰 | 학생·학부모 |
| `/manifest.json` `/sw.js` `/assets/*` | PWA 자산 | |

## API — 공개 🔓 (학부모가 로그인 없이 쓰는 것만)

`GET /api/notice` · `POST /api/counsel` · `GET /api/counsel/done` · `GET /api/absence/options` · `POST /api/absence` · `GET /api/calendar` · `GET /api/welcome-info/:code` · `POST /api/kakao/skill`(챗봇 웹훅) · `GET /api/search-books` · `GET /api/search-sayu-books` · `GET|POST /api/textbook/act`(선생 승인 버튼, 토큰이 URL에) · `GET /api/student-history` · `GET /api/monthly-report-url`

## API — 인증 필요

로그인: `POST /login`(학생) · `POST /teacher-login` · `GET /api/user-info` `/api/teacher/user-info` `/api/student-info` `/api/teachers`

| 묶음 | 라우트 |
|---|---|
| 진도·숙제 | `/api/save-progress` `/api/get-today-progress` `/api/update-homework` `/api/generate-homework-preview` `/api/confirm-homework` `/api/auto-generate-homework` `/api/move-homework-track` `/api/pause-periods`(GET/POST/update) |
| 리포트·코멘트 | `/api/generate-daily-comment` `/api/generate-grammar-comment` `/api/daily-report-data` `/api/single-student-report` `/api/last-comment` `/api/generate-daily-reports` `/api/set-write-complete` `/api/admin/regenerate-urls` |
| 문법 | `/api/notion-grammar-options` `/api/past-grammar-data` `/api/update-grammar-by-class` `/api/update-grammar-comment-by-class` `/api/grammar-record` |
| 계정 | `/api/my-accounts` `/api/teacher/student-accounts` `/api/teacher/save-account` `/api/teacher/locked-accounts` `/api/teacher/unlock-account` `/api/teacher/passwords` `/api/teacher/reset-passwords` |
| 학생 전용 (`requireStudent`) | `/api/my-report-dates` `/api/my-report` `/api/my-homework` |
| 교재 | `/api/textbooks` `/api/parse-toc` `/api/textbook-units` `/api/save-textbook-units` `/api/set-textbook-meta` `/api/progress-config-data` `/api/update-student-progress` |
| 교재비 | `/api/textbook/tick` `/send-batch` `/notify-teachers` `/shopping-list` `/shopping-push` |
| 미도착 | `/api/arrival/tick` (`{dryRun:true}` 면 명단만, 발송·기록 안 함) → [[arrival-alert]] |
| 확정·발송 | `/api/confirm/auto-close` `/api/makeup/send-confirms` `/api/makeup/roster` `/api/counsel/send-confirms` `/api/counsel/remind` `/api/messages/sent` `/api/admission/tick` |
| 시험 | `/api/analyze-exam` `/save-exam-analysis` `/exam-list` `/grade-student` `/save-student-result` `/student-results` `/student-result-detail` `/regrade-exam` `/student-report-data` + 학생용 `/api/student/exam-list` `/exam-questions` `/submit-exam` |
| 기타 | `/api/calendar`(POST) `/api/prefill-holidays` `/api/manual-monthly-report-gen` |

## 주의

- **`/api/*/tick`, `/send-batch`, `/notify-teachers`, `/auto-close` 등은 크론의 수동 트리거다.** 크론을 기다리지 않고 지금 돌리고 싶을 때 쓴다 → [[cron-jobs]]
- 🔴 `/api/textbook/act`는 인증 없이 열려 있다. 선생님이 카카오워크 버튼을 누르는 자리라 그렇고, **URL에 실린 JWT가 유일한 방어**다.
- 화면 라우트는 인증을 안 건다. 보호는 화면이 뜬 뒤 `/api/*`에서 걸린다.
- `/manual`(교사용)과 `/install`(공유용)을 헷갈리지 마라 — `api/index.js:221` 주석.

관련: [[auth-jwt]] · [[views]] · [[module-di]] · [[cron-jobs]]
