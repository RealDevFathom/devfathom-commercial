#!/bin/zsh
set -u
GATE=/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se/_gate-evidence/134f17fa/wha-1132
cd /Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se || exit 1
source "/Users/Saad/devfathom-gates/b59f39a8/browser/.runsecrets"
# PLAYWRIGHT_BASE_URL stays UNSET so the config starts its own server (WHA-1135).
unset RESTAURANT_INTEGRATED_E2E RESTAURANT_E2E_DATABASE_URL AGENCY_E2E AGENCY_E2E_DATABASE_URL PLAYWRIGHT_BASE_URL
export NODE_OPTIONS=--max-old-space-size=8192
export CI=1
export PLAYWRIGHT_PORT=4319
export DATABASE_URL="postgresql://gate_runtime@127.0.0.1:55593/platform_e2e_gate"
export PLAYWRIGHT_DATABASE_ADMIN_URL="postgresql://gate_owner@127.0.0.1:55593/platform_e2e_gate?options=-c%20app.is_platform_admin%3Dtrue"
export PLAYWRIGHT_PLATFORM_ADMIN_EMAIL="$PLATFORM_ADMIN_EMAIL"
export PLAYWRIGHT_PLATFORM_ADMIN_PASSWORD="$PLATFORM_ADMIN_PASSWORD"
export PLAYWRIGHT_JSON_OUTPUT_NAME="$GATE/platform-results.json"
export AUTH_TRUST_HOST=true
bunx playwright test --config tests/e2e/platform-control-plane.config.ts --reporter=list,json
echo "PLATFORM_LANE_EXIT=$?"
