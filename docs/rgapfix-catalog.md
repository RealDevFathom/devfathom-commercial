# Restaurant Catalog gap follow-up

Date: 2026-10-22  
Branch: `fix/followup-rgap-catalog`

## Verification and issue de-duplication

The three highest-ranked **High/Medium** findings (findings 2–4 in the supplied report) were
verified against the current branch before implementation:

1. **High — combo composition:** confirmed. The router already exposed combo group/option CRUD,
   but the Catalog snapshot did not select the relations and the console had no read or authoring
   surface. No finding was skipped.
2. **High — recipe-line substitutes:** confirmed. The router mutations existed, but substitutes
   were absent from the snapshot and draft-line controls. No finding was skipped.
3. **Medium — recipe-cost failure detail:** confirmed. The router already returned the safe
   `RecipeCostingError` message through tRPC, while the console replaced it with a generic message.
   No finding was skipped.

Open-issue de-duplication could not be completed against GitHub: `gh auth status` reports no
authenticated account, and the unauthenticated GitHub API request to
`WhatTheStack1/devfathom-commercial` was rejected by the environment's CONNECT proxy with HTTP 403.
A repository documentation search found no local issue ledger entry that covers these findings.
Accordingly, none was skipped as already fixed or issue-covered based on the evidence available in
this checkout.

## Changes

- `src/app/(app)/restaurant/catalog/page.tsx:60-85` — load combo choice groups and ordered component
  options in the tenant-scoped Catalog snapshot; modifier ties now also have stable creation/ID
  ordering.
- `src/app/(app)/restaurant/catalog/page.tsx:150-163` — load ordered approved substitute IDs for
  each recipe line without weakening the existing tenant scope.
- `src/components/restaurant/catalog/catalog-console.tsx:335-352` — connect combo group/option CRUD
  to the existing capability-gated router mutations.
- `src/components/restaurant/catalog/catalog-console.tsx:408-413` — connect approved-substitute
  attach/remove controls to the existing capability-gated router mutations.
- `src/components/restaurant/catalog/catalog-console.tsx:1112-1267` — show COMBO cardinality,
  ordering, component product/variant, and decimal-string price deltas, with group and option CRUD.
- `src/components/restaurant/catalog/catalog-console.tsx:2083-2099` — preserve the safe server
  costing error, direct the operator to Ingredients and Units / Conversions, and retain an explicit
  recalculate action.
- `src/components/restaurant/catalog/catalog-console.tsx:2264-2362` — show, attach, and remove
  approved substitutes on ingredient-backed draft lines.
- `src/components/restaurant/catalog/catalog-console.test.tsx:1-260` — behavioral Vitest coverage
  for combo visibility/authoring, substitute attachment/removal, and actionable costing recovery.

No migration or authorization-policy change was required. All writes continue to pass through the
router's central `menu:write` capability procedure and existing tenant-reference validation.

## Review follow-up

- `src/lib/restaurant/menus.ts` — `createMenuItem` rejects COMBO products (`COMBO_NOT_ORDERABLE`,
  mapped to `BAD_REQUEST`). Ordering does not yet accept component selections, price combo
  deltas/cardinality, or consume component stock, so combos stay authoring-only until it does; the
  console states this on the combo panel.
- Combo component-option removal now uses the shared destructive confirmation dialog.
- The substitute empty state uses `text-text-muted` to meet the Studio 4.5:1 contrast contract.
