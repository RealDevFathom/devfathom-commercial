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
