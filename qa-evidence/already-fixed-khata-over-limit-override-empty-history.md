# Already fixed: Khata over-limit override health history

## Verification

The issue reported against PR #259 at `0586961f` does not reproduce at main commit
`16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca`.

When an over-limit charge has an owner override, `authorizeKhataCharge` now queries
`pharmacyKhataEvent.findMany` and passes the returned account history directly to
`calculateKhataHealthSuggestion` (`src/lib/pharmacy/family-khata.ts:375-391`). The query is
scoped to the current organization, branch, and family account
(`src/lib/pharmacy/family-khata.ts:381-387`), rather than supplying an empty history.

The health calculation filters that supplied history to the 180-day window and derives its
charge, payment, overdue, payment-time, and dishonoured-cheque figures from those entries
(`src/lib/pharmacy/family-khata.ts:51-86`). It then places those derived figures in the returned
suggestion metrics (`src/lib/pharmacy/family-khata.ts:101-114`). `applyKhataLimitDecision` receives
that suggestion before recording the manager override (`src/lib/pharmacy/family-khata.ts:378-399`).

## Result

No production-code or test change is required: the affected path already builds the recorded
credit-health figures from the persisted, tenant- and account-scoped Khata event history.

Per the task constraint, tests were not run in the provided old environment.
