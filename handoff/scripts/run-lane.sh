#!/bin/bash
# usage: run-lane.sh <lane-dir> <lane-db> <queue-file>
S=${HANDOFF_STATE:-/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad}
LANE=$1; DB=$2; Q=$3
while true; do
  ITEM=$(flock "$Q.lock" bash -c "head -1 '$Q'; sed -i '1d' '$Q'")
  [ -z "$ITEM" ] && break
  set -- $ITEM
  echo "$(date +%H:%M:%S) start $ITEM" >> "$S/runner.log"
  RES=$(bash "$S/check-pr.sh" "$LANE" "$DB" "$1" "${2:-pr/$1}" 2>>"$S/runner.err")
  echo "$(date +%H:%M:%S) [$DB] $RES" >> "$S/runner.log"
done
echo "$(date +%H:%M:%S) lane $DB done" >> "$S/runner.log"
