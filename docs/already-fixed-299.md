> **25 October 2026 regression-contract correction:** Independent QA of prior head `46ec8fec5286060c53439334a3663a821ff358b8` found **135 PASS / 3 FAIL / 0 SKIP** (unit129/131, PostgreSQL6/7). Those failures incorrectly treated CREDIT as non-Khata. Main intentionally routes CREDIT and KHATA through dispense plus family-account authorization. The new regression matrix separately covers CASH/CARD/BANK_TRANSFER/WALLET, denies counter-only account tenders, and requires the account for a dispense-authorized caller, with no tender/Khata writes on refusal. Production authorization is unchanged. This is a new-head correction, **not a PASS**; independent verification must use a fresh throwaway DB. The prior head is consumed and must not be replayed. The new workflow remains fully preserved/parked; existing gates are unchanged and dedicated app/DB CI is still absent.

> **25 October 2026 reconciliation:** Historical branch notes below are not current acceptance evidence. PR #641 now preserves current-main authorization: canonical `pharmacy:counter` is required for non-Khata tender; dispense-only access is not a counter-mutation grant. The Cashier template regression now imports the actual template. On 25 October 2026 the manager approved parking the new exact-head workflow separately because CLI workflow authorization is unavailable; the runner and regressions remain, existing gates are unchanged, and no application/DB CI PASS or independent acceptance is claimed. No prior static/other-head PASS is inherited.

# GitHub issue #299: already fixed

Issue #299 reported that the Pharmacy Cashier template grants `pharmacy:counter`, while the
counter receipt authorization gate accepted only the legacy `pharmacy.counter` spelling. The
current code already fixes that mismatch:

- The Cashier system-role template grants `pharmacy:counter`
  (`src/lib/vertical-catalog.ts:792-795`).
- The receipt gate makes one central `can()` decision for the canonical `pharmacy:counter` action
  (`src/server/routers/pharmacy-sales.ts:317-319`). Legacy dotted grants are converted by the
  canonical-capability migration rather than treated as a second runtime action
  (`prisma/migrations/20261021110000_canonical_pharmacy_capabilities/migration.sql:32-35`).
- Central authorization combines matching override and role rules before deciding, so a matching
  `DENY` cannot be bypassed by an `ALLOW` from the other source (`src/lib/abac/index.ts:48-56`).
- A focused regression test gives an assigned cashier the canonical `pharmacy:counter` grant and
  verifies receipt, cart, return-history, cash-tender, and card-tender access
  (`src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts:296-327`). Focused tests also
  reject runtime dotted aliases and conflicting allow/deny rules.

The fix is present in commit `2ee391bd31b90fbead408843f8c26f24892f6143` (`fix(pharmacy): let
canonical cashiers read and settle counter bills`). This follow-up hardens the already-fixed gate
without adding a migration or changing the exact-grant-only treatment of regulated pharmacy
actions.
