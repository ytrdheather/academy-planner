---
id: auth-jwt
title: 로그인·인증 (JWT)
type: pattern
status: verified
source: api/index.js:110-128, 207-214, 2673-2676
updated: 2026-08-15
tags: [auth, jwt, middleware]
---

## 문제

교사와 학생이 같은 서버를 쓰는데 사용 방식이 정반대다. 교사는 학원 공용 PC에서 쓰고, 학생은 개인 폰에 PWA로 깔아 쓴다. 세션 길이를 하나로 맞추면 한쪽이 반드시 불편해진다.

## 해법

**토큰 수명을 역할로 가른다** — `generateToken(userData)`, `api/index.js:124`

| 역할 | 수명 | 이유 |
|---|---|---|
| `student` | **30일** | 개인 폰의 앱. 매일 로그인시키면 안 쓴다 |
| `teacher` / `manager` | **24시간** | 공용 PC. 짧게 |

미들웨어 2단:

- `requireAuth` (`api/index.js:207`) — `Authorization: Bearer <token>` 검증 → `req.user`에 payload
- `requireStudent` (`api/index.js:2673`) — `requireAuth` **뒤에** 붙여서 `role === 'student'`만 통과 (403)

```js
app.get('/api/my-report', requireAuth, requireStudent, handler);
```

## 쓰는 법

- **모든 `/api/*` 라우트에 `requireAuth`를 붙인다.** 예외는 학부모용 공개 폼뿐 — `/api/notice`, `/api/counsel`, `/api/absence`, `/api/calendar`(GET), `/api/welcome-info/:code`.
- 모듈 안에서는 `initializeXxx({ requireAuth, ... })`로 주입받는다 — [[module-di]]
- `req.user`에는 `{ loginId, name, role }`(교사) 또는 `{ userId, name, role }`(학생)이 들어있다.

## 안 되는 경우

- 🔴 **교사 계정이 `api/index.js:111-119`에 평문 하드코딩돼 있고 비밀번호가 전원 동일하다.** 계정을 추가하려면 코드를 고치고 재배포해야 한다.
- 🔴 `JWT_SECRET`에 **개발용 기본값 폴백**이 있다 (`api/index.js:24`). Render에 env가 없으면 그 값으로 서명된다.
- 학생 30일 토큰은 무효화 수단이 없다. 잠금·비번 재발급은 다음 로그인부터 적용된다.

관련: [[module-di]] · [[routes]] · [[views]]
