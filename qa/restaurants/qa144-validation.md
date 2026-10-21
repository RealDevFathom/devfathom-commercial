# QA #144 validation — 2026-10-21

Branch: `fix/qa-144-audit-tx-timeouts`. No UI changes.

## Regression evidence

Real PostgreSQL 17, fully migrated disposable `qa144_test` database; application
queries use a NOSUPERUSER/NOBYPASSRLS role. Owner access is limited to fixture
setup and cleanup. FORCE RLS remains enabled; cross-tenant branch reads return
no rows. The fixture creates unique device secrets and deletes its tenant data.
Two consecutive runs passed (5 tests each), including cleanup.

A committed actor locked FOR UPDATE reproduces the original independent audit
foreign-key wait (`55P03` with a 100 ms lock timeout). Deferred audit persistence
runs after commit and produces a durable, session-tenant audit row. A failed
action rolls back its update while retaining its independent failure audit.
An audit foreign-key failure leaves the successful action committed. Test mode
exposes that failure through the explicit flush hook.

## Report measurements

One closed day, one branch, 1,201 closed drawer sessions. Sequential backend read
measurements in milliseconds; most other report sources are empty. These numbers
are regression fixture timings, not production-scale or HTTP latency claims.

| Read | Milliseconds |
| --- | ---: |
| payments | 47.27 |
| readOverviewReport | 8.27 |
| readInventoryReport | 12.23 |
| readWastageReport | 10.63 |
| readCateringReport | 6.51 |
| readSopReport | 4.65 |
| readFoodCostReport | 11.88 |
| readDishProfitabilityReport | 3.36 |
| readStockMovementReport | 4.54 |
| readPurchasingReport | 9.86 |
| workforceFinancial | 5.95 |
| batch | 125.32 |

Payments retains all 1,201 drawer sessions in its coverage count while fetching
pages of 500. The batch assertion is below 5 seconds. Other report sources were
reviewed: detail reads already have limits, summary queries aggregate in SQL,
and the shared close/rollup backbone is scoped to the maximum 90-day range.
Historical close revisions remain fully included for authoritative-close selection.

## Route behavior and limits

The existing reports-page and reports-router suites passed, exercising page read
orchestration, error handling, authorization and branch scoping with mocks. The
real database suite executes the underlying affected read models and transaction
lifecycle. The original authenticated tenant HTTP sweep was not replayed: this
worktree has no configured tenant session/dev server. The original 17.7-minute
HTTP request and 13.4 GB process growth are not claimed as reproduced locally.

## Checks

- Focused audit/outbox/report/financial comparison suites: 74 passed, 4 files.
- Reports page/router and tenant DB suites: 62 passed, 1 existing environment-gated DB test skipped, 4 files passed.
- Real PostgreSQL regression: 5 passed, twice; no skipped DB regressions.
- ESLint on all changed TypeScript files: passed.
- `NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck`: passed, no retry needed.
- `git diff --check`: passed.
