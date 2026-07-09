# 시험 채점기 개선 — 작업 인계 문서 (HANDOFF)

> 이 문서 하나만 읽으면 어디서든(직장/집) 이어서 작업할 수 있게 정리한 노트다.
> **이어서 할 때:** 새 Claude Code 세션을 열고 → **"EXAM_GRADER_HANDOFF.md 읽고 이어서 해줘"** 라고만 하면 된다.

- **리포지토리**: `ytrdheather/academy-planner`
- **작업 브랜치**: `claude/exam-grader-ai-model-tjhtwv` (현재 `main`과 동일한 상태 — 아래 "배포" 참고)
- **배포**: Render가 GitHub `main` 브랜치를 자동 배포. (render.yaml 없음 → 설정은 Render 대시보드에 있음)
- **실행 위치**: 코드/작업은 전부 클라우드에서 돎. 사용자 PC엔 아무것도 설치할 필요 없음(브라우저만).
- **핵심 파일**: `api/examAnalyzerModule.js`(채점 API), `public/views/planner-modular.html`(학생 플래너), `public/views/student-grader.html`(원장 채점), `public/views/results-viewer.html`(결과 조회), `public/views/exam-analyzer.html`(시험지 분석), 진입점 `api/index.js`

---

## 📌 지금까지 상태 (오늘 마감 시점)

**두 기능 완성 → `main`에 병합 → Render 배포 완료(라이브).** 아직 라이브에서 실제 시험으로 끝까지 테스트는 사용자가 진행 중.

### ✅ 완료 1: 서술형 부분점수 채점 (커밋 `46ec2aa`)
정답/오답 이분법만 되던 채점에 **부분점수**를 넣음.
- `student-grader.html`: `획득 / 배점` 입력칸, 정오에 `부분` 추가, 획득점수↔정오 양방향 동기화, 총점=획득점수 합산.
- `examAnalyzerModule.js`: 저장 시 earned를 입력된 부분점수로 보존(0~배점 보정), 리포트에 `부분 N` 표기.
- `student-report-data`: 부분점수 문항을 약점 분석에서 오답과 함께 취급.
- `results-viewer.html`: `부분` 행 색상 추가.

### ✅ 완료 2: 학생 셀프 답안 입력 — Phase 1 (커밋 `510e62a`)
AI가 학생 손글씨를 읽던 단계를 없애고, **학생이 플래너에서 직접 입력**하게 함(원인 ① 제거).
- `examAnalyzerModule.js`
  - 공통 헬퍼 추출: `listExams`, `gradeAgainstKey`, `persistStudentResult` (기존 `grade-student`/`save-student-result`도 이걸 재사용하도록 리팩터).
  - `requireStudent` 가드 추가.
  - `GET /api/student/exam-list` — 저장된 시험 전부 노출.
  - `GET /api/student/exam-questions?examPageId=` — 번호·유형·배점만 (⚠️ **정답 미포함** — 학생에게 답 유출 금지).
  - `POST /api/student/submit-exam` — 서버가 정답지와 대조 채점(객관식 자동, 서술형 채점대기) 후 저장. **중복 제출 409 차단**, 등록자 `"이름 (학생제출)"`.
- `planner-modular.html`: 메뉴 `📄 시험 답안 입력하기` + `exam-view` + JS(시험 선택 → 객관식 1~5 버튼 / 서술형 textarea → 제출). `goToView`/`goToViewHelper`에 `exam` 분기.
- **확정된 결정**(반영 완료): (1) 중복 제출 막기 (2) 시험 전부 노출 (3) 동명이인 없어 이름으로 식별.
- 검증: 채점·저장 로직 유닛테스트 통과(객관식 정오, ①②③ 정규화, 서술형 채점대기, 점수 합산, 중복 차단, 정답 미유출).

> ⚠️ 참고: 이 클라우드 컨테이너의 `node_modules/@anthropic-ai/sdk` 설치가 불완전해 여기선 서버를 직접 못 띄움 — **코드 문제 아님**(Render 배포본은 정상). 로컬 실행이 필요하면 `npm install` 재실행.

---

## 배경 / 아직 남은 근본 문제

시험 채점기 원래 흐름:
1. `/api/analyze-exam` — Claude(`claude-sonnet-4-6`)가 시험지 사진을 보고 **문항을 직접 풀어 정답지 생성** → 저장(EXAM_DB / QUESTION_DB).
2. `/api/grade-student` — 학생 답안을 정답지와 문자열 비교로 O/X 채점 → STUDENT_RESULT_DB / STUDENT_ANSWER_DB.

