---
description: 새 기능을 api/*Module.js 로 분리해 추가한다. index.js를 더 키우지 않기 위한 주입 절차
argument-hint: [무슨 기능인지]
---

**대상**: $ARGUMENTS

🔴 **`api/index.js`는 이미 3,782줄이다. 여기에 라우트를 직접 더 붙이지 마라.**

먼저 `wiki/patterns/module-di.md`를 읽는다.

## 1. 모듈 파일

`api/xxxModule.js`. **아무것도 import하지 않고 전부 주입받는다.**

```js
export function initializeXxx({ app, requireAuth, fetchNotion, dbIds }) {
  app.get('/api/xxx', requireAuth, async (req, res) => { ... });
}
```

주입 가능한 것: `app` `requireAuth` `fetchNotion` `sendKakaoWork` `sendSms` `cron` `geminiModel` `publicPath` `path` `domainUrl` `jwtSecret` `dbIds` + 노션 헬퍼(`getRollupValue` `getSimpleText` `getKSTTodayRange` `getKoreanDate`)

- DB ID는 낱개가 아니라 **`dbIds: { ... }` 객체**로 받는다
- 알림 함수는 채널이 이미 박힌 얇은 함수로 받는 게 관례다 (`notifyChannel(title, body)`, `api/index.js:1131`)
- **주입 목록이 8개를 넘으면 그 모듈이 일을 너무 많이 하는 것이다.** 쪼갤지 검토한다

## 2. index.js 초기화 블록 (1078~1136)

```js
try {
  initializeXxx({ app, requireAuth, fetchNotion, dbIds: { XXX_DB_ID: process.env.XXX_DB_ID } });
} catch (e) { console.error('Xxx Init Error', e); }
```

🔴 **`try/catch`를 빼지 마라.** 모듈 하나가 죽어도 서버는 떠야 한다. 대신 **조용히 안 뜨므로**, 배포 후 Render 로그에서 `Init Error`를 확인한다.

## 3. 규칙

- **Notion은 반드시 주입받은 `fetchNotion`으로.** 직접 `fetch` 금지 → `wiki/patterns/notion-fetch.md`
- **속성은 헬퍼로 읽는다.** 이름이 바뀐다 → `wiki/patterns/notion-prop-read.md`
- **모든 `/api/*`에 `requireAuth`.** 예외는 학부모용 공개 폼뿐 → `wiki/patterns/auth-jwt.md`
- **노션에 필터를 넘겨라. 전체를 읽어 JS로 거르지 마라** → `wiki/pitfalls/notion-latency.md`
- **모듈끼리 직접 import 금지.** 공유는 `index.js`를 거친다
- 크론이 필요하면 → `/add-cron`
- 학부모 발송이 있으면 → `/add-parent-message`

## 4. 마무리

- `wiki/entities/routes.md`에 새 라우트 추가 (공개 🔓 여부 명시)
- 새 환경변수가 있으면 `wiki/entities/env-vars.md`, 새 DB면 `wiki/entities/notion-databases.md`
- 화면을 만들었으면 `wiki/entities/views.md`
- 기능이 하나의 업무 흐름이면 **`wiki/systems/`에 새 페이지**를 만든다
- `/wiki-ingest`로 마무리
