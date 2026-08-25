---
id: kst-time
title: 한국 시간(KST) 다루기
type: pattern
status: verified
source: api/index.js:131-146
updated: 2026-08-15
tags: [time, kst, cron]
---

## 문제

서버는 Render(해외)에서 돌고 사용자는 전부 한국에 있다. "오늘"이 서버 기준이면 하루가 어긋난다. 특히 밤 시간대 진도 기록과 크론 배치에서 티가 난다.

## 해법

`getKSTTodayRange()` — `api/index.js:131`

UTC에 `+9h`를 더해 날짜 문자열을 뽑고, 그 날짜의 **`+09:00` 오프셋 경계**로 start/end를 만든다:

```js
const { start, end, dateString } = getKSTTodayRange();
// start: 2026-08-15T00:00:00.000+09:00 의 ISO
// dateString: '2026-08-15'   ← Notion date 필터에 그대로 씀
```

`getKoreanDate(dateString)` (`api/index.js:141`) — `Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul' })`로 "2026년 8월 15일 (금)" 만들기. 사람에게 보여줄 때만.

## 쓰는 법

- Notion 날짜 필터에는 `dateString`을 쓴다 (`{ date: { equals: dateString } }`).
- 시각 범위 조회에는 `start`/`end`를 쓴다.
- 화면·알림톡 문구에는 `getKoreanDate`.
- 모듈에는 주입해서 쓴다 (`api/index.js:1099`).

## 안 되는 경우

- **크론 시각은 이 헬퍼와 무관하다.** 13개 크론 전부 `{ timezone: 'Asia/Seoul' }`을 직접 준다. 새 크론을 만들 때 이걸 빠뜨리면 서버 로컬 시간으로 돌게 된다 → [[cron-jobs]]
- 🔴 **크론 콜백 안에서 맨 `new Date()`를 쓰면 서버 시간이다.** `timezone` 옵션은 *발화 시각*만 정하지 콜백 안의 `Date`를 바꾸지 않는다. `monthlyReportModule.js:592`가 `today.getDate()`로 몇 째 주인지 계산하는데, 월말·월초 경계에서 어긋날 수 있는 자리다.
- `getKSTTodayRange`는 **오늘**만 준다. 어제/이번 주가 필요하면 직접 계산해야 한다.
- `getKoreanDate`를 키나 비교값으로 쓰지 마라. 표시 전용이다.

관련: [[cron-jobs]] · [[homework-automation]] · [[daily-report]]
