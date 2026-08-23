---
id: notion-fetch
title: Notion API 호출 (fetchNotion)
type: pattern
status: verified
source: api/index.js:66-97
updated: 2026-08-15
tags: [notion, http, retry]
---

## 문제

Notion API를 직접 `fetch`하면 세 가지에 매번 걸린다. (1) 같은 페이지를 동시에 건드리면 **409 Conflict**가 나는데, 크론과 사용자 요청이 겹치면 흔하다. (2) `Notion-Version` 헤더를 빠뜨리면 스키마가 예고 없이 달라진다. (3) GET에 `body`를 실어 보내면 Notion이 거부한다 — 옵션 객체를 재사용하다 보면 쉽게 생긴다.

## 해법

`fetchNotion(url, options, retries = 3)` — `api/index.js:66`

- 409면 **500ms 쉬고 재귀 재시도**, 기본 3회
- `Notion-Version: 2022-06-28` 고정
- method가 없거나 GET이면 `body`를 지우고 보낸다
- 그 외 실패는 에러 본문을 콘솔에 찍고 `throw`

```js
const data = await fetchNotion(`https://api.notion.com/v1/databases/${dbId}/query`, {
  method: 'POST',
  body: JSON.stringify({ filter, page_size: 100 })
});
```

## 쓰는 법

- **`api/index.js` 안에서는 그냥 부른다.**
- **`api/*Module.js` 안에서는 절대 import하지 말고 주입받는다.** `initializeXxx({ fetchNotion, ... })` — [[module-di]]
- 페이지네이션은 이 함수가 안 해준다. 100건 넘는 조회는 `has_more`/`next_cursor`를 직접 돌려야 한다.

## 안 되는 경우

- **429(rate limit)는 재시도하지 않는다.** 409만 잡는다. 대량 루프를 돌릴 거면 호출 사이에 딜레이를 직접 넣어라.
- 재시도가 3회를 다 쓰면 그냥 던진다. 크론에서 부를 땐 `.catch()`로 감싸라 — 안 그러면 그날 배치 전체가 죽는다.
- 응답이 느린 건 이 함수 탓이 아니라 Notion 자체가 느린 것 → [[notion-latency]]

관련: [[notion-prop-read]] · [[notion-find-page]] · [[external-services]]
