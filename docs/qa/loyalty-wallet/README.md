# Pharmacy loyalty wallet integration verification

This branch merges `origin/develop` at `19ac9c77` and the solo-owner/demo operating-mode branch. Both explicit SOLO mode and singleton-owner eligibility are required for self-approval; fresh PIN verification, transaction-bound audits, branch restrictions and independent STAFFED approval remain enforced.

## Delivered behavior

- Points are disabled until configured. Earning occurs only after a completed sale, with current purpose-specific consent checked under the customer/patient lock. Loyalty-funded money does not earn more points.
- Settings use integer paisa and whole points. Each earn/redemption records its original rate; later settings changes or opt-out do not alter refund economics.
- Redemption cannot exceed the available balance or unpaid bill amount and must meet the configured minimum. Refunds restore redeemed points and reverse earned points cumulatively. Voiding an open bill refunds its original points tender, preventing a second restoration.
- The customer ledger includes signed history and receipt references. Receipts show redeemed and remaining points. Owner/admin corrections require a reason, preserve idempotency, reject overdrafts and show confirmation before removal.
- Policy mutations require owner/admin identity and central loyalty permission, including DENY precedence. Policy audits are append-only. Tenant/branch predicates and live branch assignments apply to counter writes.
- Both pharmacy demo modes have four consenting customers, enabled loyalty and real completed-sale history. Legacy demo upgrades add starter sales instead of changing issued receipts; repeated seeding does not duplicate points.

## Database verification

The supplied shared database contained a failed owner-identity stamp and former pre-release approval triggers. It was backed up and restored to an isolated database for reconciliation and the main test run. The shared database migration history was not rewritten.

All 188 migrations were also deployed from scratch to a private, socket-only PostgreSQL 16 cluster, using the repository's extension-preparation preflight. The existing wallet bridge/reporting suites run there as a non-owner, NOSUPERUSER/NOBYPASSRLS role with the private disposable-identity sentinel. No triggers or RLS policies were disabled. Their 80 tests pass, including the 5,000-journal range-limit case at its original 60-second timeout.

The new points lifecycle PostgreSQL tests execute real sale, tender, receipt, consent, refund and void services under a restricted role. The solo approval/owner/operating-mode suites passed 47 tests; the branch security suite passed 13. Demo seeding is checked for persisted balances, history and replay safety.

## Studio visual QA

Reused the tenant shell, `PageHeader`, `SectionCard`, `Button`, `Input`, `Stat`, existing typography and semantic surface/text/border/focus/state tokens. No palette, font, shell or theme system was added.

`visual-matrix.json` records 48 loaded-screen checks: history, settings and counter at 375/768/1024/1440 pixels, light/dark themes, normal/reduced motion. All have one H1 and no document horizontal overflow. Screenshots include populated history, the ledger, settings, counter and visible consent controls. `interactions.json` records successful policy disable/enable, customer opt out/in, Escape behavior and keyboard focus; the focused form control measures 44 pixels. No client errors were recorded.

Loading, empty, permission-denied, error and disabled states are covered by page/component regressions. Negative corrections require an explicit second confirmation; Escape cancels. No Azure files were edited and no external provider or messaging action was invoked.

## Validation commands

- `npm run typecheck`
- `npm run lint`
- `vitest run --maxWorkers=6 --testTimeout=30000 --hookTimeout=120000` (complete suite; dedicated restricted restaurant-growth URL)
- Explicitly enabled `stored-value-finance.db.test.ts` and `wallet-reporting.db.test.ts` on the fresh private target
- `npm run build` with an ephemeral local build auth secret

The shared runner required longer general test allowances; assertions and the reporting range-limit test were retained. Optional acceptance suites retain their pre-existing environment gates.

## Review resolution after interrupted-session recovery

The review baseline was `879a4e685070ef54c41e3f170b29f6c22548b4f3`.

- ES2017 is unchanged. Wallet arithmetic uses `BigInt()` calls, DB fixtures include the new required fields, and both fs mocks provide named and default exports. The merged shell test passes children as the third `createElement` argument.
- OTC counter/receipt access is independent of dispensing denial. Sale creation and line addition require current counter permission plus live branch assignment. Router regressions cover role/override dispensing denials, Rx refusal, counter denials including the dotted alias, no assignment, another branch, dispense-only identities, and singleton-owner access.
- Purge discovery restricts `pg_class.relkind` to ordinary/partitioned tables and binds the target tenant for wallet/loyalty RLS. The shipped wallet migration is unchanged. A new migration admits only the platform worker's exact-tenant purge through the new policy-audit guard. PostgreSQL regressions prove the wallet view exists, purge succeeds with policy history present, another tenant's history remains, and tenants cannot delete or rewrite policy audits.
- The staging grants-only subprocess receives the configured pharmacy admin email.

Recovery validation used a newly created private socket database, migrated from scratch, with a separate NOSUPERUSER/NOBYPASSRLS runtime role and disposable-identity sentinel. The policy-audit retention migration was then deployed normally. Wallet bridge/reporting: **80 passed**, including the original 60-second large-history cap test. Changed points/operating-mode/branch/report/demo/owner DB suites plus solo approvals: **70 passed**. Purge and worker composition: **18 passed**. Rx sale gate and persisted receipt authorization: **7 passed**; prescription-reference authorization: **17 passed**. The return/refund lane used a second freshly migrated isolated database on its required disposable port: **2 passed**.

Changed Vitest files plus shell, branch-scope and worker composition checks: **31 files / 848 tests passed**. `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck` and `npm run lint` passed. A final ESLint pass also covers changed scripts and test files outside `src/`. Initial shared-host worker-start and reporting timeouts were rerun successfully without weakening assertions or increasing the reporting test's timeout. AGENTS.md and Azure files were not changed.
