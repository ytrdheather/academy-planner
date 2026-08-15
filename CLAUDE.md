# readitude

리디플랜(Readiplan) — 학원 운영 자동화. Node/Express + Notion을 DB로 쓰는 서버 하나(`api/index.js`)와 정적 HTML 화면들(`public/views`).

## 작업 시작 전에 (중요)

**코드를 grep하기 전에 `wiki/index.md`를 먼저 읽어라.** 이 저장소는 위키 층을 갖고 있다. 시스템 계약, 공용 헬퍼, 크론 표, Notion DB 맵, 이미 밟은 지뢰가 전부 거기 정리돼 있다. 코드에서 다시 찾는 건 위키에 없을 때만.

```
wiki/index.md      ← 전체 카탈로그. 여기서 시작
wiki/SCHEMA.md     ← 위키 규칙과 ingest/query/lint 절차
wiki/log.md        ← 작업 이력
```

## 작업 끝나고

코드를 바꿨으면 영향받은 위키 페이지를 갱신하고 `wiki/log.md`에 한 줄 남긴다. 절차는 `/wiki-ingest`. 자세한 규칙은 `wiki/SCHEMA.md`.

## 이 저장소의 기본 규칙

- **Notion API는 반드시 `fetchNotion()`을 거친다** (`api/index.js:65`). 직접 `fetch`하지 마라 — 409 재시도와 헤더가 거기 들어있다. → `wiki/patterns/notion-fetch.md`
- **Notion 속성은 반드시 헬퍼로 읽는다** (`getRollupValue`, `getPropByKeywords` 등, `api/index.js:147`). 속성명이 노션에서 자주 바뀐다. → `wiki/patterns/notion-prop-read.md`
- **새 기능은 `api/*Module.js`로 분리하고 `initializeXxx({ app, fetchNotion, requireAuth, ... })`로 주입받는다.** `api/index.js`를 더 키우지 마라. → `wiki/patterns/module-di.md`
- **자동 배포가 꺼져 있다.** push해도 라이브에 반영되지 않는다. Render 대시보드에서 수동 배포. → `wiki/decisions/render-manual-deploy.md`
- 커밋·푸시·배포는 요청받았을 때만.
