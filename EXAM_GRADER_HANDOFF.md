# 시험 채점기 개선 — 작업 인계 문서 (HANDOFF)

> 이 문서는 작업을 다른 시간/장소(예: 집)에서 이어서 하기 위한 인계 노트다.
> 집에서 이 브랜치로 새 Claude Code 세션을 열고 **"EXAM_GRADER_HANDOFF.md 읽고 이어서 해줘"** 라고 하면 그대로 이어갈 수 있다.

- **브랜치**: `claude/exam-grader-ai-model-tjhtwv`
- **리포지토리**: `ytrdheather/academy-planner`
- **관련 핵심 파일**: `api/examAnalyzerModule.js`, `public/views/student-grader.html`, `public/views/exam-analyzer.html`, `public/views/results-viewer.html`, `public/views/planner-modular.html`, 진입점 `api/index.js`

---

## 배경 / 문제

학원 시험 채점기의 채점 로직:
1. `/api/analyze-exam` — Claude(`claude-sonnet-4-6`)가 시험지 사진을 보고 **문항을 직접 풀어 정답지 생성** → `저장하기`로 Notion(EXAM_DB / QUESTION_DB)에 저장.
2. `/api/grade-student` — Claude가 학생 답안 사진을 읽고, 위 정답지와 문자열 비교로 O/X 채점 → STUDENT_RESULT_DB / STUDENT_ANSWER_DB에 저장.

**두 가지 원인으로 오채점 발생:**
- ① AI가 학생 손글씨를 잘못 읽음 (예: "which were bui" 처럼 잘림).
- ② **정답지가 AI 추측이라 부정확** → "정답이라고 올린 게 죄다 틀림"의 근본 원인.

---

## 완료된 작업 (커밋됨)

**서술형 부분점수 채점** — 커밋 `46ec2aa`
- 채점 결과에서 정답/오답 이분법만 되던 것을 **획득점수(부분점수) 입력** 가능하도록 개선.
- `student-grader.html`: `획득 / 배점` 칸 추가, 정오에 `부분` 추가, 획득점수↔정오 양방향 동기화, 총점=획득점수 합산.
- `examAnalyzerModule.js` `save-student-result`: earned를 이분법이 아니라 입력된 부분점수로 저장(배점 범위 보정), 리포트에 `부분 N` 표기.
- `student-report-data`: 부분점수 문항을 약점 분석에서 오답과 함께 취급.
- `results-viewer.html`: `부분` 행 색상 추가.

---

**Phase 1 — 학생 셀프 답안 입력** — 커밋됨 ✅
- `examAnalyzerModule.js`: 공통 헬퍼 추출(`listExams`, `gradeAgainstKey`, `persistStudentResult`) 및 `grade-student`/`save-student-result` 리팩터. 학생용 가드 `requireStudent` 추가.
- 신규 엔드포인트: `GET /api/student/exam-list`, `GET /api/student/exam-questions`(정답 미포함), `POST /api/student/submit-exam`(서버 채점+저장, 중복 제출 409 차단, 등록자 "이름 (학생제출)").
- `planner-modular.html`: 메뉴 `📄 시험 답안 입력하기` + `exam-view` + JS(시험 선택→객관식 1~5 버튼/서술형 textarea→제출). `goToView`/`goToViewHelper`에 `exam` 분기.
- 결정 반영: 중복 제출 막기 / 시험 전부 노출 / 이름으로 식별.
- 검증: 채점·저장 로직 유닛테스트 통과. (※ 이 컨테이너의 `node_modules/@anthropic-ai/sdk` 설치가 불완전해 모듈 import 테스트는 불가 — 코드 문제 아님, Replit 배포본은 별도 설치. 로컬에서 돌릴 일 있으면 `npm install` 재실행 필요.)

---

## 합의된 방향

원인 ①은 **AI 인식을 없애고 학생이 직접 답을 입력**하게 해서 제거하고,
원인 ②는 **재채점 기능**으로 보완한다. 학생 로그인은 이미 존재(`POST /login`, JWT `role:'student'`, `req.user.userId`=학생ID(소문자), `req.user.name`=이름). 학생 플래너는 `planner-modular.html`(메뉴 버튼 → 서브뷰 전환).

### Phase 1 — 학생 셀프 답안 입력 → **완료** (위 "완료된 작업" 참고)

### Phase 2 — 정답지 수정 + 재채점 (다음 작업)
- `GET /api/exam-answer-key?examPageId=` + `POST /api/update-answer-key` — 저장된 정답지 불러와 정답/배점 수정(QUESTION_DB 페이지 업데이트). 현재 저장 후 정답지 수정 화면이 없으므로 필요.
- `POST /api/regrade-exam` — 그 시험 응시 **학생 전원 재채점**. 저장된 `학생답`을 현재 정답지와 다시 대조해 **객관식만** 재계산하고, **선생님이 매긴 서술형 점수(부분점수 포함)는 보존**. STUDENT_ANSWER 행 + STUDENT_RESULT 총점 갱신.
- 서술형 채점/수정을 위해 `results-viewer.html`에서 **저장된 결과를 열어 수정**하는 화면(학생 제출 서술형을 여기서 부분점수 채점). 로드/저장 엔드포인트 한 쌍(`result-answers` 로드 + `update-student-result` 저장) 추가.
- UI: 결과 조회에 `재채점`·`채점/수정` 버튼, 정답지 수정 화면.

---

## 진행 전 확정할 결정 (사용자 확인 대기 중)

기본값 추천 상태이며, 사용자가 "추천대로"라고 하면 아래대로 구현:
1. **중복 제출** — 이미 제출한 시험은 **막고 "이미 제출됨" 안내**(원장이 삭제해야 재제출). 덮어쓰기는 후순위. ← 추천
2. **시험 노출 범위** — 학생에게 저장된 시험을 **전부** 노출(학생 토큰에 학년 정보 없음). 학년 필터는 후순위. ← 추천
3. **학생 식별** — 기존 결과 DB가 **이름(학생명)** 기준이라 이름으로 기록. **동명이인 있으면 학생ID도 함께 저장**하도록 변경 필요 — 사용자 확인 필요.

---

## 이어서 할 때 첫 단계
1. 위 "진행 전 확정할 결정" 3가지를 사용자에게 확인(또는 "추천대로 가").
2. Phase 1부터 구현 → 커밋 → 푸시. 이어서 Phase 2.
3. 이 문서(`EXAM_GRADER_HANDOFF.md`)는 인계용이므로, 기능이 다 끝나면 삭제해도 된다.
