---
id: notion-prop-read
title: Notion 속성 값 읽기
type: pattern
status: verified
source: api/index.js:147-186
updated: 2026-08-15
tags: [notion, rollup, helper]
---

## 문제

Notion의 속성 값은 타입마다 모양이 전부 다르다. `title`은 배열, `rich_text`도 배열, `select`는 `{name}`, 롤업은 그 안에 또 타입이 중첩된다. 그리고 **속성 이름이 노션 UI에서 사람 손으로 자주 바뀐다** — 뒤에 공백이 붙거나 이모지가 붙거나. 하드코딩한 키로 읽으면 어느 날 조용히 빈 값이 된다.

## 해법

`api/index.js:147-186`의 헬퍼 4종:

| 함수 | 쓰임 |
|---|---|
| `getRollupArray(prop)` | 롤업 배열 전체를 값 배열로. number/select/title/rich_text 처리 |
| `getRollupValue(prop, isNumber)` | 롤업의 **첫 값 하나**만. 숫자 롤업이면 `.number` 직행 |
| `getSimpleText(prop)` | rich_text/title/select를 문자열로. rich_text는 조각을 `\n`으로 이음 |
| `getPropByKeywords(props, ['담당','쌤'])` | **키워드가 전부 포함된 첫 속성**을 찾아준다. 이름이 흔들려도 잡힌다 |

```js
const teacher = getRollupValue(getPropByKeywords(p, ['담임']));
const scores  = getRollupArray(p['점수들']);
```

## 쓰는 법

- **속성명이 사람 손을 탈 수 있으면 `getPropByKeywords`를 먼저 써라.** 학생/진도 DB가 특히 그렇다.
- 롤업에서 값 **하나**만 필요하면 `getRollupValue`. 전부 필요하면 `getRollupArray`.
- 모듈 안에서는 주입받아 쓴다 — `monthlyReportModule`은 `getRollupValue`, `getSimpleText`를 파라미터로 받는다 (`api/index.js:1084`).

## 안 되는 경우

- `getPropByKeywords`는 **첫 매치**만 준다. `['이름']`처럼 느슨한 키워드는 '이름'과 '학부모이름'을 구분 못 한다. 키워드를 2개 이상 줘서 좁혀라.
- `getRollupValue`는 롤업이 비어 있으면 `''`(또는 `isNumber`면 `null`)를 준다. `0`과 빈 값이 둘 다 falsy라 숫자 롤업은 `?? `로 판별해야 한다.
- **롤업이 `people` 타입을 물고 오면 이 헬퍼들은 `null`을 준다.** 실제로 사고가 났던 지점 → [[teacher-rollup-name]]
- 이 헬퍼들은 `formula`, `date`, `multi_select`, `relation`을 다루지 않는다. 그건 그때그때 직접 깐다.

관련: [[notion-fetch]] · [[teacher-rollup-name]] · [[notion-databases]]
