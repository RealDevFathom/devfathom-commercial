#!/bin/bash
# usage: prettier-fix.sh <pr> <branch> <expected-sha-prefix> <issue> <files...>
set -u
S=${HANDOFF_STATE:-/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad}
N=$1; BR=$2; EXP=$3; ISS=$4; shift 4
cd $S/fixD || exit 2
git checkout -q -- . 2>/dev/null
git fetch -q origin "$BR" || { echo "$N fetch failed"; exit 1; }
git checkout -q --detach FETCH_HEAD
HEAD=$(git rev-parse HEAD)
[[ "$HEAD" == $EXP* ]] || { echo "$N branch moved: $HEAD != $EXP"; exit 1; }
node_modules/.bin/prettier --write "$@" >/dev/null || { echo "$N prettier failed"; exit 1; }
CH=$(git diff --name-only | sort | tr '\n' ' ')
[ -z "$CH" ] && { echo "$N nothing to change"; exit 0; }
LIST=$(printf '%s\n' "$@" | sort | tr '\n' ' ')
[ "$CH" == "$LIST" ] || { echo "$N unexpected changes: $CH"; git checkout -q -- .; exit 1; }
STAT=$(git diff --shortstat)
git add -- "$@"
NAMES=$(printf '%s, ' "$@"); NAMES=${NAMES%, }
git commit -q -F - <<MSG
style($ISS): apply the repo Prettier config to files this PR changed [skip ci]

Formatting only: \`prettier --write\` with .prettierrc on $NAMES.
These files were added or edited by this PR and failed
\`prettier --check\`, which the QA gate runs on changed files. No
behaviour change.
MSG
git push -q origin HEAD:refs/heads/$BR 2>&1 | grep -v "^remote:" ; echo "$N pushed $(git rev-parse --short HEAD) ($STAT)"
