---
id: notion-databases
title: Notion 데이터베이스 맵
type: entity
status: verified
source: api/index.js:23-42, 1082-1114, .env
updated: 2026-08-20
tags: [notion, database, schema]
---

## 정체

이 프로젝트는 **Notion을 DB로 쓴다.** 별도 RDB가 없다. 모든 데이터는 아래 DB들의 페이지다. 사람이 노션 UI에서 직접 고칠 수 있는 게 장점이고, 느린 게 대가다 ([[notion-latency]]).

## 표

| 환경변수 | 용도 | 쓰는 곳 |
|---|---|---|
| `STUDENT_DATABASE_ID` | 학생 원장. 이름·재원상태·담당쌤·전화번호·학생 ID | 거의 전부 |
| `PROGRESS_DATABASE_ID` | 일자별 진도·숙제·코멘트. **가장 뜨거운 DB** | 데일리 리포트, 숙제 자동화, 월간 리포트 |
| `GRAMMAR_DB_ID` | 반별 문법 진도 원장 | [[grammar-comment]] |
| `KOR_BOOKS_ID` / `ENG_BOOKS_ID` | 국어·영어 교재 목록 | `bookModule.js` |
| `TEXTBOOK_DB_ID` | 교재 마스터 | [[homework-automation]] |
| `TEXTBOOK_UNIT_DB_ID` | 교재 단원(목차) | 목차 파싱, 숙제 생성 |
| `TEXTBOOK_FEE_DB_ID` | 교재비 신청·승인·발송 | [[textbook-fee]] |
| `MONTHLY_REPORT_DB_ID` | 월간 리포트 | [[monthly-report]] |
| `TEACHER_DB_ID` | 선생님. 카카오워크 ID 매핑 | `teacherDm.js`, 교재비 |
| `ABSENCE_DB_ID` | 결석·지각·조퇴·보강 | [[absence-notice]] |
| `COUNSEL_DB_ID` | **재원생** 상담 (자체 폼) | [[counsel]] |
| `ADMISSION_DB_ID` | **신입생** 상담 예약 | [[counsel]] |
| `NOTICE_DB_ID` | 공지·학사일정·FAQ. 공개 페이지가 읽음 | `/notice` |
| `PAUSE_DB_ID` | 숙제 정지 기간. **전역 킬스위치** | [[homework-automation]] |
| `EXAM_DB_ID` | 시험지 분석 결과 | [[exam-analyzer]] |
| `QUESTION_DB_ID` | 문항 | [[exam-analyzer]] |
| `STUDENT_RESULT_DB_ID` | 학생 채점 결과 | [[exam-analyzer]] |
| `STUDENT_ANSWER_DB_ID` | 학생 답안 | [[exam-analyzer]] |

## 쓰는 곳

`api/index.js:23-39`에서 한꺼번에 구조분해로 읽고, 모듈에는 `dbIds: { ... }` 객체로 넘긴다 ([[module-di]]).

## 주의

- 🔴 **코드에 UUID가 폴백으로 박힌 곳이 있다.** `PAUSE_DB_ID`(`api/index.js:42`), `COUNSEL_DB_ID`(`:325`), `TEACHER_DB_ID`(`:338`), `ADMISSION_DB_ID`(`:1112`). env 없이도 돌게 한 의도적 선택이지만, DB를 갈아끼우면 env만 바꿔서는 안 되고 코드도 봐야 한다.
- ⚠️ **이름이 비슷한 옛 DB가 있다.** `상담신청서 관리`(`18609320…`)는 2025-07-21에 멈춘 폐기 폼이다. 현행은 `ADMISSION_DB_ID`(`1a109320…`) — `api/index.js:1111` 주석 참고.
- **속성 이름이 사람 손으로 바뀐다.** 하드코딩 키 대신 `getPropByKeywords`를 써라 → [[notion-prop-read]]
- 페이지네이션(100건 상한)을 `fetchNotion`이 처리하지 않는다 → [[notion-fetch]]
- 🔴 **노션 `title` 을 키로 쓰지 마라.** 교재 제목 끝에 눈에 안 보이는 NBSP가 섞여 배정이 막힌 적이 있다 → [[textbook-name-whitespace]]
- 교재 DB의 `총유닛수` 는 사람이 쓰는 값이 아니라 **목차(교재 유닛 DB)에서 나온 사본**이다. 서버가 목차를 읽을 때 맞춰 쓴다 → [[homework-track-move]]

관련: [[notion-fetch]] · [[notion-prop-read]] · [[env-vars]] · [[notion-latency]]
