---
id: grammar-comment
title: 반별 문법 코멘트
type: system
status: verified
source: api/index.js:1290-1942
updated: 2026-08-15
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

## 스키마 (2026-07-12 개편)

- GRAMMAR_DB: `반이름` 옵션에 라이브 6개 추가(F4, AlB, LS, M12B, 2M6, 1M6), `문법 코멘트`(rich_text)·`문법 테스트 내용`(multi_select) 추가
- PROGRESS: `문법 코멘트`(rich_text) 추가

## 화면

문법 관리 탭 '담당' 옆 `📝 문법 코멘트 작성` 버튼 → 미니 모달(반 선택 + AI 생성 + 저장). 과거 기록은 `/past-grammar`.

## 관련 코드

`api/index.js:1290`(AI 생성) · `:1611`(반 옵션) · `:1631`(과거 기록) · `:1717`(전체 저장) · `:1839`(코멘트만 저장) · `:1905`(오늘 기록 조회) · `findPageIdByTitle(..., '반이름')`은 select 필터로 분기 → [[notion-find-page]]

관련: [[daily-report]] · [[dashboard-cache]] · [[notion-find-page]] · [[notion-latency]]
