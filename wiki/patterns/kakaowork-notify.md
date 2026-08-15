---
id: kakaowork-notify
title: 내부 알림 (KakaoWork)
type: pattern
status: verified
source: api/index.js:342-359, api/teacherDm.js
updated: 2026-08-15
tags: [kakaowork, notify, internal]
---

## 문제

자동화가 조용히 실패하는 게 가장 위험하다. 상담 신청이 노션에 안 들어갔는데 아무도 모르는 상황. 그래서 **모든 자동 흐름은 결과를 사람이 보는 자리에 남긴다.** 그 자리가 카카오워크다.

## 해법

`sendKakaoWork(conversationId, text)` — `api/index.js:343`. `api.kakaowork.com/v1/messages.send`, `Bearer <APP_KEY>`.

앱 키나 conversation ID가 없으면 경고만 찍고 `false`. 실패하면 `throw`.

**채널 분리 원칙 — 알림은 그 일이 이미 오는 자리로 보낸다.** 신청 알림과 처리 결과가 흩어지면 대조가 안 된다.

| 환경변수 | 무엇이 오나 |
|---|---|
| `KAKAOWORK_COUNSEL_CONV` | 재원생 상담 신청·확정 |
| `KAKAOWORK_ABSENCE_CONV` | 결석·보강 신청, 보강 당일 명단 |
| `KAKAOWORK_ADMISSION_CONV` | 신입생 상담 예약·발송 결과 |
| `KAKAOWORK_APPROVAL_CONV` | 원장 1:1 DM. **담임에게 못 닿은 알림이 여기로 모인다** |
| `KAKAOWORK_ASSISTANT_CONV` | 조교 장보기 목록 |

**개인 DM** — `makeTeacherDm({ fetchNotion, teacherDbId, appKey })` (`api/index.js:336`, `api/teacherDm.js`). 공용 채널에 뿌리면 각자 훑어야 하고 결국 아무도 안 본다. 담당쌤 건은 개인 DM으로.

## 쓰는 법

- 모듈에는 채널이 이미 박힌 얇은 함수로 넘긴다 — `notifyChannel: (title, body) => sendKakaoWork(CONV, ...)` (`api/index.js:1131`). [[module-di]]
- 통지 호출은 **`.catch()`로 감싼다.** 알림 실패가 본 작업을 죽이면 안 된다.
- 담임에게 못 보냈으면 원장 DM으로 폴백한다.

## 안 되는 경우

- 🔴 **봇은 채널을 못 만든다. 사람이 UI에서 만든 채널에는 봇이 못 들어간다.** 봇이 만든 `channel_type: public` 채널만 쓸 수 있다 → [[kakaowork-platform-limits]]
- conversation ID가 코드에 폴백 상수로 박혀 있는 곳이 있다 (`api/index.js:328`, `1114`). env가 우선이지만, 값이 안 맞으면 엉뚱한 방으로 간다.
- 마크다운 꺼짐(`markdown: false`)으로 보낸다. 서식 안 먹는다.

관련: [[kakaowork-platform-limits]] · [[alimtalk-send]] · [[module-di]] · [[external-services]]
