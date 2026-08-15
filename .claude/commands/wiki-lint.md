---
description: 위키 건강검진 — 끊긴 링크, 고아 페이지, 밀린 source, inferred, 모순
---

`wiki/SCHEMA.md`의 **lint** 절차로 위키를 점검하라.

🔴 **lint는 자동으로 고치지 않는다.** 보고하고 승인을 받는다.

## 기계적 점검 (먼저 돌린다)

```bash
cd "$CLAUDE_PROJECT_DIR" && \
echo "=== 페이지 목록 ===" && ls wiki/*/*.md | sed 's#wiki/##;s#\.md##' && \
echo "=== 참조된 [[링크]] ===" && grep -rhoE '\[\[[a-z0-9-]+\]\]' wiki/ | tr -d '[]' | sort -u && \
echo "=== inferred / stale ===" && grep -rn "^status: \(inferred\|stale\)" wiki/ && \
echo "=== updated 날짜 ===" && grep -rn "^updated:" wiki/ | sort -t: -k3
```

## 점검 항목

| # | 무엇 | 어떻게 |
|---|---|---|
| 1 | **끊긴 링크** | 참조된 `[[id]]` 중 실존 파일이 없는 것. `wiki/index.md`의 "미작성" 표에 있으면 정상, 없으면 지적 |
| 2 | **index 누락** | `wiki/*/*.md`는 있는데 `index.md`에 없는 것 |
| 3 | **고아 페이지** | 아무도 링크 안 하고 index에도 없는 것 |
| 4 | **밀린 `source:`** | frontmatter의 `api/index.js:NNN`을 **실제로 열어** 그 줄에 그 함수/코드가 있는지 확인. 코드가 밀리면 라인 번호가 거짓말이 된다. 이게 이 위키에서 가장 잘 썩는 부분이다 |
| 5 | **`status: inferred`** | 아직 코드로 확인 안 된 페이지 목록을 그대로 보고 |
| 6 | **모순** | 두 페이지가 같은 사실을 다르게 말하는 것. 특히 크론 시각, DB ID, 환경변수 이름, 파일 경로 |
| 7 | **오래된 `updated:`** | 오래됐고 그 사이 해당 코드가 `git log`상 바뀐 것 |

## 보고 형식

항목별로 **발견 / 없음**을 명시하고, 발견한 것은 심각도 순으로 나열한다. 각 건마다 **어떻게 고칠지**를 한 줄로 제안하되 **고치지는 마라.**

마지막에 `wiki/log.md`에 추가한다:
```
## [YYYY-MM-DD] lint | N건 발견 (끊긴링크 a / 밀린source b / inferred c / 모순 d)
```

그리고 **"다음에 뭘 파면 좋을지"** 두세 개를 제안한다 — 위키의 구멍이 곧 다음 작업 목록이다.
