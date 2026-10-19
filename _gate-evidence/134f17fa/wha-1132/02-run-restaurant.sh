#!/bin/zsh
set -u
GATE=/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se/_gate-evidence/134f17fa/wha-1132
cd /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se
source "/Users/Saad/devfathom-gates/b59f39a8/browser/.runsecrets"
unset DATABASE_URL TEST_DATABASE_URL PLAYWRIGHT_BASE_URL CI PLAYWRIGHT_PORT AGENCY_E2E AGENCY_E2E_DATABASE_URL
export NODE_OPTIONS=--max-old-space-size=8192
export RESTAURANT_INTEGRATED_E2E=1
export RESTAURANT_E2E_RESTORATION_DB=1
export RESTAURANT_E2E_DATABASE_URL="postgresql://gate_runtime@127.0.0.1:55593/restaurant_e2e_gate"
export RESTAURANT_ACTOR_ADMIN_EMAIL='alex@company.com'
export RESTAURANT_ACTOR_ADMIN_PASSWORD="$SEED_PASSWORD"
export RESTAURANT_ACTOR_OPERATOR_EMAIL='operator@restaurant-e2e.test'
export PLAYWRIGHT_JSON_OUTPUT_NAME="$GATE/restaurant-results.json"
bunx tsx scripts/run-restaurant-e2e.ts --reporter=list,json
echo "RESTAURANT_LANE_EXIT=$?"
