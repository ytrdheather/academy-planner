#!/usr/bin/env bash
# 세션 시작 훅 — 로컬이 원격보다 뒤처져 있으면 알린다.
#
# 왜: 이 저장소는 wiki/ 가 `api/index.js:950` 같은 라인 번호를 인용한다.
# 낡은 HEAD 에서 코드를 읽고 위키를 고치면 그 참조가 조용히 어긋난다.
# git 은 push 할 때야 막아주는데, 그땐 이미 틀린 번호를 적은 뒤다.
# (2026-09-01: 8일 뒤처진 채로 작업해서 실제로 밟았다 → wiki/pitfalls/stale-head-line-refs.md)
#
# 앞서 있거나 같으면 아무것도 출력하지 않는다. 조용한 게 기본이다.
# pull 을 자동으로 하지는 않는다 — 작업 트리가 더러우면 상태를 섞기 때문에 사람이 판단한다.

git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# 네트워크가 없거나 인증이 막혀도 세션은 그냥 시작돼야 한다
git fetch --quiet 2>/dev/null

upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || exit 0
[ -n "$upstream" ] || exit 0

behind=$(git rev-list --count "HEAD..$upstream" 2>/dev/null || echo 0)
ahead=$(git rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0)

[ "${behind:-0}" -gt 0 ] 2>/dev/null || exit 0

dirty=''
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    dirty=' 작업 트리가 더러우니 먼저 정리하거나 stash 한다.'
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[git] 로컬이 %s 보다 %s 커밋 뒤처져 있다(앞선 커밋 %s개). 코드를 읽기 전에 git pull --rebase 로 맞춰라 - 낡은 HEAD 에서 읽으면 wiki 의 file:line 참조가 조용히 어긋난다.%s"}}' \
    "$upstream" "$behind" "$ahead" "$dirty"
