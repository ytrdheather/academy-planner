---
id: solapi-facts
title: Solapi 실측 사실 + 승인 템플릿
type: entity
status: verified
source: memory/solapi-facts.md (2026-08-10 API 직접 확인)
updated: 2026-09-04
tags: [solapi, alimtalk, template, reference]
---

## 정체

**솔라피에 대해 추측하지 마라.** 아래는 2026-08-10에 API로 직접 확인한 값이다.

## 🔴 보낸 알림톡의 최종 본문은 되읽을 수 있다

`GET /messages/v4/list`의 **`text` 필드에 변수가 치환된 완성 문구가 그대로** 들어 있다. "솔라피로 보내면 내용 확인이 안 된다"는 **사실이 아니다** — 콘솔이 불편할 뿐이다.

| 사실 | 값 |
|---|---|
| `limit` 최대 | **500** (1000은 ValidationError) |
| 수신번호 필터 | `to=01012345678` — **된다** |
| `messageType=ATA` 필터 | **안 먹는다** |
| 실제 도착 판정 | `statusCode === '4000'`만. 나머지는 접수만 되고 안 간 것 |
| 실패 사유 | `log` 배열 **마지막 원소**의 `message` |

이걸로 만든 페이지가 **`/messages`** (리디플랜 로그인 필요) — 학생 이름·번호로 검색한다.

## 등록된 템플릿

| 이름 | ID | 용도 |
|---|---|---|
| 교재비 입금 안내_12.27.25 | `KA01TP2512261533265840etUCdm2j2f` | [[textbook-fee]] |
| 교재비 **미입금** 안내 | ⏳ 심사 신청 필요 → `ALIMTALK_TPL_TEXTBOOK_UNPAID` | 발송 후 두 번째 월요일에 미입금 1회. 변수 3개는 입금 안내와 **같은 이름**(`#{학생이름}` `#{교재정보}` `#{교재비}`) |
| 상담예약 안내확인 | `KA01TP250223163830368xwWO2Ze1CcQ` | 신입생 상담 → [[counsel]] |
| NEW daily report 26.03.06 | `KA01TP260306103448601CbxWHWGzEZN` | [[daily-report]] |
| 결석/보강 신청 접수 안내 | `KA01TP260802174214130nJ0CJZnJI9g` | **승인됐지만 안 쓴다** (접수 확인 전면 폐지) |
| 보강 스케줄 안내 | `KA01TP250516103046750Wa1hadZUS4s` | 월 단위 2건 묶음 양식이라 개별 확정에는 안 맞는다 |

pfId는 전 템플릿 공용 `KA01PF250113084507284jSE3GEmbOOw`.

## 주의

- 🔴 **"리디튜더"는 오타가 아니다.** 승인된 템플릿 여러 개가 쓰는 학생 호칭이니 고치지 마라.
- 알림톡(ATA)은 **pfId로 나가서 발신번호와 무관하다.** 문자만 발신번호를 탄다 → [[solapi-sender-typo]]
- 템플릿 본문은 카카오 심사를 통과한 것이라 **변수 자리 말고는 못 바꾼다.** 교재비 템플릿엔 **계좌번호가 본문에 하드코딩**돼 있다.
- 줄바꿈이 든 변수는 **이미 승인된 템플릿에서는 문제없다**(실발송 확인).

관련: [[alimtalk-send]] · [[solapi-sender-typo]] · [[external-services]] · [[env-vars]]
