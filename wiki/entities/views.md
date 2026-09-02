---
id: views
title: 화면 (public/views)
type: entity
status: verified
source: public/views/, api/index.js:218-241, 300, 459, 742, 928
updated: 2026-08-23
tags: [frontend, html, pwa]
---

## 정체

정적 HTML 28개. 빌드 스텝 없음 — 파일이 그대로 나간다. 데이터는 전부 `/api/*` fetch. PWA(`manifest.json` + `sw.js`)로 학생 폰에 앱처럼 설치된다.

## 표

**학생·학부모**

| 파일 | 경로 | 무엇 |
|---|---|---|
| `login.html` | `/` | 학생 로그인 |
| `planner-modular.html` | `/planner` | **학생 메인.** 진도·숙제 |
| `planner-test.html` | `/planner-test` | 플래너 실험판 |
| `my-report.html` | `/my-report` | 내 리포트 |
| `student-report.html` | `/student-report` | 학생 시험 결과 |
| `student-grader.html` | `/student-grader` | 학생 채점 응시 |
| `dailyreport.html` / `monthlyreport.html` | `/report`, `/monthly-report` | 리포트 뷰 |
| `install.html` | `/install` | **설치 안내 (공유용)** |
| `welcome.html` | `/welcome`, `/w/:code` | 등록 전 안내서 |
| `notice.html` | `/notice` | **공지 허브 (카카오 채널 홈)** |
| `counsel.html` | `/counsel` | 재원생 상담 신청 |
| `absence.html` | `/absence` | 결석·보강 신청 |
| `calendar.html` | `/calendar` | 학사일정 |

**교사·원장·조교**

| 파일 | 경로 | 무엇 |
|---|---|---|
| `teacher-login.html` / `teacher.html` | `/teacher-login`, `/teacher` | **교사 메인 대시보드** |
| `teacher-dashboard.html` | — | (구버전 흔적) |
| `management.html` | — | 관리 화면 |
| `manual.html` | `/manual` | **교사용 설명서. 학부모 공유 금지** |
| `welcome-admin.html` | `/welcome-admin` | 안내서 링크 생성 |
| `unlock.html` / `passwords.html` | `/unlock`, `/passwords` | 잠금 해제 / 비번 재발급 |
| `past-grammar.html` | `/past-grammar` | 과거 문법 기록 |
| `exam-analyzer.html` / `results-viewer.html` | `/exam-analyzer`, `/results-viewer` | 시험지 분석·결과 |
| `textbook-toc.html` | `/textbook-toc` | 교재 목차 파싱(스크린샷 업로드) |
| `shopping.html` | `/shopping` | 조교 장보기 목록 |
| `messages.html` | `/messages` | 발송함 |
| `config.js` | — | 프론트 공통 설정 |
| `assets/student-profile.js` | — | **학생 프로필 카드 위젯.** 어느 화면이든 `<script>` 한 줄로 붙는다 → [[student-profile]] |

## 주의

- 🔴 **화면 라우트에는 인증이 없다.** HTML은 누구나 받는다. 실제 보호는 화면이 뜬 뒤 `/api/*`에서 → [[auth-jwt]]
- `/w/:code`는 **아이디를 URL에 담지 않는다.** 페이지가 열린 뒤 `/api/welcome-info/:code`로 받아온다 (`api/index.js:228` 주석).
- 목차 스크린샷 업로드 때문에 `express.json({ limit: '25mb' })`가 걸려 있다 (`api/index.js:206`).
- `sw.js`(서비스워커) 때문에 **화면을 고쳐도 학생 폰에 바로 반영 안 될 수 있다.** 캐시 무효화를 확인하라.
- 🔴 **`/assets/*` 는 cache-first 다** (`public/sw.js:26`). HTML·API 는 항상 네트워크지만 assets 는 한 번 받으면 굳는다. `assets/` 의 JS 를 고치면 부르는 쪽 `?v=` 를 올리거나 `CACHE_VERSION`(`sw.js:4`)을 올려라.
- `teacher-dashboard.html`, `management.html`, `planner-test.html`은 라우트에 안 걸려 있거나 실험용이다. 지우기 전에 확인 필요.

관련: [[routes]] · [[auth-jwt]] · [[readiplan-brand]]
