#!/bin/zsh
# Run all three browser lanes serially (each binds its own port / next start).
set -u
GATE=/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se/_gate-evidence/134f17fa/wha-1132

echo "########## RESTAURANT LANE ##########"
"$GATE/02-run-restaurant.sh" > "$GATE/restaurant-lane.log" 2>&1
echo "RESTAURANT_DRIVER_EXIT=$?"
grep -E "RESTAURANT_LANE_EXIT|[0-9]+ (passed|failed|skipped|flaky)|did not run" "$GATE/restaurant-lane.log" | tail -8

echo "########## PLATFORM LANE ##########"
"$GATE/03-run-platform.sh" > "$GATE/platform-lane.log" 2>&1
echo "PLATFORM_DRIVER_EXIT=$?"
grep -E "PLATFORM_LANE_EXIT|[0-9]+ (passed|failed|skipped|flaky)|did not run" "$GATE/platform-lane.log" | tail -8

echo "########## AGENCY LANE ##########"
"$GATE/05-run-agency.sh" > "$GATE/agency-lane.log" 2>&1
echo "AGENCY_DRIVER_EXIT=$?"
grep -E "AGENCY_LANE_EXIT|[0-9]+ (passed|failed|skipped|flaky)|did not run" "$GATE/agency-lane.log" | tail -8

echo "ALL_LANES_DONE"
