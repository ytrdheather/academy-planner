---
id: exam-analyzer
title: 시험지 분석기 + 학생 채점기
type: system
status: verified
source: api/examAnalyzerModule.js, EXAM_GRADER_HANDOFF.md
updated: 2026-08-15
tags: [exam, grading, claude, vision, notion]
---

## 한 줄

시험지 이미지·PDF를 Claude vision으로 분석해 문항별 정답지를 만들고(원장 전용), 그 정답지로 학생 답안을 채점해 리포트까지 낸다.

## 흐름

```
[정답지 만들기]  /exam-analyzer → 이미지·PDF 업로드(최대 10장, 32MB)
   → Claude가 문항별 유형/출제범위/문법포인트/배점/난이도/정답 추출
   → 편집표에서 선생님이 수정 → 저장
   → EXAM_DB(시험 1개=1행) + QUESTION_DB(문항 1개=1행, relation)

[채점]  /student-grader → 저장된 시험 선택 + 학생 이름 입력 + 답안 업로드
   → Claude는 학생 답만 읽음 → 코드가 정답지와 대조
   → 편집 가능한 정오표(라이브 점수) → 저장
   → STUDENT_RESULT_DB(학생 1명=1행) + STUDENT_ANSWER_DB(학생×문항=1행)

[보기]  /results-viewer (시험별·학생별 탭)  /student-report?resultId= (A4 인쇄용 PDF)
```

**전부 원장 전용** — `requireOwner` (`loginId === 'manager'`).

## 계약

- 🔴 **학생 이름·학교·학년은 손글씨 인식을 하지 않는다.** 선생님이 직접 입력·선택한다(오인식하면 정답지 매칭이 깨진다).
- 🔴 **서술형은 자동채점하지 않는다.** 학생답을 옮겨적어 모범답안 옆에 보여주고 선생님이 O/X를 고른다(초기 `verdict='채점대기'`). 점수·취약유형·리포트는 **선생님이 검토한 최종 verdict로 재계산**한다.
- 객관식 대조는 `normalizeAnswer`(①②③④⑤→1~5, 공백 제거, 소문자).
- **출제범위 4종**(교과서본문·외부지문·대화문·학습지)은 **이미지만으로 AI가 구분할 수 없어 선생님이 드롭다운에서 고르는 것이 의도된 설계다.** 자동화하려 하지 마라.
- **문항별 한 줄 저장 구조를 JSON blob으로 되돌리지 마라.** 처음엔 `문항데이터` 한 칸에 JSON을 넣었는데 노션에서 안 읽혀서 바꿨다. 문항 행이 있어야 "이 학생이 여러 시험에서 관계대명사를 반복 오답" 같은 누적 분석이 된다.
- 지문이 안 잡히는 독해문항은 정답이 틀릴 수 있다 → 편집표에서 수정하는 게 정상 운영이다.
- **학생 리포트 문장은 규칙 + AI 혼합.** 대책은 규칙 기반 `TYPE_ADVICE`/`SOURCE_ADVICE` 매핑, 종합 코멘트만 Gemini가 쓰고 **실패하면 규칙 폴백**.

## Notion DB 4개

| DB | 단위 | env |
|---|---|---|
| 시험지 분석 | 시험 1개 | `EXAM_DB_ID` |
| 시험 문항 | 문항 1개 (relation→시험) | `QUESTION_DB_ID` |
| 학생 응시 결과 | 학생 1명 (relation→시험) | `STUDENT_RESULT_DB_ID` |
| 학생 문항 응답 | 학생×문항 (relation→결과) | `STUDENT_ANSWER_DB_ID` |

## 남은 일 / 확인 필요

- **Render 환경변수 4개가 다 등록됐는지** — 빠지면 500. `EXAM_DB_ID`·`ANTHROPIC_API_KEY`는 등록 확인됨.
- **실제 학생 답안으로 `grade-student` 실사용 테스트가 아직 없다** — 손글씨·마킹 인식률과 서술형 옮겨적기 품질 미검증.
- 후보: 결과 CSV/PDF 내보내기, 반 전체 통계.

## 함정

- 🔴 진짜 배포 코드는 **저장소 루트의 `api/`**다. `academy-planner/uri-hagweon-gwanri-peurogeuraem/`은 안 쓰는 옛 사본이다.
- Git Bash에서 curl로 한글 JSON을 인라인 전송하면 인코딩이 깨져 select 비교가 실패한다. 테스트는 **UTF-8 파일 + `--data-binary`**로.
- 이 시스템만 **Claude(Anthropic)를 쓴다.** 나머지 AI는 Gemini다.

관련: [[external-services]] · [[notion-databases]] · [[auth-jwt]] · [[views]]
