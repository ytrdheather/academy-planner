---
id: env-vars
title: 환경변수
type: entity
status: verified
source: api/index.js, .env.example
updated: 2026-08-15
tags: [config, env, render]
---

## 정체

Render 대시보드의 환경변수가 진실이다. 로컬은 `.env`(git 제외), 배포는 Render.

## 표

**인증·기반**

| 변수 | 없으면 |
|---|---|
| `JWT_SECRET` | 🔴 개발용 기본값으로 폴백 (`api/index.js:24`) |
| `NOTION_ACCESS_TOKEN` | Notion 전부 실패 |
| `PORT` | 5001 |

**Notion DB** — 18개. → [[notion-databases]]

**AI**

| 변수 | 없으면 |
|---|---|
| `GEMINI_API_KEY` | AI 코멘트·시험지 분석 비활성. 서버는 정상 기동 |

**Solapi (학부모 발송)** → [[alimtalk-send]]

| 변수 | 비고 |
|---|---|
| `SOLAPI_API_KEY` / `SOLAPI_API_SECRET` | |
| `SOLAPI_SENDER` | 🔴 등록된 발신번호. 오타 사고 이력 → [[solapi-sender-typo]] |
| `ALIMTALK_PF_ID` | 폴백 상수 있음 (`api/index.js:372`) |
| `ALIMTALK_TPL_COUNSEL_RECEIPT` | 없으면 발송만 건너뜀 |

**KakaoWork (내부 알림)** → [[kakaowork-notify]]

| 변수 | 방 |
|---|---|
| `KAKAOWORK_APP_KEY` | 봇 키. 없으면 내부 알림 전부 건너뜀 |
| `KAKAOWORK_COUNSEL_CONV` | 재원생 상담 |
| `KAKAOWORK_ABSENCE_CONV` | 결석·보강 |
| `KAKAOWORK_ADMISSION_CONV` | 신입생 상담 |
| `KAKAOWORK_APPROVAL_CONV` | 원장 1:1 DM (폴백 목적지) |
| `KAKAOWORK_ASSISTANT_CONV` | 조교 장보기 |

**폼 링크 / 기타**

| 변수 | 용도 |
|---|---|
| `FORM_ABSENCE_URL` / `FORM_COUNSEL_URL` / `FORM_ADMISSION_URL` | `/notice` 허브가 노출하는 폼 주소 |
| `SHOW_GENERATED_HOMEWORK` | 자동 생성 숙제 노출 토글 (`api/index.js:2556`) |

## 주의

- 🔴 **`.env.example`이 심하게 낡았다.** Vercel·Replit 시절 내용이고 실제 쓰는 변수의 대부분이 빠져 있다. **새 환경을 세팅할 때 이 파일을 믿지 마라** — 이 페이지나 Render 대시보드를 보라.
- 대부분의 변수는 없어도 서버가 뜬다. **조용히 기능만 꺼진다.** 배포 후 Render 로그에서 `⚠️ ... 설정 없음`과 `Init Error`를 확인하라.
- 🔴 **`DOMAIN_URL`은 환경변수가 아니라 코드 상수다** (`api/index.js:45`, `https://readitude.onrender.com`). 도메인을 바꾸면 코드를 고쳐야 한다.

관련: [[notion-databases]] · [[external-services]] · [[render-manual-deploy]]
