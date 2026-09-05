---
id: schema-check
title: 노션 스키마 드리프트 점검
type: system
status: verified
source: api/schemaCheckModule.js:1-147, api/notionSchema.js:1-128, api/index.js:1059-1074
updated: 2026-09-05
tags: [notion, schema, cron, safety]
---

## 한 줄

노션에서 속성 이름이 사라지거나 바뀌면 **매일 07:30(KST)** 에 잡아 원장 DM 으로 올린다. 이상 없으면 아무 말도 안 한다.

## 왜

🔴 **노션은 없는 속성으로 필터를 걸거나 쓰면 요청 자체를 400 으로 거절한다.** 속성 하나가 사라지면 그 기능이 통째로 죽는데 화면엔 아무 말도 안 나온다. 이 저장소 pitfalls 3장이 전부 이것이고 과거 3건은 전부 며칠 뒤 사람이 눈으로 발견했다 → [[teacher-rollup-name]] · [[grammar-class-rename]] · [[textbook-name-whitespace]]

## 흐름

```
07:30 크론 → REQUIRED_PROPERTIES 의 DB 16개를 하나씩
  → GET /v1/databases/{id} 로 실제 속성 목록을 읽고
  → 없으면 비슷한 이름을 찾는다(공백 정규화) → "'A'→'B' 로 바뀐 듯" / "'A' 가 없다"
  → 어긋난 게 하나라도 있을 때만 원장 DM
```

수동: `POST /api/schema-check/tick` (requireAuth). 어긋난 목록·정상 DB 수를 그대로 돌려준다.

## 계약

- 🔴 **알림이 왔을 때 먼저 의심할 것은 노션이 아니라 선언이다.** 2026-09-03 첫 알림 3건이 전부 오탐이었다 — 기계적으로 뽑을 때 추출 창이 넓어 **속성을 엉뚱한 DB 에 붙였다**(`책제목`→영어 원서). **노션에서 이름을 바꾼 기억이 없으면 노션을 건드리지 마라.**
- 🔴 **두 군데를 고쳐야 켜진다 — 선언만으로는 감시가 안 붙는다.** `notionSchema.js` 의 `REQUIRED_PROPERTIES` 에 넣고 `api/index.js:1061-1068` 의 `dbIds` 에도 넘겨야 한다. `dbIds[dbKey]` 가 없으면 `unconfigured` 로 **조용히 건너뛴다**(`schemaCheckModule.js:41`). 선언해 놓고 감시되는 줄 아는 상태가 된다.
- 🔴 **선언을 검증하는 유일한 수단은 라이브 대조다.** `node scripts/notion-inspect.mjs schema` — 코드·설계 문서·위키에는 개명 이전 이름이 남아 있을 수 있다. `.env` 는 **저장소 루트**에 있고 워크트리에는 없다(`NOTION_ENV_FILE` 로 가리켜라).
- 코드가 새 속성을 **필터·정렬·쓰기**에 쓰기 시작하면 선언에도 넣어라. 읽기만 하는 속성은 안 넣어도 된다 — 없으면 `undefined` 로 흘러가지 400 이 나지는 않는다.
- **속성이 늘어난 건 알리지 않는다.** 사라진 것만 본다.
- **정상이면 무소음.** 매일 "이상 없음"이 오면 그 알림은 곧 무시된다.
- 눈에 안 보이는 차이(NBSP·중복 공백)는 **개명 후보로 따로 보고**한다. `teacher-rollup-name` 때 가장 오래 걸린 지점이다.
- DB 를 못 읽으면(`404`) 그것도 보고한다 — **통합 권한이 빠진 것도 조용한 킬러다.**
- env 가 없는 DB 는 조용히 건너뛴다(그 기능이 꺼져 있다는 뜻).
- 알림은 **원장 카카오워크 1:1 DM**(`KAKAOWORK_APPROVAL_CONV`) → [[env-vars]] · 배포는 **07:25~07:35 를 피하라** → [[render-manual-deploy]]

## 감시 대상

**16개.** 교재비(`TEXTBOOK_FEE_DB_ID`, 속성 20개, `notionSchema.js:87`)는 2026-09-05 에야 들어왔다 — **학부모에게 돈 얘기가 나가는데 유일하게 감시 밖이었다.** 그 20개에 든 `미입금 안내일시` 는 나중에 손으로 붙인 속성인데(`scripts/add-unpaid-property.mjs`) 독촉 중복을 막는 필터 열쇠라, 사라지면 월요일 11:10 독촉이 통째로 죽는다 → [[textbook-fee]]

`api/index.js:1059` 에서 `app, cron, requireAuth, fetchNotion, dbIds{16개}, notifyOwner` 를 주입받는다 → [[module-di]] · [[kakaowork-notify]]

관련: [[cron-jobs]] · [[notion-prop-read]] · [[notion-databases]] · [[routes]] · [[stale-head-line-refs]]
