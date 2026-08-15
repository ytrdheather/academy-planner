---
id: readiplan-brand
title: 브랜드와 테마 — 리디플랜(Readiplan)
type: decision
status: verified
source: memory/readiplan-brand.md (2026-07-21)
updated: 2026-08-15
tags: [brand, design, theme, logo]
---

## 결정

이 저장소(학원 관리 프로그램)의 이름은 **리디플랜 / Readiplan**이다. 상위 학교 브랜드는 **리디튜드(Readitude Language School)**이고, 리디플랜은 그 아래 운영·진도 관리 시스템의 이름이다.

**"레디"가 아니라 read 계열의 "리디"로 통일한다** (리디튜드와 철자·발음 일관성).

## 자산

- 로고 `public/assets/readiplan-logo.svg` — 부엉이 마스코트 + 가랜드 + 체크리스트 보드. 팔레트는 리디튜드 세이지/옐로우/차콜/틸 `#0d9488`
- 로그인 화면 2종(`login.html` 학생 / `teacher-login.html` 선생님)에 리디튜드 로고는 유지하고 하단에 리디플랜 로고를 220px "운영 시스템" 마크로 추가
- 워드마크는 Pretendard 임시 — 원본 리디튜드는 손글씨 레터링이라 질감이 다르다

## 민트 테마 (2026-07-21 롤아웃)

`manual.html`의 디자인 시스템이 기준이다 — 민트/틸 base `#f4f7f7` + 라디얼 `#e4f3f0`, accent `#0d9488`/`#0a6c62`, Pretendard(jsdelivr CDN), 라운드 카드 + 부드러운 그림자. 학생/선생님 로그인, 선생님 대시보드(`assets/teacher.css`), 학생 플래너를 보라→민트로 리스킨했다. **클래스·JS·구조는 그대로 두고 색·폰트만 교체.**

## 🔴 손대지 말 것 (TODO 아님)

- **`teacher.html`의 숙제생성·확정·문법코멘트 버튼만 의도적으로 보라(`#7c3aed`)·바이올렛(`#8b5cf6`)이다.** 잔재가 아니라 의도된 강조색. 유지할 것.
- **`exam-analyzer` · `student-grader` · `results-viewer` · `textbook-toc` · `management` · 데일리/먼슬리 리포트는 옛 보라 톤을 그대로 둔다.** "가끔 쓰는 특수 기능이라 그대로 둔다"고 사용자가 결정했다.

## 🔴 라이브가 아닌 폴더

중첩 폴더 `academy-planner/uri-hagweon-gwanri-peurogeuraem/`는 **별도의 옛 git 저장소**다. 라이브가 아니니 편집하지 마라. 라이브는 `api/index.js`(포트 5001), `publicPath` = 루트 `public/`.

## git 흐름

원격 `github.com/ytrdheather/academy-planner`, `main` 직접 커밋(리니어). 사용자가 집·직장 등 **여러 PC에서 같은 main에 작업**해서 리모트가 로컬보다 앞선 경우가 잦다. 커밋·푸시 시 **항상 `git fetch` + rebase 먼저.**

> ⚠️ 같은 메모리에 "푸시 시 Render auto-deploy 트리거"라고 적혀 있는데 **틀렸다** → [[render-manual-deploy]]

관련: [[views]] · [[render-manual-deploy]]
