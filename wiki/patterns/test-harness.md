---
id: test-harness
title: 모듈을 진짜 발송 없이 검증하는 법
type: pattern
status: verified
source: test/fakes.mjs, test/*.test.mjs, package.json
updated: 2026-09-01
tags: [test, harness, safety]
---

## 문제

🔴 **로컬에서 서버를 통째로 띄우면 학부모에게 진짜 알림톡이 나간다.** 5분 크론 셋이 실전 발송을 한다 → [[local-server-fires-crons]]

그래서 검증은 늘 "모듈 하나만 올리고 바깥은 전부 가짜"였는데, **그 하네스를 매번 새로 짜고 버렸다.** 하루에 네 번 짠 날도 있다.

## 해법

`test/fakes.mjs` 에 가짜 바깥세상을 두고 `npm test` 로 돌린다. 러너는 Node 내장(`node --test`)이라 의존성이 없다.

```bash
npm test
```

| 가짜 | 무엇 |
|---|---|
| `fakeNotion(databases)` | 쿼리·retrieve·페이지 생성/수정. `.queries` `.writes` 에 **무엇을 어떻게 물었나**가 쌓인다 |
| `fakeApp()` | `routes['POST /api/x']` 로 핸들러를 직접 부른다 |
| `fakeCron()` | 등록만 하고 **스스로 절대 안 돈다.** `jobs[0].run()` 으로 부른다 |
| `fakeGemini(text)` · `fakeNotify()` · `fakeSend()` | 프롬프트·통지·발송을 배열로 모은다 |
| `prop.*` · `page()` | 노션 속성 값을 실제 응답 모양으로 만든다 (`prop.formulaNumber(87.777…)` 등) |
| `helpers` | 모듈이 주입받는 노션 헬퍼 5종의 최소 구현 |

## 쓰는 법

```js
const notion = fakeNotion({ 'db-x': { rows: [page('p1', { 이름: prop.title('김리디') })] } });
initializeXxx({ app: fakeApp(), cron: fakeCron(), fetchNotion: notion.fetchNotion, ...helpers });
```

`rows` 에 함수를 주면 `(body) => rows` 로 필터별 응답을, 봉투째(`{results, has_more, next_cursor}`) 돌려주면 **페이지네이션**을 흉내낼 수 있다. `Error` 를 주면 그 DB 는 던진다(404·409 재현).

## 안 되는 경우

- 🔴 **모듈이 `cron` 을 주입받지 않으면 테스트가 멈춘다.** 진짜 node-cron 이 스케줄을 잡고 프로세스가 안 죽는다. `monthlyReportModule` 이 실제로 이걸로 걸렸고, 그래서 `dependencies.cron || nodeCron` 으로 고쳤다 → [[module-di]]
- 필터는 **기록만 하고 실행하지 않는다.** "이 필터로 물었는가"는 검사할 수 있지만 필터가 맞는 행을 고르지는 않는다. 필요하면 `rows` 함수에서 직접 갈라라.
- 노션 응답의 모든 모양을 흉내내지는 않는다. 없는 요청에는 **일부러 던진다** — 조용히 `{}` 를 주면 테스트가 거짓으로 통과한다.

관련: [[local-server-fires-crons]] · [[module-di]] · [[notion-fetch]] · [[monthly-report]] · [[schema-check]]
