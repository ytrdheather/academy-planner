---
id: homework-track-move
title: 숙제 트랙 이동(<< >>)과 남은 횟수 배지
type: system
status: verified
source: api/index.js:3524-3700, public/views/teacher.html:1091-1500
updated: 2026-08-20
tags: [homework, textbook, ui]
---

## 한 줄

오늘 낸 숙제를 **한 묶음씩** 앞뒤로 옮기는 `<<` `>>` 버튼과, 교재 끝이 가까워지면 뜨는 **남은 횟수 배지**(교체 시기 알림).

## 흐름

- `<<` `>>` → `POST /api/move-homework-track`. 커서에서 역산하지 않고 **화면 문구에서 지금 위치를 읽어** 옮기고 문구·커서를 함께 다시 쓴다. 손으로 커서를 맞춰온 학생이 많아 커서와 문구가 이미 어긋나 있기 때문이다.
- 응답의 `remaining` 으로 그 칸 배지만 다시 칠한다(탭 전체 새로고침 없음).
- 배지: `5회`·`4회`…`2회` → `last` → `교재 끝`. **6회 이상이면 안 뜬다.**

## 계약 — 배지는 두 곳에서 계산된다. 같은 값이 나와야 한다

목록을 그릴 때는 **화면**이, `<<` `>>` 직후는 **서버**가 계산한다. 공식이 어긋나면 버튼 한 번에 숫자가 튄다.

| | 규칙 | 왜 |
|---|---|---|
| 책 길이 | 목차의 **마지막 순번** (`bookLength`) | `buildAssignment` 가 커서를 순번으로 비교한다(`api/index.js:3135`) |
| 나눗수 | **주간 평균** 배정량 (`avgPerTime`) | 그날 분량(`deadlineQuantity`)으로 나누면 요일마다 달라진다. 실측(월6·수4·금2, 커서45/총60): 예전 월3·수4·금8 → 지금 항상 4 |

목록 화면은 목차를 안 읽는다 — 87명×3과목을 조회하면 수십 초다([[notion-latency]]). 대신 교재 DB의 **`총유닛수` 한 칸**을 읽는다. 이건 목차의 사본이라 서버가 목차를 읽을 때 어긋나 있으면 맞춰 쓴다(`syncBookTotalUnits`). **목차 없는 교재의 `총유닛수`는 사람이 넣은 값이라 건드리지 않는다.** 2026-08-20 기준 목차 있는 교재 152권 전부 일치.

## 함정

- 수기로 쓴 숙제는 파싱도 안 되고 생성 이력도 없으면 **이동을 거부**한다(덮어쓰기 방지).
- 배지는 명부 커서 기준이라 커서와 문구가 어긋난 학생은 배지도 어긋난다. `<<` `>>` 를 누르면 정렬된다.
- 목차 조회는 100행씩 끊어 오므로 **끝까지 페이지네이션**한다(2026-08-20 수정, 그전엔 100번째에서 잘렸다).

## 관련 코드

`api/index.js`: `fetchBookUnits :3524` · `bookLength :3557` · `syncBookTotalUnits :3568` · `remainingInfo :3585` · `avgPerTime :3599` · 라우트 `:3644`
`public/views/teacher.html`: `paintAllLeftBadges :1091` · `moveHomeworkTrack :1430` · `leftBadgeInfo :1463` · `avgAssignmentSize :1488`

관련: [[homework-automation]] · [[notion-latency]] · [[textbook-name-whitespace]] · [[render-manual-deploy]]
