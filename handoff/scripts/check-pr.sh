#!/bin/bash
# Machine checks for one PR head, run inside one lane checkout.
# usage: check-pr.sh <lane-dir> <lane-db> <pr-number> [ref]
# Writes $S/checks/<pr>/<sha>/{summary.json,*.log}
set -u
S=${HANDOFF_STATE:-/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad}
LANE=$1; LANEDB=$2; N=$3; REF=${4:-pr/$N}
cd "$LANE" || exit 2
export PGPASSWORD=gate-postgres-ci-only
PG="psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q"

STATE=$S/lanes/$(basename "$LANE"); mkdir -p "$STATE"
git checkout -q --detach "$REF" || { echo "checkout failed"; exit 2; }
SHA=$(git rev-parse HEAD)
OUT=$S/checks/$N/$SHA
rm -rf "$OUT"; mkdir -p "$OUT"
MB=$(git merge-base origin/develop HEAD)
git diff --name-only "$MB" HEAD > "$OUT/changed.txt"
git diff --name-only --diff-filter=D "$MB" HEAD > "$OUT/deleted.txt"
START=$(date +%s)

# ---- deps
DEPHASH=$(cat package.json bun.lock | sha256sum | cut -c1-16)
if [ "$(cat "$STATE/dephash" 2>/dev/null)" != "$DEPHASH" ]; then
  bun install --frozen-lockfile > "$OUT/install.log" 2>&1; INSTALL=$?
  [ $INSTALL -eq 0 ] && echo "$DEPHASH" > "$STATE/dephash" && rm -f "$STATE/prismahash"
  INSTALL_NOTE="bun install --frozen-lockfile"
else
  INSTALL=0; INSTALL_NOTE="lockfile unchanged; node_modules reused"; echo "$INSTALL_NOTE" > "$OUT/install.log"
fi
PRISMAHASH=$(cat prisma/schema.prisma | sha256sum | cut -c1-16)
if [ "$(cat "$STATE/prismahash" 2>/dev/null)" != "$PRISMAHASH" ]; then
  bunx prisma generate > "$OUT/prisma-generate.log" 2>&1 && echo "$PRISMAHASH" > "$STATE/prismahash"
fi

# ---- per-lane database from template, then this PR's migrations
source $S/gate.env
for v in $(grep -o '^export [A-Z0-9_]*' $S/gate.env | cut -d' ' -f2); do
  val="${!v}"; [[ "$val" == *"/devfathom_gate_test"* ]] && export "$v=${val//\/devfathom_gate_test//$LANEDB}"
done
OWNER_URL="postgresql://gate_owner:gate-owner-ci-only@127.0.0.1:55432/$LANEDB"
bash "$S/mkdb.sh" "$LANEDB" "$LANE" > "$OUT/db.log" 2>&1; MIGRATE=$?
if grep -q '^prisma/seed' "$OUT/changed.txt"; then
  DATABASE_URL="$OWNER_URL" MIGRATION_DATABASE_URL="$OWNER_URL" bunx prisma db seed >> "$OUT/db.log" 2>&1; SEED=$?
else SEED=0; fi

# ---- typecheck (full project, incremental info kept per lane)
T0=$(date +%s)
flock "$S/heavy.lock" env NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit > "$OUT/typecheck.log" 2>&1; TC=$?
TC_SECS=$(( $(date +%s) - T0 )); [ $TC -ge 128 ] && echo "typecheck killed by signal $((TC-128))" >> "$OUT/typecheck.log"
grep -E 'error TS[0-9]+' "$OUT/typecheck.log" | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u > "$OUT/typecheck.errors"
BASEERR=$S/baseline/typecheck.errors
if [ -s <(comm -23 "$OUT/typecheck.errors" $BASEERR) ] && [ "$MB" != "$(git rev-parse origin/develop)" ]; then
  # PR sits on an older develop: compare against its own merge-base instead
  BASEERR=$S/baseline/typecheck.$MB.errors
  if [ ! -f "$BASEERR" ]; then
    git checkout -q --detach "$MB" && bunx prisma generate >/dev/null 2>&1
    flock "$S/heavy.lock" env NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit 2>/dev/null | grep -E 'error TS[0-9]+' | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u > "$BASEERR.tmp" && mv "$BASEERR.tmp" "$BASEERR"
    git checkout -q --detach "$SHA" && bunx prisma generate >/dev/null 2>&1; rm -f "$STATE/prismahash"
  fi
  echo "$MB" > "$OUT/typecheck.baseline-ref"
fi
comm -23 "$OUT/typecheck.errors" "$BASEERR" > "$OUT/typecheck.new"
comm -13 "$OUT/typecheck.errors" "$BASEERR" > "$OUT/typecheck.fixed"

# ---- lint (project script: eslint src/), content-hash cache per lane
T0=$(date +%s)
bunx eslint src/ --cache --cache-strategy content --cache-location "$STATE/eslintcache" -f json -o "$OUT/lint.json" > "$OUT/lint.log" 2>&1; LINT=$?
LINT_SECS=$(( $(date +%s) - T0 ))

