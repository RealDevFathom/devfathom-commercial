# Issue #475 is already fixed on the current branch

## Verification basis

The issue reports regressions on PR #468 at `933a1c75`, relative to main at
`16a2a370`. The current checkout resolves to `16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca`,
the exact main revision that QA says has no newly failing tests. Consequently, porting
changes from the regressed PR head would introduce rather than fix the reported problem.

Per the issue instruction for an already-fixed checkout, no product or test code was
changed. The following current-code evidence also confirms that the reported PR-head
changes are absent and the main behavior remains intact.

## File-and-line evidence

- `src/lib/pharmacy/reports.ts:250-264` performs report date arithmetic with `number`
  millisecond values and contains no below-ES2020 `BigInt` literals at the reported
  locations. `src/lib/pharmacy/reports.ts:267-273` likewise models the returned money
  counts as numbers.
- `src/server/routers/pharmacy-sales.ts:199-208` still recognizes
  `CONSENT_REQUIRED` and maps it, together with `SALE_NOT_LINKED`, to `FORBIDDEN`.
- `tests/finance-insights-ai-independence.test.ts:599-619` asserts that Pharmacy
  Reports & Insights remains visible when its own module is licensed, independently
  of Finance and Ask Fathom.
- `src/lib/restaurant/tenders-posting.test.ts:151-165` supplies the
  `restaurantOrder.findFirst` dependency used by the current tender implementation;
  the fixture is not missing a newly introduced `findUnique` method.
- `src/components/pharmacy/counter/counter-receipt-view.tsx:248-257` guards the
  receipt's `scrollIntoView` call with optional chaining, preserving DOM-test
  compatibility.
- `src/lib/platform/commands.demo-bootstrap.test.ts:429-457` exercises the existing
  demo bootstrap contract with `ordinary-password` and verifies that it is hashed.
- `src/lib/restaurant/staff.test.ts:140-184` contains the focused
  `updateStaffProfile` coverage that passes on the comparison revision.
- `src/lib/hotel/foundation.test.ts:23-27` retains the comparison revision's expected
  Restaurant and Pharmacy catalogue digests rather than the PR-head template hashes.

## Checks performed

Only static inspection was performed, as requested for this environment:

```text
git rev-parse HEAD
git status --short --branch
git show-ref
rg / sed / nl inspection of the files cited above
```

Dependencies were not installed, and typecheck/tests were not run (Bun 1.2.14, no
database, and npm access returns 403).
