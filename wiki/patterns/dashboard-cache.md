---
id: dashboard-cache
title: 대시보드 TTL 캐시
type: pattern
status: verified
source: api/index.js:57-62, 1510-1524, 1634-1711
updated: 2026-08-15
tags: [cache, performance, notion]
---

## 문제

선생님 대시보드 한 번 여는 데 Notion 조회가 수십 번 나간다. Notion API는 느리고([[notion-latency]]), 여러 선생님이 동시에 새로고침하면 그대로 곱해진다.

## 해법

프로세스 메모리에 두는 아주 단순한 TTL 캐시 — `api/index.js:57`

```js
const dashboardCache = {
  dailyReport: { data: null, lastFetch: 0, date: null },  // TTL 1분
  pastGrammar: { data: null, lastFetch: 0 }               // TTL 5분
};
```

두 가지 무효화 경로:

1. **시간** — `Date.now() - lastFetch < TTL` 이면 캐시 반환
2. **쓰기 후 강제 무효화** — 데이터를 바꾼 라우트가 `lastFetch = 0`으로 리셋한다. 진도 저장, 숙제 확정, 문법 코멘트 갱신 등 **13곳**에서 이렇게 한다 (`api/index.js:1872, 1892, 1977, 2529, 2853, 3538, 3577, 3632, 3775` 등)
3. 클라이언트가 `?force=true`를 붙이면 캐시를 건너뛴다

`dailyReport`는 `date`까지 같아야 히트한다 — 날짜가 바뀌면 자동으로 미스.

## 쓰는 법

**데이터를 쓰는 라우트를 새로 만들면 그 끝에 무효화를 반드시 넣어라.** 안 넣으면 선생님이 저장하고도 최대 1분간 옛 화면을 본다.

```js
if (typeof dashboardCache !== 'undefined') dashboardCache.dailyReport.lastFetch = 0;
```

## 안 되는 경우

- 🔴 **프로세스 메모리다.** Render 인스턴스가 재시작하면 날아가고, 인스턴스가 둘 이상이면 서로 다른 캐시를 본다. 지금은 단일 인스턴스라 문제가 안 될 뿐이다.
- 무효화 지점이 13곳에 흩어져 있다. 새 쓰기 경로를 만들면서 빼먹기 쉬운 구조다.
- 캐시 대상이 딱 2개(`dailyReport`, `pastGrammar`)뿐이다. 다른 느린 조회는 캐시가 없다.

관련: [[notion-latency]] · [[daily-report]] · [[grammar-comment]]