# ---- tests related to changed files
mapfile -t CODE < <(grep -E '\.(ts|tsx|mts|js|mjs)$' "$OUT/changed.txt" | while read -r f; do [ -f "$f" ] && echo "$f"; done)
T0=$(date +%s)
if [ ${#CODE[@]} -gt 0 ]; then
  RESTAURANT_DEMO_RESET_DB=1 timeout 1500 bunx vitest related --run "${CODE[@]}" --maxWorkers=2 --reporter=json --outputFile="$OUT/vitest.json" > "$OUT/vitest.log" 2>&1; TESTS=$?
else
  TESTS=0; echo "no changed code files" > "$OUT/vitest.log"
fi
TEST_SECS=$(( $(date +%s) - T0 ))

# ---- build (production path: tsc runs separately above, as in Dockerfile)
T0=$(date +%s)
flock "$S/heavy.lock" env NODE_OPTIONS=--max-old-space-size=8192 NEXT_BUILD_SKIP_TYPECHECK=1 timeout 2400 bun run build > "$OUT/build.log" 2>&1; BUILD=$?
BUILD_SECS=$(( $(date +%s) - T0 ))

python3 -I - "$OUT" <<PY
import json, sys, os
out=sys.argv[1]
def lines(p):
    try: return [l.rstrip('\n') for l in open(os.path.join(out,p)) if l.strip()]
    except FileNotFoundError: return []
lint={"errors":0,"warnings":0,"errorMessages":[]}
try:
    for f in json.load(open(os.path.join(out,"lint.json"))):
        lint["errors"]+=f["errorCount"]; lint["warnings"]+=f["warningCount"]
        for m in f["messages"]:
            if m.get("severity")==2: lint["errorMessages"].append(f'{f["filePath"].split("devfathom-commercial/")[-1].split("/laneA/")[-1].split("/laneB/")[-1]}:{m.get("line")} {m.get("ruleId")} {m.get("message")}')
except Exception as e: lint["parseError"]=str(e)
tests={"files":0,"passedFiles":0,"failedFiles":[],"tests":0,"passed":0,"failed":0,"skipped":0}
try:
    v=json.load(open(os.path.join(out,"vitest.json")))
    tests.update(tests=v["numTotalTests"],passed=v["numPassedTests"],failed=v["numFailedTests"],skipped=v["numPendingTests"]+v.get("numTodoTests",0))
    for r in v["testResults"]:
        tests["files"]+=1
        name=r["name"].split("devfathom-commercial/")[-1].split("/laneA/")[-1].split("/laneB/")[-1]
        if r["status"]=="passed": tests["passedFiles"]+=1
        elif r["status"]=="failed":
            fails=[a["fullName"]+": "+(a.get("failureMessages") or [""])[0][:300] for a in r["assertionResults"] if a["status"]=="failed"]
            tests["failedFiles"].append({"file":name,"message":(r.get("message") or "")[:400],"failures":fails[:5]})
    tests["skippedFiles"]=[r["name"].split("devfathom-commercial/")[-1].split("/laneA/")[-1].split("/laneB/")[-1] for r in v["testResults"] if all(a["status"] in("pending","skipped","todo") for a in r["assertionResults"]) and r["assertionResults"]]
except Exception as e: tests["parseError"]=str(e)
s=dict(pr=int("$N"),sha="$SHA",mergeBase="$MB",lane="$LANE",
  install={"exit":$INSTALL,"note":"$INSTALL_NOTE"},
  migrate={"exit":$MIGRATE},seed={"exit":$SEED},
  typecheck={"exit":$TC,"secs":$TC_SECS,"errors":len(lines("typecheck.errors")),"newErrors":lines("typecheck.new"),"fixedBaselineErrors":lines("typecheck.fixed")},
  lint=dict(lint,exit=$LINT,secs=$LINT_SECS),
  tests=dict(tests,exit=$TESTS,secs=$TEST_SECS,codeFilesChanged=${#CODE[@]}),
  build={"exit":$BUILD,"secs":$BUILD_SECS},
  changed=lines("changed.txt"),totalSecs=$(( $(date +%s) - START )))
if $BUILD!=0:
    bl=[l for l in lines("build.log") if ("rror" in l or "Failed" in l) and "Dynamic filesystem" not in l]
    s["build"]["errorLines"]=bl[:15]
json.dump(s,open(os.path.join(out,"summary.json"),"w"),indent=1)
PY
ln -sfn "$OUT" "$S/checks/$N/latest"
if [ "$TESTS" != 0 ]; then flock "$S/laneC.lock" bash "$S/retry-tests.sh" "$N" "$SHA" > "$OUT/retry.out" 2>&1; fi
echo "PR $N $SHA retry=[$(tail -1 "$OUT/retry.out" 2>/dev/null)] tc=$TC(new $(wc -l < $OUT/typecheck.new)) lint=$LINT tests=$TESTS build=$BUILD secs=$(( $(date +%s) - START ))"
