---
id: role-manager-is-not-owner
title: role 'manager' 는 원장이 아니다 (5명이다)
type: pitfall
status: verified
source: api/index.js:114-122, public/views/teacher.html:453-461
updated: 2026-08-23
tags: [auth, permission, privacy]
---

## 증상

"원장님만 보이게" 를 `req.user.role === 'manager'` 로 걸었는데 **7개 계정 중 5개가 통과했다.** 학부모 연락처를 원장 한 명에게만 열려던 것이 조교까지 다섯 명에게 열렸다 (2026-08-23, 배포 전 발견).

## 원인

`api/index.js:114` 의 계정 표에서 `role` 은 "원장"이 아니라 **"관리 권한"** 에 가깝다.

| 계정 | loginId | role |
|---|---|---|
| 원장 헤더쌤 | `manager` | manager |
| 조이쌤 · 주디쌤 · 앨리스쌤 | teacher1·2·5 | **manager** |
| 매니져조교 | manager2 | **manager** |
| 소영쌤 · 레일라쌤 | teacher3·4 | teacher |

## 고친 방법

`const isOwner = req.user?.loginId === 'manager';`

`loginId` 는 JWT payload에 들어 있고(`api/index.js:1898`), `/api/teacher/user-info` 가 그대로 돌려준다(`:1899`). **화면은 이미 이 구분을 하고 있었다** — `teacher.html` 의 `owner-only-link` 가 `loginId === 'manager'`(`:459`), `manager-only-link` 가 `role === 'manager'`(`:453`). 클래스 이름 두 개가 답을 갖고 있었는데 서버 쪽에서만 놓쳤다.

## 규칙

- **권한 층이 셋이다.** 넓은 순으로: 전원 → `role === 'manager'`(5명) → `loginId === 'manager'`(원장 1명).
- **"원장만" 이라는 요구를 받으면 `loginId` 다.** `role` 을 쓰면 조교가 포함된다.
- 계정을 늘리거나 role을 바꾸면 이 표도 같이 고쳐라. 계정은 평문 하드코딩이라 **재배포해야 반영된다** → [[auth-jwt]]
- 개인정보는 화면에서 가리지 말고 **서버가 안 내려보내게** 해라 → [[student-profile]]

관련: [[auth-jwt]] · [[student-profile]] · [[routes]]
