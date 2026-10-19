#!/bin/zsh
set -u
GATE=/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se/_gate-evidence/134f17fa/wha-1132
cd /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se
source "/Users/Saad/devfathom-gates/b59f39a8/browser/.runsecrets"
unset PLAYWRIGHT_BASE_URL DATABASE_URL TEST_DATABASE_URL RESTAURANT_INTEGRATED_E2E RESTAURANT_E2E_DATABASE_URL PLAYWRIGHT_PORT PLAYWRIGHT_DATABASE_ADMIN_URL
export NODE_OPTIONS=--max-old-space-size=8192
export CI=1
export AGENCY_E2E=1
export AGENCY_E2E_DATABASE_URL="postgresql://gate_runtime@127.0.0.1:55593/agency_e2e_gate"
export AGENCY_E2E_ADMIN_EMAIL='agency-admin@agency-e2e.test'
export AGENCY_E2E_ADMIN_PASSWORD="$AGENCY_ADMIN_PASSWORD"
export PLAYWRIGHT_JSON_OUTPUT_NAME="$GATE/agency-results.json"
bunx tsx scripts/run-agency-e2e.ts --reporter=list,json
echo "AGENCY_LANE_EXIT=$?"
