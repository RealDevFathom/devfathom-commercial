# Restaurant customer gap follow-up — 2026-10-22

## Verification and issue de-duplication

The three highest-impact findings in `docs/rgap-restaurant-customers-20261022.md` were rechecked
against the branch before editing:

1. **Create/correct UI — confirmed.** The router and domain helper already exposed tenant-scoped,
   `customers:manage`-protected mutations, but the loyalty console had no controls that invoked them.
2. **Registry over-fetch — confirmed.** The list projection returned birth date, notes, normalized
   identifiers, and interactions although the registry rendered only the identifier count and tags.
3. **Pagination/unbounded detail — confirmed.** The list returned `nextCursor`, but the console did
   not consume it; detail relations and loyalty-point rows were not bounded.

No finding was already fixed, so none was skipped. I also searched the repository-visible issue and
document trail for matching customer/loyalty defects. A live open-GitHub-issue exclusion could not
be performed because this checkout has no configured Git remote and `gh auth status` reports no
GitHub authentication. Consequently, no finding was skipped as covered by a known open issue; this
is the same external limitation recorded by the source report.

## Changes

- Added a page-header **New customer** action and selected-record **Correct** action, with an
  accessible shared dialog for profile, identifier, birth-date, and notes entry. Successful commands
  refresh customer queries and select a newly created profile
  (`src/components/restaurant/loyalty/loyalty-console.tsx:264-278,366-394,445-460,1175-1294`).
- Kept authorization centralized: the UI calls the existing `create` and `correct` tRPC mutations,
  which remain guarded by the router's `customers:manage` capability procedure; no ABAC code was
  changed (`src/server/routers/restaurant-customers.ts:128-157`).
- Reduced the registry projection to display-safe profile labels, timestamps, anonymization state,
  identifier count, and tags. Raw identifiers, birth date, notes, and interaction history now remain
  detail-only (`src/lib/restaurant/customers.ts:174-218`).
- Added previous/next cursor controls, page state, and cursor reset when search/tag filters change,
  so the registry consumes the server's existing `nextCursor`
  (`src/components/restaurant/loyalty/loyalty-console.tsx:183-201,583-705`).
- Bounded detail interaction, order, and consent relation reads to 100 recent records. Replaced the
  unbounded loyalty-entry materialization used to calculate balance with a database aggregate
  (`src/lib/restaurant/customers.ts:94-170,331-341`). The separately paginated loyalty ledger remains the operator
  route for older points entries.
- Added behavioral component coverage for create/correct submissions, cursor navigation, and the
  absence of contact PII in registry rows; updated helper coverage to assert the minimized list
  contract (`src/components/restaurant/loyalty/loyalty-console.test.tsx`,
  `src/lib/restaurant/customers.test.ts:290-304`).

No migration was required. No changes were made to `src/lib/abac/index.ts`, WhatsApp delivery,
pharmacy capabilities, money handling, or logging.
