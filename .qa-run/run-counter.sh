#!/bin/bash
set -euo pipefail
cd /Users/Saad/Developer/paperclip-worktrees/devfathom/ph-qa-specs
export DATABASE_URL=postgresql://qa_runtime@127.0.0.1:55689/pharmacy_counter_e2e
export TEST_DATABASE_URL="$DATABASE_URL" PHARMACY_E2E_DATABASE_URL="$DATABASE_URL" PHARMACY_E2E=1
export PHARMACY_E2E_ADMIN_EMAIL=qa-counter@example.test PHARMACY_E2E_ADMIN_PASSWORD=CounterDisposable2026
export AUTH_SECRET=disposable-pharmacy-qa-1589-local-only AUTH_TRUST_HOST=true
export PLAYWRIGHT_HTML_OPEN=never PLAYWRIGHT_HTML_OUTPUT_DIR=.qa-run/evidence/counter-html
bun run test:e2e:pharmacy-counter --reporter=html,line
