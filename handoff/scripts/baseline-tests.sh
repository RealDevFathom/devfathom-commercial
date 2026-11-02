#!/bin/bash
# Run given test files on a develop checkout to learn whether failures pre-exist.
# usage: baseline-tests.sh <checkout-dir> <out-json> <test files...>
set -u
S=${HANDOFF_STATE:-/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad}
DIR=$1; OUTJ=$2; shift 2
LANEDB=devfathom_gate_lane_base_test
cd "$DIR" || exit 2
export PGPASSWORD=gate-postgres-ci-only
PG="psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q"
source $S/gate.env
for v in $(grep -o '^export [A-Z0-9_]*' $S/gate.env | cut -d' ' -f2); do
  val="${!v}"; [[ "$val" == *"/devfathom_gate_test"* ]] && export "$v=${val//\/devfathom_gate_test//$LANEDB}"
done
$PG -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$LANEDB'" >/dev/null 2>&1
$PG -c "DROP DATABASE IF EXISTS $LANEDB" -c "CREATE DATABASE $LANEDB TEMPLATE devfathom_gate_template OWNER gate_owner" >/dev/null 2>&1
$PG -c "GRANT CONNECT, TEMPORARY ON DATABASE $LANEDB TO gate_runtime" >/dev/null 2>&1
RESTAURANT_DEMO_RESET_DB=1 timeout 1500 bunx vitest run "$@" --maxWorkers=2 --reporter=json --outputFile="$OUTJ" > "$OUTJ.log" 2>&1
echo "exit=$?"
