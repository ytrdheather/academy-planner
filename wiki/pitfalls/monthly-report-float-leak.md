---
id: monthly-report-float-leak
title: 월간 리포트 점수가 87.7777777 로 나왔다
type: pitfall
status: verified
source: api/monthlyReportModule.js:22-40
updated: 2026-09-01
tags: [notion, formula, report, rounding]
---

## 증상

학부모가 보는 월간 리포트에 점수가 **`87.77777777777779점`** 으로 찍혔다. 문법 파트별 막대 그래프, AI 종합 리포트 본문, 선생님 대시보드의 학생 히스토리 팝업 세 곳 전부.

## 원인

노션 **수식(formula) 속성이 실수를 그대로 돌려준다.** `맞은개수 / 총개수 * 100` 이 `87.77777777777779` 다.

코드는 이 값을 `parseFloat` 해서 **아무 데도 반올림하지 않고** 흘려보냈다. 평균만 `Math.round` 하고 있어서 상단 타일 4개는 멀쩡해 보였고, 그래서 오래 안 잡혔다. 새는 경로는 셋:

1. 문법 막대 `${g.score}점` — 화면에 직접
2. `grammarDetailsString` → **Gemini 프롬프트** → AI 요약 본문에 그대로 박힘
3. `/api/student-history` 의 별도 파싱 사본

같은 "수식에서 점수 꺼내기" 로직이 **파일 안에 세 벌 복사**돼 있어서 한 곳을 고쳐도 나머지가 남았다.

## 고친 방법

값을 **꺼내는 지점 한 곳**에서만 정수로 맞춘다. 사본 3개를 지우고 전부 이 함수를 부르게 했다.

```js
function getScoreFromFormula(prop) {   // api/monthlyReportModule.js:28
    if (prop?.formula?.type === 'number') return roundScore(prop.formula.number);
    // string 이면 숫자만 뽑아 roundScore
}
```

## 규칙

- **노션 수식 점수는 읽는 즉시 반올림한다.** 화면·프롬프트·평균 어디로도 실수를 흘려보내지 마라.
- **평균이 깨끗하다고 원본이 깨끗한 건 아니다.** `Math.round(평균)` 은 개별 값의 소수점을 가려준다.
- 같은 속성을 읽는 코드가 두 벌 이상이면 **한 벌만 고쳐서는 안 고쳐진다.** 헬퍼로 합쳐라 → [[notion-prop-read]]

관련: [[monthly-report]] · [[notion-prop-read]] · [[teacher-rollup-name]]
