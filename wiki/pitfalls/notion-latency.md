---
id: notion-latency
title: 노션이 느린 게 아니라 코드가 다 읽고 있었다
type: pitfall
status: verified
source: memory/notion-performance-optimization.md (2026-07-28 ~ 07-29)
updated: 2026-08-15
tags: [notion, performance, cache, filter]
---

## 증상

사용자 말: **"기능 하나 추가될 때마다 시간이 너무 오래 걸려서 기능 만드는 게 바보같이 느껴진다."** 개인 학생 한 명 숙제 생성에 **15초**가 걸렸다.

## 실측 지연치 (2026-07-28, 라이브 노션)

| 요청 | 시간 | 크기 |
|---|---|---|
| 학생 명부 **전체** (95명) | **4,302ms** | 732KB |
| 학생 **1명만** 이름 필터 | **403ms** | 7KB |
| 학습진도 하루치 (53건) | **4,503ms** | 739KB |
| 교재 DB (100건) | 809ms | 162KB |
| 단일 페이지 | 348ms | 13KB |
| 교재 1권 유닛 목록 | 1,934ms | — |

같은 요청 3회: 393 / **1,634** / 454ms — **노션 자체가 들쭉날쭉하다.**

## 원인

**절반은 노션, 절반은 코드였다.**

개인 1명 숙제 생성인데 `computeHomeworkProposals()`가 **학생 95명 전체(4.3초) + 그날 53명 전체(4.5초)**를 읽고 JS에서 골라내고 있었다. 이름으로 **서버측 필터**하면 403ms — **10배 낭비.**

## 고친 방법 (1단계, 커밋 `c065636`)

`readStudentConfigs(onlyName)`과 `computeHomeworkProposals`의 일일 쿼리에 `onlyName`이 있으면 **노션 쿼리 자체에 필터**를 걸도록 수정:

```js
{ property: '이름', title: { equals: onlyName } }
```

크론이 쓰는 전체 생성 경로(`onlyName` 없음)는 그대로. **필터는 개인 지목(🔮) 조회일 때만 붙는다.**

**결과: 첫 콜 5.1초(캐시 비어 있음), 이후 0.9~2.3초.** 목표(15초→1~2초)를 1단계만으로 달성해 **여기서 멈추기로 했다.**

## 🔴 규칙

1. **노션에 필터를 넘겨라. JS로 거르지 마라.** 전체를 읽어 골라내는 코드가 이 저장소의 기본 성능 문제다.
2. **노션은 초당 3요청이 하드 리밋이다.** 31명 × 2 PATCH × 350ms ≈ 22초. **이건 코드로 못 줄인다** — 사람을 기다리게 하지 말고 크론으로 밀어라 ([[homework-automation]]의 11시 크론이 그 답이었다).
3. 캐시 패턴은 이미 있다 — `loadTextbooks()`의 `textbookCache`, `dashboardCache` → [[dashboard-cache]]

## 보류된 2~4단계

필요해지면(체감상 다시 느려지면) 재개:
- `readStudentConfigs()` 프로세스 레벨 캐시 (명부는 자주 안 바뀐다. 진도 수정 시 무효화 필요)
- 교재 유닛 목록을 요청 단위 `unitCache`에서 프로세스 레벨로 승격
- 독립 요청 `Promise.all` 병렬화 (지금 순차 `await`)

## 재현

`.env`의 `NOTION_ACCESS_TOKEN` + DB ID로 스크립트를 짜서 프로젝트 루트에서 실행(dotenv가 거기 있다). 읽기 전용이라 안전.

관련: [[supabase-deferred]] · [[dashboard-cache]] · [[notion-fetch]] · [[homework-automation]]
