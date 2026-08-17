---
description: 새 크론(스케줄 작업)을 추가한다. timezone·수동 트리거·배포 시간대 등록까지 빠뜨리지 않도록
argument-hint: [언제 무엇을 할지]
---

**대상**: $ARGUMENTS

먼저 `wiki/entities/cron-jobs.md`를 읽는다. 지금 13개가 돌고 있고 **시각이 이미 촘촘하다** — 겹치면 노션 요청이 몰린다.

## 체크리스트

**① 시각을 고른다**
- 기존 13개와 겹치지 않게. 특히 10:20 / 11:00 / 14:00 / 21:00 / 22:00은 이미 차 있다
- 5분 크론(`*/5 * * * *`)이 이미 3개다. 하나 더 늘리기 전에 **기존 tick에 얹을 수 있는지** 본다

**② 🔴 `{ timezone: 'Asia/Seoul' }`을 반드시 준다**
```js
cron.schedule('0 9 * * *', async () => { ... }, { timezone: 'Asia/Seoul' });
```
지금 13개 전부 갖고 있다. 빠뜨리면 서버 로컬 시간으로 돈다.

**③ 🔴 콜백 안에서 맨 `new Date()`를 쓰지 마라**
`timezone` 옵션은 *발화 시각*만 정하지 콜백 안의 `Date`를 바꾸지 않는다. 날짜 계산은 `getKSTTodayRange()` (`api/index.js:130`) → `wiki/patterns/kst-time.md`

**④ `try/catch`로 감싼다**
실패해도 다음 회차는 돌아야 한다. 실패는 콘솔이 아니라 **카카오워크로** 올린다 → `wiki/patterns/kakaowork-notify.md`

**⑤ 수동 트리거 라우트를 같이 만든다**
```js
app.post('/api/xxx/tick', requireAuth, async (req, res) => { ... });
```
크론이 배포와 겹쳐 건너뛰어지는 일이 실제로 있다. 기존 크론은 전부 이 짝이 있다 (`/api/textbook/tick`, `/send-batch`, `/api/admission/tick` 등).

**⑥ 멱등하게 만든다**
같은 날 두 번 돌아도 안전해야 한다. 이미 처리된 것은 플래그·타임스탬프로 건너뛴다.
🔴 단, **"고치면 되는 실패"에는 완료 플래그를 올리지 마라** → `wiki/pitfalls/teacher-rollup-name.md`

**⑦ 모듈 안이면 `cron`을 주입받는다**
`initializeXxx({ cron, ... })`. 모듈이 직접 import하지 않는다 → `wiki/patterns/module-di.md`

## 마무리

- `wiki/entities/cron-jobs.md` 표에 **한 줄 추가** (시각 / 파일:라인 / 하는 일)
- `wiki/decisions/render-manual-deploy.md`의 **"배포를 피할 시간대"** 표에 추가 — 안 하면 배포가 그 크론을 죽인다
- 해당 `wiki/systems/*.md`에 반영
- `/wiki-ingest`로 마무리

## 배포 후

크론은 **서버 프로세스 안에서 돈다.** 배포하면 다음 발화 시각까지 안 돈다. `/deploy-check`를 참고한다.
