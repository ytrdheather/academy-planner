---
id: stale-head-line-refs
title: 낡은 HEAD 에서 읽고 위키에 라인 번호를 적었다
type: pitfall
status: verified
source: .claude/hooks/check-remote.sh, .claude/settings.json
updated: 2026-09-01
tags: [git, wiki, workflow, hook]
---

## 증상

작업을 다 끝내고 `git push` 했더니 거절됐다. 원격에 8일 전 커밋이 하나 있었다.

**코드는 멀쩡했다** — 자동 병합됐고 충돌도 없었다. 망가진 건 그 세션에 쓴 **위키의 `file:line` 참조**였다. `api/index.js:951` 이라고 적었는데 리베이스 후 실제 값은 **950** 이었다.

## 원인

이 위키는 코드를 복사하지 않고 **인용한다**([SCHEMA.md](../SCHEMA.md)). 그래서 페이지마다 `api/index.js:952` 같은 라인 번호가 박혀 있다.

낡은 HEAD 에서 코드를 읽으면 그 번호가 처음부터 틀린 채로 적힌다. 그리고 **아무도 못 잡는다**:

- git 은 **push 할 때야** 막아준다. 그땐 이미 틀린 번호를 적은 뒤다.
- 라인 번호는 틀려도 파일이 열리므로 lint 도 문법 검사도 안 걸린다.
- 다음 사람이 그 줄을 열어보고 엉뚱한 코드를 보고서야 안다.

원격 커밋이 `api/index.js` 를 44줄 늘리고 195행을 뺐던 터라, 그 커밋 자신도 "밀린 `file:line` 참조를 26개 파일에서 일괄 보정"하고 있었다. 같은 함정을 같은 파일에서 두 번 밟은 셈이다.

## 고친 방법

세션 시작 훅이 `git fetch` 하고 뒤처져 있으면 컨텍스트에 알린다.

```
.claude/settings.json      SessionStart → check-remote.sh (timeout 20)
.claude/hooks/check-remote.sh
```

앞서 있거나 같으면 **아무것도 출력하지 않는다.** 네트워크·인증이 막혀도 `exit 0` 이라 세션은 그냥 시작된다.

## 규칙

- **코드를 읽기 전에 맞춘다.** push 직전이 아니라 read 직전이다. 오염은 읽는 순간 들어온다.
- 🔴 **훅이 `pull` 을 대신 해주지 않는다.** 작업 트리가 더러운 채로 `pull` 하면 상태가 섞인다(이 저장소는 서브모듈이 상시 더럽다). 뒤처졌다고 알려만 주고 판단은 사람이 한다.
- 리베이스한 뒤에는 **그 세션에 쓴 `file:line` 을 다시 실측한다.** 병합이 조용히 성공해도 번호는 밀려 있다.

관련: [[teacher-rollup-name]] · [[render-manual-deploy]] · [[monthly-report]]
