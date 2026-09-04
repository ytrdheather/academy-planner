---
id: schema-check
title: 노션 스키마 드리프트 점검
type: system
status: verified
source: api/schemaCheckModule.js:1-144, api/notionSchema.js:1-83
updated: 2026-09-01
tags: [notion, schema, cron, safety]
---

## 한 줄

노션에서 속성 이름이 사라지거나 바뀌면 **매일 07:30(KST)** 에 잡아 원장 DM 으로 올린다. 이상 없으면 아무 말도 안 한다.

## 왜

이 저장소에서 가장 자주·가장 조용히 나는 사고가 "노션에서 이름을 바꿨더니 코드가 멈춘 것"이다. pitfalls 7장 중 **3장이 전부 이것**이다 → [[teacher-rollup-name]] · [[grammar-class-rename]] · [[textbook-name-whitespace]]

🔴 **노션은 없는 속성으로 필터를 걸거나 쓰면 값을 못 찾는 게 아니라 요청 자체를 400 으로 거절한다.** 그래서 속성 하나가 사라지면 그 기능이 통째로 죽는데, 화면엔 아무 말도 안 나온다. 과거 3건은 전부 며칠 뒤 사람이 눈으로 발견했다.

## 흐름

```
07:30 크론 → REQUIRED_PROPERTIES 의 DB 14개를 하나씩
  → GET /v1/databases/{id} 로 실제 속성 목록을 읽고
  → 선언된 이름이 없으면: 비슷한 이름이 있나 본다(공백 정규화)
       있으면 "'A' → 'B' 로 바뀐 것 같다"   없으면 "'A' 가 없다"
  → 어긋난 게 하나라도 있을 때만 원장 DM
```

수동: `POST /api/schema-check/tick` (requireAuth). 어긋난 목록·정상 DB 수를 그대로 돌려준다.

## 계약

- 🔴 **알림이 왔을 때 먼저 의심할 것은 노션이 아니라 선언이다.** 2026-09-03 첫 알림 3건이 전부 오탐이었다 — 코드에서 기계적으로 뽑을 때 추출 창이 넓어 **속성을 엉뚱한 DB 에 붙였다**(`책제목`→영어 원서, `문법 숙제 내용`→문법 원장). **노션에서 이름을 바꾼 기억이 없으면 노션을 건드리지 마라.**
- 🔴 **선언은 `api/notionSchema.js` 한 곳** (`REQUIRED_PROPERTIES`). 코드가 새 속성을 **필터·정렬·쓰기**에 쓰기 시작하면 여기에도 넣어라. 읽기만 하는 속성은 안 넣어도 된다 — 없으면 `undefined` 로 흘러가지 400 이 나지는 않는다.
- **속성이 늘어난 건 알리지 않는다.** 사라진 것만 본다. 노션에서 칸을 추가할 때마다 알림이 오면 아무도 안 본다.
- **정상이면 무소음.** 매일 "이상 없음"이 오면 그 알림은 곧 무시된다.
- 이름이 눈에 안 보이게 다를 때(NBSP·중복 공백)를 **개명 후보로 따로 보고**한다. `teacher-rollup-name` 때 원인 찾는 데 가장 오래 걸린 지점이다.
- DB 를 못 읽으면(`404`) 그것도 보고한다 — **통합 권한이 빠진 것도 조용한 킬러다.**
- env 가 없는 DB 는 조용히 건너뛴다(그 기능이 꺼져 있다는 뜻).
- 알림은 **원장 카카오워크 1:1 DM**(교재비 승인 요청이 오는 그 방, `KAKAOWORK_APPROVAL_CONV`)으로 간다 → [[env-vars]]
- 배포는 **07:25~07:35 를 피하라** → [[render-manual-deploy]]

## 주입받는 것

`api/index.js:1051` — `app, cron, requireAuth, fetchNotion, dbIds{14개}, notifyOwner`(원장 DM) → [[module-di]] · [[kakaowork-notify]]

관련: [[cron-jobs]] · [[notion-prop-read]] · [[notion-databases]] · [[routes]]
