---
id: external-services
title: 외부 서비스
type: entity
status: verified
source: api/index.js:99-109, 342-426, package.json
updated: 2026-08-15
tags: [notion, gemini, solapi, kakaowork, render]
---

## 정체

이 서버가 의존하는 바깥 6곳. 전부 하나라도 죽으면 그 기능만 꺼지고 서버는 뜨도록 설계돼 있다.

## 표

| 서비스 | 무엇 | 실패하면 |
|---|---|---|
| **Notion** | 데이터베이스 전부. `2022-06-28` 버전 고정 | 거의 모든 기능 정지 |
| **Google Gemini** | AI 코멘트, 시험지 분석 | 코멘트 생성만 정지 |
| **Solapi** | 학부모 알림톡·문자 | 학부모 발송 정지 |
| **KakaoWork** | 내부 알림(선생·원장·조교) | 조용히 건너뜀 |
| **카카오톡 채널 + 챗봇** | 학부모 진입점(안내판) | 폼 링크 접근 불가 |
| **Render** | 호스팅. `https://readitude.onrender.com` | 전부 정지 |

### Gemini 설정 (`api/index.js:101-107`)

```js
model: 'gemini-2.5-flash',
generationConfig: { temperature: 0.7, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } }
```

`thinkingBudget: 0` — **추론 토큰을 끈 것은 비용 상한 목적**이다. `maxOutputTokens: 1500`은 답변 잘림 방지 겸 상한.

### Solapi

HMAC-SHA256(`date + salt`) 인증. `messages/v4/send`. **보낸 본문을 `/messages`로 되읽을 수 있다** — 사고 진단할 때 실제로 뭐가 나갔는지 확인 가능 → [[solapi-facts]]

### KakaoWork

봇 API. **봇은 채널을 만들 수 없고, 사람이 UI에서 만든 채널에 들어갈 수도 없다** → [[kakaowork-platform-limits]]

## 주의

- 🔴 **Render 자동 배포가 꺼져 있다.** push해도 라이브에 반영되지 않는다 → [[render-manual-deploy]]
- `vercel.json`과 `.replit`이 저장소에 남아 있지만 **현행 배포는 Render**다. 옛 흔적.
- Notion 응답 지연이 체감 성능을 지배한다 → [[notion-latency]]

관련: [[notion-fetch]] · [[alimtalk-send]] · [[kakaowork-notify]] · [[render-manual-deploy]] · [[env-vars]]