**오채점 원인 두 가지:**
- ① AI가 학생 손글씨를 잘못 읽음 → **Phase 1로 해결됨**(학생이 직접 입력).
- ② **정답지가 AI 추측이라 부정확** → "정답이라고 올린 게 죄다 틀림"의 근본 원인 → **아직 미해결. Phase 2가 이걸 잡는다.**

학생 로그인은 이미 존재: `POST /login`, JWT `role:'student'`, `req.user.userId`=학생ID(소문자), `req.user.name`=이름.

---

## 🔜 다음 작업: Phase 2 — 정답지 수정 + 재채점

원인 ②(정답지 오류)를 잡는 단계.

1. **정답지 수정** — `GET /api/exam-answer-key?examPageId=` + `POST /api/update-answer-key`.
   저장된 정답지를 불러와 정답/배점을 수정(QUESTION_DB 페이지 업데이트). 지금은 저장 후 정답지를 고칠 화면이 없어서 필요. UI는 `exam-analyzer.html` 확장 또는 `results-viewer.html`에 "정답지 수정" 화면 추가.
2. **재채점** — `POST /api/regrade-exam`.
   해당 시험 응시 **학생 전원 재채점**: 저장된 `학생답`을 **현재 정답지**와 다시 대조해 **객관식만** 재계산하고, **선생님이 매긴 서술형 점수(부분점수 포함)는 보존**. STUDENT_ANSWER 행 + STUDENT_RESULT 총점 갱신. (헬퍼 `gradeAgainstKey`/집계 로직 재사용 가능)
3. **서술형 채점/수정 화면** — 학생이 제출한 서술형을 원장이 채점해야 하므로, `results-viewer.html`에서 **저장된 결과를 열어 수정**하는 화면 필요. 로드/저장 엔드포인트 한 쌍(`GET result-answers` + `POST update-student-result`) 추가. 여기서 완료 2의 부분점수 UI를 그대로 활용.
4. **UI 버튼** — 결과 조회에 `재채점`·`채점/수정` 버튼.

구현 순서 추천: (3) 서술형 채점 화면 → (1) 정답지 수정 → (2) 재채점. 각 단계 커밋 후, 배포하려면 `main`에 병합.

---

## 🏠→🏢 내일 이어서 하는 법 (쉬운 버전)

1. 브라우저에서 **claude.ai/code** 로그인(계정: `ytrd.heather@gmail.com`).
2. 이 리포(`academy-planner`)의 브랜치 `claude/exam-grader-ai-model-tjhtwv`로 **새 세션** 열기.
   - 대화가 그대로 이어져 보이면 그냥 이어서 말하면 됨.
   - 안 보여도 걱정 없음 → 새 세션에서 **"EXAM_GRADER_HANDOFF.md 읽고 Phase 2 이어서 해줘"** 라고 하면 됨.
3. 사용자 PC엔 아무것도 설치 안 해도 됨(직장 컴이든 집 컴이든 브라우저만).

## 배포 & 되돌리기 (라이브 반영)

- **배포**: 코드를 `main`에 올리면 Render가 자동 배포(몇 분). 진행상황은 Render 대시보드 **Events/Logs**.
- **되돌리기(가장 쉬움)**: Render 대시보드 → 서비스 → **Deploys** → 이전 배포 옆 **Rollback**. (git 몰라도 됨)
- 코드로 되돌리려면 Claude에게 "되돌려줘" 요청. (오늘 배포 직전 `main` 커밋: `0dd5381`)
- ⚠️ 라이브에서 학생 제출/채점을 테스트하면 **실제 Notion에 데이터가 쌓임** → 테스트 후 그 행 삭제.

## 테스트 체크리스트 (라이브)

- [ ] 부분점수: 원장 채점 화면에서 서술형 `획득/배점`에 숫자 입력 → 정오 `부분` 자동, 총점 합산.
- [ ] 학생 셀프 입력: 학생 플래너 로그인 → `📄 시험 답안 입력하기` → 시험 선택 → 제출 → 원장 결과 조회 확인.
- [ ] 중복 제출: 같은 시험 두 번 제출 → "이미 제출됨" 뜨는지.
- [ ] (Phase 2 후) 정답지 수정 → 재채점 → 학생 점수 갱신 확인.

> 이 문서는 인계용. 기능이 다 끝나면 삭제해도 된다.
