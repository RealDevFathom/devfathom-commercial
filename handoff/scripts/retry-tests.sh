#!/bin/bash
# Re-run a PR's failing related test files: on the PR head and on develop, each with the gate runtime
# role and with a superuser role. Writes <checkdir>/retry.json with failing-test sets per run.
# usage: retry-tests.sh <pr> [ref]
set -u
S=${HANDOFF_STATE:-/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad}
N=$1; REF=${2:-pr/$N}
DIRC=$(readlink -f $S/checks/$N/latest)
SUM=$DIRC/summary.json
mapfile -t FILES < <(python3 -I -c "import json;[print(f['file']) for f in json.load(open('$SUM'))['tests']['failedFiles']]")
[ ${#FILES[@]} -eq 0 ] && { echo "no failing files"; exit 0; }
OUT=$DIRC/retry; rm -rf $OUT; mkdir -p $OUT
export PGPASSWORD=gate-postgres-ci-only
PG="psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q"
runset() { # dir label db [super]
  local dir=$1 label=$2 db=$3; shift 3
  ( cd "$dir"; source $S/gate.env
    for v in $(grep -o '^export [A-Z0-9_]*' $S/gate.env | cut -d' ' -f2); do val="${!v}"; [[ "$val" == *"/devfathom_gate_test"* ]] && export "$v=${val//\/devfathom_gate_test//$db}"; done
    export OWNER_URL="postgresql://gate_owner:gate-owner-ci-only@127.0.0.1:55432/$db"
    bash $S/mkdb.sh "$db" "$dir" > $OUT/$label.db.log 2>&1
    [ "${1:-}" = super ] && export DATABASE_URL="postgresql://postgres:gate-postgres-ci-only@127.0.0.1:55432/$db" TEST_DATABASE_URL="postgresql://postgres:gate-postgres-ci-only@127.0.0.1:55432/$db"
    present=(); for f in "${FILES[@]}"; do [ -f "$f" ] && present+=("$f"); done
    printf '%s\n' "${present[@]}" > $OUT/$label.present
    [ ${#present[@]} -eq 0 ] && exit 0
    RESTAURANT_DEMO_RESET_DB=1 timeout 900 bunx vitest run "${present[@]}" --maxWorkers=1 --reporter=json --outputFile=$OUT/$label.json > $OUT/$label.log 2>&1
    echo $? > $OUT/$label.exit )
}
cd $S/laneC && git checkout -q --detach "$REF" && bunx prisma generate >/dev/null 2>&1
runset $S/laneC pr-runtime devfathom_gate_lane_c_test
runset $S/laneC pr-super devfathom_gate_lane_c_test super
BASEREF=$(git -C $S/laneC merge-base origin/develop "$REF"); echo "$BASEREF" > $OUT/base-ref
cd $S/laneC && git checkout -q --detach "$BASEREF" && bunx prisma generate >/dev/null 2>&1
runset $S/laneC base-runtime devfathom_gate_lane_c_test
runset $S/laneC base-super devfathom_gate_lane_c_test super
python3 -I - "$OUT" <<'PY'
import json, sys, os
out=sys.argv[1]
def load(label):
    p=os.path.join(out,label+".json")
    present=[l.strip() for l in open(os.path.join(out,label+".present"))] if os.path.exists(os.path.join(out,label+".present")) else []
    if not os.path.exists(p): return {"present":present,"failing":[],"suiteErrors":[],"ran":False}
    v=json.load(open(p)); failing=[]; suite=[]
    for r in v["testResults"]:
        name=r["name"].split("/laneC/")[-1]
        fa=[name+" > "+a["fullName"] for a in r["assertionResults"] if a["status"]=="failed"]
        failing+=fa
        if r["status"]=="failed" and not fa: suite.append(name)
    return {"present":present,"failing":sorted(failing),"suiteErrors":sorted(suite),"ran":True,"passed":v["numPassedTests"],"failed":v["numFailedTests"]}
R={l:load(l) for l in ("pr-runtime","pr-super","base-runtime","base-super")}
def bad(x): return set(x["failing"])|set(x["suiteErrors"])
newFiles=sorted(set(R["pr-runtime"]["present"])-set(R["base-runtime"]["present"]))
introducedRuntime=sorted(bad(R["pr-runtime"])-bad(R["base-runtime"]))
introducedSuper=sorted(bad(R["pr-super"])-bad(R["base-super"]))
# a failure is attributable to the PR if it is introduced in both role setups, or it is in a file new to the PR
attributable=sorted((set(introducedRuntime)&set(introducedSuper)) | {t for t in bad(R["pr-runtime"])|bad(R["pr-super"]) if t.split(" > ")[0] in newFiles and t in bad(R["pr-super"])})
res=dict(runs=R,newFiles=newFiles,introducedRuntime=introducedRuntime,introducedSuper=introducedSuper,attributable=attributable,
         preexisting=sorted(bad(R["pr-runtime"])&bad(R["base-runtime"])),
         envOnly=sorted(bad(R["pr-runtime"])-bad(R["pr-super"])))
json.dump(res,open(os.path.join(out,"..","retry.json"),"w"),indent=1)
print(f"attributable={len(attributable)} preexisting={len(res['preexisting'])} envOnly={len(res['envOnly'])} newFiles={newFiles}")
PY
