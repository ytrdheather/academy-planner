---
id: student-profile
title: 학생 프로필 카드
type: system
status: verified
source: api/studentProfileModule.js (349줄), public/assets/student-profile.js, api/index.js:1028-1041
updated: 2026-08-23
tags: [profile, teacher, notion, privacy]
---

## 한 줄

**화면 어디서든 학생 이름을 누르면** 명부·문법·교재비·월간리포트·상담기록을 한 장으로 모아 보여준다. 2026-08-23 작성, 배포 전.

## 흐름

`GET /api/student-profile?name=&pageId=` → 명부 1건 + 넷을 `Promise.allSettled` 로 병렬 조회. 하나가 실패해도 나머지는 그리고 `failed[]` 로 표시한다.

- **진행중 교재** 명부 relation(어휘·주독해·부독해·더빙) + `loadTextbooks()` 캐시 · **문법** `문법반` + 문법숙제 관리 DB 최근 3건
- **진행했던 교재** 교재비 DB(`학생` relation) + 명부 `완료한 교재 리스트` · **수행율·과목평균·코멘트** 월간 리포트 DB · **상담 기록** `COUNSEL_LOG_DB_ID`

쓰기는 **둘만** 연다 — `POST .../attend-time`, `POST .../counsel-log`. 나머지는 읽기 전용이다. 프로필에서 명부를 마음대로 고치게 하면 숙제 자동 생성·미도착 알림이 조용히 어긋난다.

## 계약 (건드리면 안 되는 것)

- 🔴 **연락처는 원장 계정 하나만 본다.** `loginId === 'manager'` (`api/studentProfileModule.js:217`). **`role === 'manager'` 를 쓰면 5명이 뚫린다** → [[role-manager-is-not-owner]]. 화면 가리기가 아니라 서버가 안 내려보낸다. 근거(2026-08-23 원장): 상담 DM은 사건마다 한 건씩 오지만 프로필은 **87명이 한번에 좍** 보인다 — 성격이 다르다. 담임은 그 건의 번호를 이미 DM으로 받는다 (`api/index.js:518`) → [[counsel]]
- 🔴 **등원시각 드롭다운을 요일 6개 합집합으로 합치지 마라** (`:42-57`). 월수금 14~17시 / 화목 15~19시로 일부러 좁혀 둔 것이다 → [[arrival-alert]]. 저장 라우트도 그 요일 옵션 밖이면 400으로 거절한다 — 노션 선택 속성은 없는 이름을 PATCH하면 옵션을 새로 만든다.
- **문법 칸은 교재가 아니라 반 + 진도다.** 명부에 문법 교재 relation이 없다. 문법서는 `완료한 교재 리스트` 쪽에 나온다.
- **`counselLog`가 `null`이면 DB 미설정, `[]`면 기록 없음.** 화면이 둘을 다르게 그린다.
- 🔴 위젯이 `/assets/` 밑이라 **sw.js가 cache-first로 잡는다.** 고치면 부르는 쪽 `?v=` 를 올려라 → [[views]]

## 관련 코드

붙이는 법은 `<script src="/assets/student-profile.js?v=N">` 한 줄 + 이름을 `studentNameLink(이름, 명부pageId)` 로 감싸기. 붙은 곳 — `teacher.html`(7탭+진도 관리, `nameLink()` 로 한 번 감쌌다) · `past-grammar` · `passwords` · `results-viewer`. **진도 DB의 pageId를 넘겨도 안전하다** — 명부 페이지가 아니면 이름으로 되짚는다 (`:59-77`).

라우트 `api/studentProfileModule.js:199` `:290` `:316` · 주입 `api/index.js:1031` · 상담기록 DB → [[notion-databases]]

관련: [[counsel]] · [[arrival-alert]] · [[textbook-fee]] · [[monthly-report]] · [[module-di]] · [[auth-jwt]]
