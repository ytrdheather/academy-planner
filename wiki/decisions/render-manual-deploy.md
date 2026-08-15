---
id: render-manual-deploy
title: Render 자동 배포를 꺼 둔다
type: decision
status: verified
source: memory/render-manual-deploy.md (2026-08-07)
updated: 2026-08-15
tags: [render, deploy, cron]
---

## 결정

**Render 자동 배포는 꺼져 있다. push해도 라이브에 반영되지 않는다.** 사용자가 Render 대시보드에서 `Manual Deploy`를 눌러야 배포된다.

🔴 **push 후 "배포됐다"거나 "Render가 자동 배포할 것"이라고 말하지 마라.** "푸시했으니 Manual Deploy 눌러 달라"고 안내한다.

서비스: `readitude` (Starter $7), `https://readitude.onrender.com`

## 배경

**node-cron이 서버 프로세스 안에서 돈다.** 배포가 크론 시각과 겹치면 그날 크론이 통째로 건너뛰어진다 — 구 프로세스 종료 → 새 프로세스가 크론 시각 이후에 기동 → 다음 주기까지 안 돈다. **조용히 실패해서 더 위험하다.** 수동이면 배포 시각을 사람이 고를 수 있다. 선생님들이 수업 중 쓰는 앱이라 재시작 다운타임도 피하고 싶다.

Starter 플랜이라 서버가 잠들지 않아 크론이 정상 동작한다. **무료 플랜이면 15분 유휴 후 슬립되어 크론이 아예 안 돈다.**

## 배포를 피할 시간대

| 언제 | 무엇 |
|---|---|
| 매일 10:15~10:25 | 리포트 생성 |
| 매일 10:55~11:05 | 숙제 자동 생성 |
| 매일 21:55~22:05 | 리포트 URL |
| 토 09:55~10:05 | 월간 리포트 |
| **금 20:55~21:05** | **교재비 묶음 발송** |
| **월 09:55~10:05** | 조교 장보기 목록 |

겹쳐서 놓친 크론은 대부분 화면의 수동 버튼이나 `POST /api/textbook/tick`·`/send-batch`·`/shopping-push`로 복구할 수 있다(멱등) → [[cron-jobs]]

## 라이브에 뭐가 올라가 있는지 확인 (코드 안 보고)

`/manual` 탭 개수 · `/absence`가 열리는지 · `GET /api/textbook/act?id=x&a=approve&t=wrong`이 **403인지**(404면 모듈이 죽은 것) → [[module-di]]

## 재검토 조건

크론을 서버 프로세스 밖(외부 스케줄러·큐)으로 빼면 이 제약이 사라진다. 그때 자동 배포를 다시 켤 수 있다.

## ⚠️ 낡은 기록 주의

`memory/readiplan-brand.md`(2026-07-21)에 "GitHub main 푸시 시 Render auto-deploy 트리거"라고 적혀 있는데 **틀렸다.** 이 페이지(2026-08-07)가 최신이다.

관련: [[cron-jobs]] · [[external-services]] · [[textbook-fee]] · [[homework-automation]]
