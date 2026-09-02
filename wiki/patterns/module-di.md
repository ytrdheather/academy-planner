---
id: module-di
title: 새 기능 모듈 추가하는 정석 (의존성 주입)
type: pattern
status: verified
source: api/index.js:1114-1172, api/textbookFeeModule.js:41
updated: 2026-08-23
tags: [architecture, module, di]
---

## 문제

`api/index.js`가 3,782줄이다. 여기에 기능을 계속 붙이면 읽을 수도 고칠 수도 없어진다. 반대로 모듈이 `index.js`를 import하면 순환 참조가 나고, 각자 `process.env`와 Notion 클라이언트를 따로 들면 설정이 갈라진다.

## 해법

**모듈은 아무것도 import하지 않는다. 전부 주입받는다.**

각 `api/*Module.js`는 `initializeXxx({ ... })` 하나만 export하고, `index.js`가 필요한 걸 넘겨준다:

```js
// api/myFeatureModule.js
export function initializeMyFeature({ app, requireAuth, fetchNotion, dbIds }) {
  app.get('/api/my-feature', requireAuth, async (req, res) => { /* ... */ });
  cron.schedule('0 9 * * *', async () => { /* ... */ });
}
```

```js
// api/index.js — 초기화 블록(1078~1136)에 추가
try {
  initializeMyFeature({ app, requireAuth, fetchNotion, dbIds: { MY_DB_ID: process.env.MY_DB_ID } });
} catch (e) { console.error('My Feature Init Error', e); }
```

## 쓰는 법

**새 기능은 무조건 이 모양으로.** `index.js`에 라우트를 직접 더 붙이지 마라.

- 🔴 **`try/catch`로 감싼다.** 모듈 하나가 초기화에 실패해도 서버 전체가 죽으면 안 된다. 기존 8개 전부 이렇게 돼 있다 (`initializeBookRoutes`만 예외 — 맨 처음 것이라 안 감싸져 있다).
- 주입 가능한 것: `app`, `requireAuth`, `fetchNotion`, `sendKakaoWork`, `sendSms`, `cron`, `geminiModel`, `publicPath`, `path`, `domainUrl`, `jwtSecret`, `dbIds`, 그리고 노션 헬퍼(`getRollupValue`, `getSimpleText`, `getKSTTodayRange`, `getKoreanDate`).
- **알림 함수는 얇게 감싸서 넘기는 게 관례다.** `confirmNotifyModule`은 `sendKakaoWork`를 직접 받지 않고 `notifyChannel(title, body)` 형태로 채널이 이미 박힌 함수를 받는다 (`api/index.js:1167`) — 모듈이 conversation ID를 몰라도 되게.
- DB ID는 **낱개로 넘기지 말고 `dbIds: { ... }` 객체로** 모아 넘긴다.

## 안 되는 경우

- 모듈끼리 직접 import하지 마라. 공유가 필요하면 `index.js`를 거친다.
- 주입 목록이 8개를 넘어가면 그 모듈은 너무 많은 일을 하는 것이다. `textbookFeeModule`(749줄, 주입 12개)이 이미 그 경계에 있다.
- 🔴 `try/catch`가 에러를 **콘솔에만** 찍는다. 모듈이 조용히 안 뜬 채로 서버가 정상 기동한다. 새 기능 배포 후에는 Render 로그에서 `Init Error`를 확인하라.
- 🔴 **크론이 `initializeXxx()` 안에 같이 등록된다.** 모듈 하나를 로컬에서 확인하겠다고 `api/index.js` 를 띄우면 실전 발송 크론까지 켜진다. 검증할 모듈만 올린 하네스를 써라 → [[local-server-fires-crons]]

🔴 **`cron` 도 반드시 주입받아라.** 모듈이 `node-cron` 을 직접 import 하면 테스트에서 진짜 스케줄러가 떠 프로세스가 안 죽는다 — `monthlyReportModule` 이 실제로 이걸로 걸렸다. `dependencies.cron || nodeCron` → [[test-harness]]

관련: [[routes]] · [[notion-fetch]] · [[auth-jwt]] · [[kakaowork-notify]]
