---
id: alimtalk-send
title: 알림톡·문자 발송 (Solapi)
type: pattern
status: verified
source: api/index.js:361-426
updated: 2026-08-15
tags: [solapi, alimtalk, sms, notify]
---

## 문제

학부모에게 나가는 메시지다. 잘못 나가면 되돌릴 수 없고, 알림톡은 **카카오 심사를 통과한 템플릿으로만** 나간다. 변수 하나 비면 자리표시자가 그대로 학부모 폰에 찍힌다.

## 해법

`sendAlimtalk(to, templateId, variables)` — `api/index.js:368`
`sendSms(to, text, subject)` — `api/index.js:397`

둘 다 Solapi `messages/v4/send`. 인증은 HMAC-SHA256(`date + salt`).

- 🔴 **`disableSms: true`** — 알림톡 실패 시 문자로 대체 발송하지 **않는다**. 2026-08-10 원장 확정. 같은 얘기를 두 번 받는 게 더 나쁘고, 문자는 비싸다.
- `to`는 숫자만 남기고 정규화한다.
- 키·발신번호·템플릿 중 하나라도 없으면 **조용히 `false`** 반환하고 서버는 계속 뜬다.
- `sendSms`는 EUC-KR 기준 바이트를 세서 **90바이트 초과면 자동 LMS**(제목 필요, 기본 '리디튜드').

```js
await sendAlimtalk(phone, ALIMTALK_TPL_COUNSEL_RECEIPT, { '#{이름}': name, '#{일시}': when });
```

## 쓰는 법

새 알림톡을 추가하는 순서:

1. 카카오에 템플릿 등록 → 심사 통과
2. 템플릿 ID를 **Render 환경변수**에 추가 (코드에 박지 마라). 없으면 발송만 건너뛰도록 폴백 `''`을 둔다 — `api/index.js:331` 참고
3. **변수명을 템플릿에 등록된 것과 글자 단위로 맞춘다.** 어긋나면 거부되거나 빈 값으로 나간다
4. 실제 번호로 1건 보내고 **보낸 본문을 Solapi에서 되읽어 확인한다** → [[solapi-facts]]
5. 실패는 반드시 잡아서 카카오워크로 통지 — 학부모에게 조용히 안 간 게 최악 ([[kakaowork-notify]])

## 안 되는 경우

- 🔴 **변수를 빈 문자열로 보내지 마라.** 거부되거나 `#{이름}`이 그대로 나간다.
- 🔴 발신번호(`SOLAPI_SENDER`)는 등록된 번호여야 한다. 오타로 사고 난 적 있음 → [[solapi-sender-typo]]
- `sendAlimtalk`은 실패 시 `throw`한다. 크론 루프 안에서는 개별 `try/catch`로 감싸라 — 한 명 실패로 나머지가 안 나가면 안 된다.
- 광고성 문구를 승인 템플릿 밖으로 끼워 넣을 수 없다. 변수 자리만 바뀐다.

관련: [[solapi-facts]] · [[solapi-sender-typo]] · [[kakaowork-notify]] · [[external-services]]
