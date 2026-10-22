# Restaurant catering gap follow-up — 2026-10-22

## Verification and issue check

The three highest-ranked **High/Medium** findings in
`docs/rgap-restaurant-catering-20261022.md` were verified against the current branch before changes:

1. **Cancellation guidance (High): confirmed.** The transition code did not restock on cancellation,
   while the administrator guide still promised an automatic reversal. The explicit-disposition
   contract and UI already agreed with the implementation.
2. **Unfiltered multi-branch ledger (High): confirmed.** The list loaded organization-wide orders
   and then rejected the complete result when any returned branch was unauthorized.
3. **Line editing (Medium): confirmed.** The `updateLine` endpoint existed, but the console exposed
   only add and remove actions.

None was already fixed in the checked-out code. No matching local open issue was found in `BUGS.md`,
`TICKETS.md`, or repository documentation. A live GitHub issue check could not be completed: this
checkout has no configured remote, `gh` is unauthenticated, and the GitHub API request for the
repository identified in existing documentation was rejected by the environment proxy with HTTP 403. No finding was skipped as already fixed or covered by a verifiable open issue.

## Changes

- Corrected the administrator guide to say cancellation never restocks automatically and to direct
  operators through explicit disposition; only `UNUSED_RETURN` restores the returned quantity
  (`docs/product/restaurant-administrator-guide.md:328-335`).
- Scoped an unfiltered catering ledger query to the authenticated actor's primary and assigned
  branches, while retaining organization-wide visibility for actors with
  `restaurant:configure`; explicit unauthorized-branch requests still fail in the existing
  procedure middleware (`src/server/routers/restaurant-catering.ts:329-376`).
- Added an in-place order-line editor that preserves line identity and sends product/recipe,
  description, portions, and exact decimal-string unit price to the existing `updateLine` mutation
  (`src/components/restaurant/catering/catering-console.tsx:317-323`,
  `src/components/restaurant/catering/catering-console.tsx:466-482`, and
  `src/components/restaurant/catering/catering-console.tsx:1245-1358`).
- Added behavioral coverage for branch-scoped unfiltered ledgers and editing a line without calling
  remove (`src/server/routers/restaurant-catering.test.ts:271-287` and
  `src/components/restaurant/catering/catering-console.test.tsx:569-594`).

No migration was required.
