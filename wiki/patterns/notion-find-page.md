---
id: notion-find-page
title: 제목으로 Notion 페이지 찾기
type: pattern
status: verified
source: api/index.js:193-205
updated: 2026-08-25
tags: [notion, query]
---

## 문제

"이 학생/이 책의 페이지 ID"가 필요한 상황이 계속 나온다. 그런데 DB마다 제목 역할을 하는 속성의 **타입이 다르다** — 어떤 건 진짜 `title`, `책제목`은 `rich_text`. 필터 문법이 타입마다 달라서 하나로 못 짠다.

## 해법

`findPageIdByTitle(databaseId, title, titlePropertyName = 'Title')` — `api/index.js:193`

속성 이름을 보고 필터 타입을 갈아 끼운다:

```js
let filterBody = { property: titlePropertyName, title: { equals: title } };
if (titlePropertyName === '책제목') filterBody = { property: titlePropertyName, rich_text: { equals: title } };
```

🔴 **`반이름`(select) 분기가 있었는데 2026-08-25 지웠다.** 호출자가 없는 죽은 코드였고, 남겨 두면
따라 쓰기 쉬운 함정이었다 — **select 로는 페이지를 찾지 마라.** 등록되지 않은 옵션 이름으로
필터를 걸면 노션이 쿼리 자체를 거부한다 → [[grammar-class-rename]]

`page_size: 1`로 첫 건만 가져오고, 없으면 `null`.

## 쓰는 법

```js
const pageId = await findPageIdByTitle(STUDENT_DATABASE_ID, '홍길동', '이름');
```

## 안 되는 경우

- **실패를 삼킨다.** `try/catch`가 에러를 먹고 `null`을 준다. "못 찾았다"와 "Notion이 죽었다"가 구분되지 않는다. 중요한 흐름이면 `null`일 때 따로 로그를 남겨라.
- **동명이인을 구분 못 한다.** 첫 건만 준다. 학생은 `lookupStudentByName`(`api/index.js:432`)을 써라 — 그건 `DUPLICATE` 상태를 따로 돌려준다.
- 새 DB의 제목 속성이 또 다른 타입(예: `number`)이면 이 함수의 분기를 늘려야 한다. **속성 이름으로 하드코딩 분기하는 구조**라 확장할 때마다 손을 대야 한다.

관련: [[notion-fetch]] · [[notion-prop-read]] · [[notion-databases]] · [[grammar-class-rename]]
