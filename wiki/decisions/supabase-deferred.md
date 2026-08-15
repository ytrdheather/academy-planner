---
id: supabase-deferred
title: Supabase로 옮기지 않는다
type: decision
status: verified
source: memory/notion-performance-optimization.md (2026-07-28)
updated: 2026-08-15
tags: [notion, database, performance, architecture]
---

## 결정

**Notion을 계속 DB로 쓴다. Supabase(또는 다른 RDB)로 옮기지 않는다.** 2026-07-28 결정.

## 배경

속도만 보면 압도적이다 — 같은 조회 5~20ms, 조인 한 방, 31명 쓰기도 문장 하나. 지금 노션은 학생 명부 전체 조회에 4.3초가 걸린다 → [[notion-latency]]

**그런데 안 옮기는 이유는 속도가 아니라 노션이 곧 UI라는 점이다.**

- 선생님들이 노션에서 직접 편집한다 (학생 명부, 교재 세부 내용, 학습진도)
- 옮기면 그 편집 화면을 **전부 새로 만들어야** 한다
- 결합도: `fetchNotion(` 호출 **69군데**, `api.notion.com` 참조 파일 7개

## 기각한 대안

| 대안 | 왜 안 했나 |
|---|---|
| Supabase 전면 이전 | 위 세 가지 |
| 하이브리드(읽기만 캐시 DB) | 동기화 코드가 새 실패 지점이 된다. 노션 편집이 즉시 안 보이면 선생님이 "안 됐다"고 판단한다 |

## 핵심 논거

**고칠 수 있는 코드 낭비가 남은 노션 오버헤드보다 크다.** 코드 최적화로 15초→1~2초를 얻으면, 거기서 Supabase로 더 줄여봐야 1초→0.05초라 **체감 차이가 없다.** 실제로 1단계 최적화만으로 목표를 달성했다 → [[notion-latency]]

## 재검토 조건

- 학생 수가 **몇 백 명**이 되거나
- 선생님이 **노션 화면을 더 이상 안 쓰게** 되거나
- 대량 쓰기(노션 초당 3요청 제한)가 사람을 기다리게 하는 자리가 새로 생기면

관련: [[notion-latency]] · [[notion-fetch]] · [[notion-databases]] · [[dashboard-cache]]
