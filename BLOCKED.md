# BLOCKED — Restaurant QA #273 / #274 / #275

Branch: `fix/qa-271`. Pulled origin first; branch was up to date.

Stopped under the user's stop-after-two-failures rule. Two browser QA attempts
failed on the same ambiguous Playwright selector: `getByLabel('Bill line')`
matches both the dialog named "Comp a bill line" and the line select. The matrix
runner and separate mobile screenshot attempt both hit this selector error.
This is a browser harness failure, not evidence of a product failure. Mandatory
visual QA is incomplete. No fix was attempted after the second failure. The
read-only security candidate review was interrupted and has no completed verdict.

Implemented:

- #273 removes a voided line and its service from an open untendered bill inside
  the order transaction, preserving remaining pinned allocations. Paid,
  fractional, frozen-tax, or over-discounted changes are blocked pending reversal
  or re-cut. Void command errors now escape the transaction before HTTP mapping.
- #274 shows summed non-VOID bill service, including zero, on the order ticket;
  unbilled orders retain the draft quote.
- #275 gates comp on `orders:complimentary`, preserves deny precedence and manager
  approval, uses that catalogued capability for audit, and adds a compact stationary
  register control. Its open-line read is capability-gated and branch-scoped, so
  comp-only operators need no payment capability. Existing authenticated tenant
  context and scoped DB remain authoritative; no schema or RLS changes.

Checks:

- PASS: `TMPDIR=/tmp NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck`
  after correcting test-only types.
- PASS: `TMPDIR=/tmp TZ=UTC bun run test` with exactly these focused files:
  `src/lib/restaurant/bills.comp-audit.test.ts`,
  `src/lib/restaurant/bills.void.test.ts`,
  `src/lib/restaurant/terminal-orders.totals.test.ts`,
  `src/app/api/restaurant/checkout/comp/route.test.ts`,
  `src/components/restaurant/pos/comp-panel.test.tsx`,
  `src/lib/restaurant/checkout-coauth-job-roles.test.ts`,
  `src/components/restaurant/pos/use-pos-runtime.test.tsx`,
  `src/lib/restaurant/checkout-routes.test.ts`: 8 files, 56 tests passed.
- Targeted ESLint: zero errors, one unused `_args` warning in
  `bills.comp-audit.test.ts`.
- INCOMPLETE: browser viewport/theme/motion/keyboard/layout/state matrix due to
  the repeated selector failure. No live authenticated end-to-end or PostgreSQL
  validation completed. Build/full suite intentionally omitted per box limits.

Temporary browser harness files were removed before committing.
