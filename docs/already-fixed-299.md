# GitHub issue #299: already fixed

Issue #299 reported that the Pharmacy Cashier template grants `pharmacy:counter`, while the
counter receipt authorization gate accepted only the legacy `pharmacy.counter` spelling. The
current code already fixes that mismatch:

- The Cashier system-role template grants `pharmacy:counter`
  (`src/lib/vertical-catalog.ts:792-795`).
- `RECEIPT_READ_CAPABILITIES` accepts both the canonical `pharmacy:counter` grant and the legacy
  `pharmacy.counter` grant (`src/server/routers/pharmacy-sales.ts:275-283`).
- The gate evaluates those accepted actions against active permission overrides and role grants,
  preserving override `DENY` precedence before accepting an `ALLOW`
  (`src/server/routers/pharmacy-sales.ts:350-357`).
- A focused regression test gives an assigned cashier the canonical `pharmacy:counter` grant and
  verifies receipt, cart, return-history, cash-tender, and card-tender access
  (`src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts:305-336`). The adjacent test
  retains coverage for the legacy dotted grant
  (`src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts:275-303`).

The fix is present in commit `2ee391bd31b90fbead408843f8c26f24892f6143` (`fix(pharmacy): let
canonical cashiers read and settle counter bills`). No code, migration, or additional test was
added for #299 because that would duplicate the existing fix and focused regression coverage.
