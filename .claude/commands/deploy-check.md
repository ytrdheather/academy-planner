---
description: 배포 전 점검과 안내. Render 자동 배포가 꺼져 있고 배포가 크론을 죽일 수 있어서 시각을 고른다
---

🔴 **push해도 라이브에 반영되지 않는다.** 사용자가 Render 대시보드에서 `Manual Deploy`를 눌러야 한다. 근거: `wiki/decisions/render-manual-deploy.md`

**"배포됐다"거나 "Render가 자동으로 할 것"이라고 말하지 마라.**

## 1. 지금 배포해도 되는 시각인가

크론이 서버 프로세스 안에서 돈다. 배포가 크론 시각과 겹치면 **그날 그 크론이 통째로 건너뛰어지고 조용히 실패한다.**

| 피할 시각 (KST) | 무엇 |
|---|---|
| 매일 10:15~10:25 | 리포트 생성 |
| 매일 10:55~11:05 | 숙제 자동 생성 |
| 매일 21:55~22:05 | 리포트 URL |
| 토 09:55~10:05 | 월간 리포트 |
| **금 20:55~21:05** | **교재비 묶음 발송** |
| 월 09:55~10:05 | 조교 장보기 목록 |

전체 표는 `wiki/entities/cron-jobs.md`. **지금 시각을 확인하고, 겹치면 사용자에게 알린다.**

수업 시간 중 재시작도 피하는 게 좋다 — 선생님들이 쓰고 있다.

## 2. 배포 전 확인

- `git status`로 의도한 것만 커밋됐는지
- `git fetch` 후 리모트가 앞서 있지 않은지 (여러 PC에서 같은 main을 쓴다 → rebase 먼저)
- 새 **환경변수**가 필요하면 사용자에게 명확히 알린다. Render에 안 넣으면 조용히 기능만 꺼지거나 500이 난다 → `wiki/entities/env-vars.md`
- 새 모듈을 넣었으면 배포 후 Render 로그에서 **`Init Error`**를 확인해야 한다고 알린다

## 3. 사용자에게 할 말

```
푸시했습니다. Render 대시보드에서 Manual Deploy 눌러 주세요.
(추가로 넣을 환경변수가 있으면 여기 나열)
```

## 4. 배포 후 라이브 확인 (코드 안 보고)

- `/manual` 탭 개수
- `/absence`가 열리는지
- `GET /api/textbook/act?id=x&a=approve&t=wrong`이 **403**인지 — 404면 모듈이 죽은 것

## 5. 놓친 크론 복구

대부분 멱등이라 다시 돌리면 된다:
- 화면 버튼 — 출결·숙제 탭의 `📄 오늘 리포트 생성`, `🔮 오늘 숙제 자동 기록`
- `POST /api/textbook/tick` · `/send-batch` · `/notify-teachers` · `/shopping-push`
- `POST /api/admission/tick` · `/api/makeup/send-confirms` · `/api/counsel/send-confirms`
