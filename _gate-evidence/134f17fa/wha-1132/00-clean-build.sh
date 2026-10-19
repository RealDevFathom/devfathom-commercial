#!/bin/zsh
set -u
GATE=/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se/_gate-evidence/134f17fa/wha-1132
WT=/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1210-gate-candidate-3d3d0c1b-browser-suite-only-wha-1132-contract-restaurant-15-platform-control-plane-7-agency-8-se
cd "$WT" || exit 1
source "/Users/Saad/devfathom-gates/b59f39a8/browser/.runsecrets"
unset RESTAURANT_INTEGRATED_E2E RESTAURANT_E2E_DATABASE_URL AGENCY_E2E AGENCY_E2E_DATABASE_URL PLAYWRIGHT_BASE_URL 2>/dev/null || true
export NODE_OPTIONS=--max-old-space-size=8192
export AUTH_TRUST_HOST=true
export DATABASE_URL="postgresql://gate_runtime@127.0.0.1:55593/platform_e2e_gate"
echo "=== HEAD ==="; git rev-parse HEAD
echo "=== rm -rf .next ==="
rm -rf .next
echo "=== next build ==="
START=$SECONDS
bunx next build
STATUS=$?
echo "NEXT_BUILD_EXIT=$STATUS"
echo "NEXT_BUILD_SECONDS=$((SECONDS-START))"
echo "=== BUILD_ID ==="; cat .next/BUILD_ID 2>/dev/null; echo
df -h / | tail -1
echo "CLEAN_BUILD_DONE"
