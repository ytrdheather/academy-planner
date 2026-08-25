---
id: kakaowork-platform-limits
title: KakaoWork 봇 API 한계 (실측)
type: entity
status: verified
source: memory/kakaowork-platform-limits.md (2026-08-06 실측)
updated: 2026-08-15
tags: [kakaowork, api, reference, limits]
---

## 정체

2026-08-06 실측. 빈 본문 POST로 경로 존재 여부를 훑어 확인했다(있으면 검증 오류, 없으면 `api_not_found`).

## 🔴 봇은 채널을 만들 수 없다

| | type | channel_type |
|---|---|---|
| 채널 (`결석보강 신청알림_BOT` 등) | group | **public** |
| 봇이 만들 수 있는 것 | group | **none** ← 그냥 채팅방 |

`conversations.open`은 `user_id`/`user_ids`만 받고 **`name`과 `channel_type`을 무시한다.** 이름을 넣어도 참가자 이름이 방 제목이 되고 `channel_type: none`이 된다. **이름 변경·삭제·나가기 API도 없어서 잘못 만들면 사람이 UI에서 치워야 한다.**

> `api/index.js:327`의 "봇이 만든 공개 채널"이라는 주석은 **부정확하다.** 이 주석을 근거로 채널 생성을 시도하다 쓸데없는 채팅방 2개를 만들었다.

**채널이 필요하면 사용자에게 카카오워크에서 만들어 달라고 요청하고 ID만 받는다.** 이름 규칙은 `..._BOT`. 방치된 빈 채널이 있으면 **이름만 바꿔 재활용**하는 게 가장 빠르다.

## 되는 것

- `POST /conversations.open` `{user_id}` → 1:1 DM 열기 (**멱등**, 기존 방 id를 돌려준다)
- `POST /messages.send` `{conversation_id, text, blocks}`
- `GET /users.list?limit=100&cursor=` — `identifications[0].value`에 이메일
- 봇은 **자기가 들어가 있는 채널**에는 자유롭게 글을 쓸 수 있다

## 없는 것 (전부 `api_not_found`, POST 기준)

`conversations.create` · `conversations.list`(POST) · `conversations.users` · `conversations.invite` · `conversations.join` · `conversations.leave` · `conversations.modify/update/rename` · `channels.create/open/list/new` · `channel.create/open` · `bots.info` · `bots/channels.create` · `bot/channels.create` · `spaces.info` · `departments.list`

> GET은 다르다 — `conversations.list`와 `users.list`는 **GET으로는 된다.** 위 목록은 POST 기준이라 GET-only 엔드포인트에 대한 결론이 아니다.

## 메시지 블록

`header` · `text` · `divider` · `button` 확인됨. 🔴 **`description` 블록은 거부된다** (`invalid_parameter`).

버튼: `{ type:'button', text, style, action_type:'open_system_browser', value: URL }`. 채팅방을 벗어나지 않는 네이티브 액션(`submit_action`)은 **카카오워크 콘솔에 콜백 URL 등록이 필요**하다.

관련: [[kakaowork-notify]] · [[textbook-fee]] · [[absence-notice]] · [[external-services]]
