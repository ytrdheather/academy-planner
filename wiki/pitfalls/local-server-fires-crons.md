---
id: local-server-fires-crons
title: 로컬에서 서버를 통째로 띄우면 학부모에게 진짜 발송된다
type: pitfall
status: verified
source: api/index.js:3817, api/textbookFeeModule.js:707, api/admissionModule.js:162, api/confirmNotifyModule.js:369
updated: 2026-08-23
tags: [local, cron, alimtalk, safety]
---

## 증상

아직 안 밟았다. **밟기 직전에 멈춘 것을 규칙으로 남긴다** (2026-08-23). `node api/index.js` 로 로컬 서버를 띄우면 `.env` 에 **실전 Solapi 키와 실전 Notion 토큰**이 있고 크론 14개가 전부 등록된다. 그중 **5분마다 도는 것이 셋**이라 몇 분만 켜 둬도 발화한다.

`textbookFeeModule.js:707`(교재비 알림·발송·정리) · `admissionModule.js:162`(노션 `상담예약함` 체크 → **학부모 알림톡**) · `confirmNotifyModule.js:369`(노션 `확정발송` 체크 → **학부모 알림톡**)

방아쇠가 노션 체크박스라서 **내 로컬 서버가 원장님이 방금 켜 둔 체크를 먼저 집어 발송해 버릴 수 있다.** 되돌릴 수 없고, 발송완료 플래그까지 켜져 진짜 배치는 조용히 건너뛴다.
## 원인

크론 등록이 `initializeXxx()` 안에 있어 **모듈을 띄우는 것과 크론을 켜는 것이 분리돼 있지 않다** → [[module-di]]. 전역 `DRY_RUN` 스위치도 없다.

## 고친 방법

고치지 않았다. **우회한다** — 검증할 모듈 하나만 올린 임시 하네스를 쓴다.
```js
const app = express();   // 크론 모듈은 하나도 import 하지 않는다
initializeStudentProfile({ app, requireAuth, fetchNotion, loadTextbooks, dbIds });
app.listen(5199);
```

`fetchNotion` · `requireAuth` 는 `api/index.js` 것을 짧게 옮겨 쓰고 토큰은 `JWT_SECRET` 으로 직접 서명한다. **하네스는 프로젝트 루트에 둬야** `node_modules` 가 잡힌다(스크래치패드면 `ERR_MODULE_NOT_FOUND`). 끝나면 지운다.

## 규칙

- 🔴 **로컬에서 `api/index.js` 를 통째로 띄우지 마라.** 읽기만 하는 확인이라도 켜는 순간 크론이 붙는다.
- 라이브 노션에 **쓰기**를 시험했으면 그 자리에서 되돌리고, **되돌려졌는지 다시 읽어 확인해라.**
- 발송 경로를 건드리면 하네스로도 부족하다 → `/add-parent-message` 절차. 배포 시각도 같은 이유로 고른다 → [[render-manual-deploy]]

관련: [[cron-jobs]] · [[render-manual-deploy]] · [[module-di]] · [[alimtalk-send]]
