---
id: grammar-comment
title: 반별 문법 코멘트
type: system
status: verified
source: api/index.js:1198-1882, api/studentProfileModule.js:98-121
updated: 2026-08-25
tags: [grammar, projection, notion, gemini]
---

## 한 줄

반별로 문법 코멘트를 **한 번** 쓰면 그 반 학생 개별 데일리 코멘트에 자동으로 들어간다. 2026-07-12 구현·검증 완료.

## 아키텍처 결정 — 원장(ledger)과 투사(projection)

`GRAMMAR_DB`("NEW 문법숙제 관리")를 **반별 문법 원장**으로 부활시키고, `PROGRESS_DATABASE_ID`("NEW 리디튜드 학생 진도 관리")를 거기서 학생별로 **투사되는 사본**으로 본다. 진실은 GRAMMAR_DB에 하나 있고, 학생 행은 복사본이다.

## 흐름

```
문법 관리 탭에서 반 + 날짜 선택
  → 진도/과제/테스트/코멘트 입력
  → POST /api/update-grammar-by-class
      ① GRAMMAR_DB에 (반,날짜) upsert  제목 = {반}-{날짜}
      ② 그 반 PROGRESS 그날 행 전원에 투사 (300ms 딜레이·스트리밍)
  → 개별 코멘트 생성 시 인사말 바로 뒤에 원문 그대로 삽입
```

PROGRESS 행은 매일 아침 이미 생성돼 있어 **타이밍 구멍이 없다** → [[homework-automation]]. 반 선택 시 `GET /api/grammar-record`로 오늘 기록을 프리필한다.

## 계약

- 🔴 **문법 코멘트는 AI를 거치지 않는다.** 인사말("오늘의 리디튜더 {이름}의 일일 학습 리포트📑…") 바로 뒤에 **코드가 원문 그대로 삽입**한다. AI 각색을 막기 위해서다. 개인 키워드·결과 브리핑만 AI가 담당 → [[daily-report]]
- **300ms 딜레이는 노션 초당 3요청 제한 때문이다.** 줄이지 마라 → [[notion-latency]]
- 코멘트만 저장하는 경로가 따로 있다 — `POST /api/update-grammar-comment-by-class`는 **진도·과제를 보존**한다. 전체 저장(`update-grammar-by-class`)과 헷갈리지 말 것.
- AI 생성(`POST /api/generate-grammar-comment`)은 **반 공통**이라 이름·점수·인사말 없이 문법 서술만 만든다.
- `dashboardCache.pastGrammar` TTL 5분. 문법 저장 경로가 무효화한다 → [[dashboard-cache]]
- 🔴 **원장 행은 제목(`이름` = `{반}-{날짜}`)으로 찾는다. `반이름`(select)으로 찾지 마라.** 반 이름이 바뀌면 옵션 목록에 없는 값이 되고 노션이 쿼리 자체를 거부한다 → [[grammar-class-rename]]
- `반이름` 칸은 **사람이 노션에서 눈으로 보는 용도로만** 남아 있다. 쓰기 직전 `ensureGrammarClassOption()` 이 옵션을 자동으로 붙이므로 손으로 채울 일이 없다. 이 속성을 지워도 저장은 계속된다.

## 스키마

**2026-07-12 개편** — GRAMMAR_DB: `반이름` 옵션에 라이브 6개 추가(F4, AlB, LS, M12B, 2M6, 1M6), `문법 코멘트`(rich_text)·`문법 테스트 내용`(multi_select) 추가. PROGRESS: `문법 코멘트`(rich_text) 추가.

**2026-08-25** — 손으로 채우던 그 옵션 목록이 정확히 사고를 냈다(M12B → M1B 개명). 이제 코드가 채운다.

행 하나를 특정하는 열쇠:

| DB | 열쇠 | 비고 |
|---|---|---|
| GRAMMAR_DB (원장) | 제목 `이름` = `{반}-{날짜}` | 예: `M1B-2026-08-25` |
| PROGRESS (투사본) | `🕐 날짜` + `문법클래스` 롤업 문자열 비교 | 롤업이라 개명이 즉시 따라온다 |

## 화면

문법 관리 탭 '담당' 옆 `📝 문법 코멘트 작성` 버튼 → 미니 모달(반 선택 + AI 생성 + 저장). 과거 기록은 `/past-grammar`.

## 관련 코드

`api/index.js:1198`(AI 생성) · `:1535`(테스트 태그 옵션) · `:1555`(과거 기록) · `:1649`(`grammarRowFilter` — 원장 행 열쇠) · `:1659`(`ensureGrammarClassOption`) · `:1685`(전체 저장) · `:1803`(코멘트만 저장) · `:1866`(오늘 기록 조회) · `api/studentProfileModule.js:98`(프로필 카드의 최근 문법)

관련: [[daily-report]] · [[dashboard-cache]] · [[grammar-class-rename]] · [[notion-find-page]] · [[notion-latency]] · [[student-profile]]
