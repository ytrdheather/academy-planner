# readitude

리디플랜(Readiplan) — 학원 운영 자동화. Node/Express + Notion을 DB로 쓰는 서버 하나(`api/index.js`)와 정적 HTML 화면들(`public/views`).

## 작업 시작 전에 (중요)

**코드를 grep하기 전에 `wiki/index.md`를 먼저 읽어라.** 이 저장소는 위키 층을 갖고 있다. 시스템 계약, 공용 헬퍼, 크론 표, Notion DB 맵, 이미 밟은 지뢰가 전부 거기 정리돼 있다. 코드에서 다시 찾는 건 위키에 없을 때만.

```
wiki/index.md      ← 전체 카탈로그. 여기서 시작
wiki/SCHEMA.md     ← 위키 규칙과 ingest/query/lint 절차
wiki/log.md        ← 작업 이력
```

## 절차는 스킬에 있다 — 이 파일에 옮겨 적지 마라

아래 작업을 할 때는 **해당 스킬을 먼저 열어라.** 여러 위키 페이지에 걸친 절차와 이미 사고가 난 지점이 정리돼 있다.

| 스킬 | 언제 |
|---|---|
| `/add-parent-message` | 학부모에게 나가는 알림톡·문자를 추가·수정할 때 **(사고 비용 최대)** |
| `/add-cron` | 새 스케줄 작업을 넣을 때 |
| `/add-module` | 새 기능을 붙일 때 |
| `/deploy-check` | 배포 전후 |
| `/diagnose-not-sent` | "안 나갔다" 진단할 때 |
| `/wiki-query` `/wiki-ingest` `/wiki-lint` | 위키에 묻기 / 흡수 / 검진 |

## 이 저장소의 기본 규칙

- **Notion API는 반드시 `fetchNotion()`을 거친다** (`api/index.js:65`). 직접 `fetch`하지 마라 — 409 재시도와 헤더가 거기 들어있다. → `wiki/patterns/notion-fetch.md`
- **Notion 속성은 반드시 헬퍼로 읽는다** (`getRollupValue`, `getPropByKeywords` 등, `api/index.js:147`). 속성명이 노션에서 자주 바뀐다. → `wiki/patterns/notion-prop-read.md`
- **새 기능은 `api/*Module.js`로 분리하고 `initializeXxx({ app, fetchNotion, requireAuth, ... })`로 주입받는다.** `api/index.js`를 더 키우지 마라. → `wiki/patterns/module-di.md`
- **자동 배포가 꺼져 있다.** push해도 라이브에 반영되지 않는다. Render 대시보드에서 수동 배포. → `wiki/decisions/render-manual-deploy.md`
- 커밋·푸시·배포는 요청받았을 때만.

## 🔴 이 파일을 키우지 마라

**이 파일은 매 세션 자동으로 컨텍스트에 들어간다.** 여기 붙는 한 줄은 모든 세션에서 값을 치르지만, 위키나 스킬에 적으면 그 작업을 할 때만 값을 치른다. **상한 200줄, 목표 50줄 이하.**

새로 알게 된 것을 적을 자리는 이렇게 고른다:

| 어디에 | 무엇을 |
|---|---|
| **여기(CLAUDE.md)** | 몰랐을 때 **사고가 나는** 것 + 항상 적용되는 것. 그리고 **한 줄 요약 + 포인터**만 |
| **스킬(`.claude/commands/`)** | 여러 페이지에 걸친 **다단계 절차**. 순서를 틀리면 비용이 나는 것 |
| **위키(`wiki/`)** | 사실·계약·근거·이력. 기본값은 여기다 |

애매하면 **위키**다. 여기 적고 싶어지면 "이걸 모든 세션이 알아야 하나?"를 먼저 물어라.
