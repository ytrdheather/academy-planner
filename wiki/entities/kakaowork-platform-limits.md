---
id: kakaowork-platform-limits
title: KakaoWork 봇 API 한계 (실측)
type: entity
status: verified
source: 2026-09-04 재실측 (2026-08-06 초판의 채널 생성 항목을 정정)
updated: 2026-09-04
tags: [kakaowork, api, reference, limits]
---

## 정체

2026-08-06 초판, **2026-09-04 채널 생성 항목 정정.** 빈 본문 POST 로 경로 존재 여부를 훑어 확인한다(있으면 검증 오류, 없으면 `api_not_found`). 다만 **경로가 없다고 그 기능이 없는 건 아니다** — 아래 정정을 볼 것.

## 🔴 봇은 채널을 만들 수 있다 — 이름을 못 붙일 뿐이다

**2026-09-04 정정.** 이 페이지는 원래 "봇은 채널을 못 만든다"고 적혀 있었는데 **틀렸다.**
원장이 `결석보강 신청알림_BOT` 채널의 멤버 목록을 보여 줬고 **Readitude_Bot 이 방장**이었다.
그 자리에서 다시 실측했다.

```
POST /conversations.open  { name, channel_type, user_ids:[12029791] }
→ { type:'group', channel_type:'public', users_count:2, is_new:true }
```

| | 되나 | 비고 |
|---|---|---|
| 채널(`group`/`public`) 만들기 | ✅ | `user_ids` 가 **1명이어도** group 이 된다. 그 사람과의 기존 1:1 DM 과는 **다른 방**이 새로 생긴다 |
| 방 이름 정하기 | ❌ | `name` 을 보내도 **무시**된다. 참가자 이름이 방 제목이 되고(`김연수, 이명수`), 목록 API 에는 `name: null` 로 온다 |
| 봇이 이름 바꾸기 | ❌ | API 가 없다. 이름 후보 25개 × POST, `PUT`/`PATCH`/`GET`/`DELETE` 전부 `api_not_found`(2026-09-04). 기존 방에 `open` 을 다시 불러도 `name` 은 무시 |
| **사람이 이름 바꾸기** | ✅ | **방장이 봇이어도 된다.** 2026-09-04 원장이 실제로 바꿨다. 그래서 `_BOT` 채널들이 제대로 된 이름을 갖고 있는 것이다 |
| 봇이 방 삭제·나가기 | ❌ | API 가 없다. **잘못 만든 방은 봇이 들어간 채로 남는다** |

🔴 **절차는 "봇이 만들고 사람이 이름을 바꾼다"이다.** 기존 `_BOT` 채널들이 전부 그렇게 생겼고, 2026-09-04 에 교재비 채널 2개를 같은 방식으로 만들어 확인했다.
봇이 만든 직후 그 방으로 "이 방의 용도와 바꿀 이름"을 한 통 보내 두면 사람이 앱에서 찾아 바꾸기 쉽다 — 방금 만든 방은 목록에 `name: null` 로만 보여서 ID 말고는 알아볼 단서가 없다.

🔴 **만들기 전에 이름을 누가 언제 붙일지 먼저 합의할 것.** 삭제·나가기가 없어서 잘못 만든 방은 영구히 남는다.

> 예전 판(2026-08-06)은 `conversations.create` 가 `api_not_found` 인 것만 보고 "채널을 못 만든다"로
> 결론지었다. 실제 병목은 **생성이 아니라 이름**이었다. 그때 남은 `재원생 상담 알림`·`결석보강 알림`
> 두 방도 "만들기 실패"의 잔해가 아니라 **이름을 못 바꿔 방치된 방**이다.
> 🔴 **없는 엔드포인트 하나로 기능 전체가 불가능하다고 결론짓지 마라.**

## 되는 것

- `POST /conversations.open` `{user_id}` → 1:1 DM 열기 (**멱등**, 기존 방 id를 돌려준다)
- `POST /conversations.open` `{user_ids:[…]}` → **채널(group/public) 새로 만들기.** 멱등이 아니다 — 부를 때마다 새 방이 생긴다
- `POST /messages.send` `{conversation_id, text, blocks}`
- `GET /users.list?limit=100&cursor=` — `identifications[0].value`에 이메일
- 봇은 **자기가 들어가 있는 채널**에는 자유롭게 글을 쓸 수 있다

## 없는 것 (전부 `api_not_found`, POST 기준 — 2026-09-04 재확인)

`conversations.create` · `conversations.list`(POST) · `conversations.users` · `conversations.invite` · `conversations.join` · `conversations.leave` · `conversations.modify/update/rename` · `channels.create/open/list/new` · `channel.create/open` · `bots.info` · `bots/channels.create` · `bot/channels.create` · `spaces.info` · `departments.list`

> GET은 다르다 — `conversations.list`와 `users.list`는 **GET으로는 된다.** 위 목록은 POST 기준이라 GET-only 엔드포인트에 대한 결론이 아니다.

## 메시지 블록

`header` · `text` · `divider` · `button` 확인됨. 🔴 **`description` 블록은 거부된다** (`invalid_parameter`).

🔴 **길이 한계 (2026-09-04 실측). 하나라도 넘기면 메시지 전체가 거부된다.**

| | 한계 |
|---|---|
| `header` 텍스트 | **20자** |
| `button` 텍스트 | **20자** |
| `text` 블록 | 500자 |
| 최상위 `text` 필드 | 3000자 |
| 블록 개수 | 30개까지 확인 (그 이상 미측정) |

거부되면 `invalid_parameter` 에 "블록 킷 빌더를 확인하라"는 말만 오고 **어느 블록이 문제인지 안 알려 준다.**
제목 한 글자가 길어서 알림이 통째로 안 나가는 건 이 저장소에서 제일 나쁜 실패라,
`sendCard` 가 header·button 을 20자로 자르고 본문은 500자마다 블록을 나눈다
(`api/textbookFeeModule.js`, `api/teacherDm.js` 양쪽에 같은 방어가 있다).

버튼: `{ type:'button', text, style, action_type:'open_system_browser', value: URL }`. 채팅방을 벗어나지 않는 네이티브 액션(`submit_action`)은 **카카오워크 콘솔에 콜백 URL 등록이 필요**하다.

관련: [[kakaowork-notify]] · [[textbook-fee]] · [[absence-notice]] · [[external-services]]
