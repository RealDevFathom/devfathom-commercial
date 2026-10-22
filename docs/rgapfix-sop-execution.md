# Restaurant SOP execution gap fixes — 2026-10-22

## Verification and issue cross-check

The three highest-ranked **High/Medium** findings in
`rgap-restaurant-sop-execution-20261022.md` were verified against the current branch before
changing code. All three were still present:

1. **Branch-scoped operators could read the organization-wide board and evidence history.** The
   list resolver trusted `branchId`, the detail resolver trusted the occurrence ID, and the page
   loaded every active organization branch.
2. **Role-pool work could not be claimed from the shipped workspace.** The older authoring router
   exposed caller-selected staff IDs, while the execution page had no claim command or control.
3. **Incomplete checklists and missing required notes could be submitted.** Step completion did not
   enforce `requiresNote`, and submission did not inspect the pinned occurrence steps or proof.

No finding was skipped as already fixed. No finding was skipped because of an open issue. This
checkout has no configured Git remote, and `gh auth status` reports no authenticated GitHub host, so
the private GitHub issue list could not be queried. A local reference search across `status.md`,
`ENHANCEMENTS.md`, `IMPROVEMENTS.md`, `FIXES.md`, `BUGS.md`, `claude/`, `scripts/`, and `docs/` found
no open-issue reference covering these findings.

## Changes

### Branch and occurrence visibility

- Added a shared execution-scope resolver that requires active tenant branch scope, derives the
  authenticated user's active staff profile and branch roles, and recognizes explicit
  `restaurant:configure`/`sop:verify` oversight (`src/server/routers/restaurant-sop-execution.ts:152`).
- Restricted ordinary board queries to direct assignments, the caller's claims, and unclaimed pools
  for roles held by that caller (`src/server/routers/restaurant-sop-execution.ts:182`,
  `src/server/routers/restaurant-sop-execution.ts:317`).
- Applied the same branch and occurrence visibility rule before returning detail, including evidence,
  verification, and escalation history (`src/server/routers/restaurant-sop-execution.ts:382`).
- Restricted the page's branch selector to branches linked to the current web user unless the user
  has explicit organization-wide configuration access (`src/app/(app)/restaurant/sop/page.tsx:1155`).
- Added behavioral router coverage for out-of-scope branch denial and operator occurrence projection
  (`src/server/routers/restaurant-sop-execution.test.ts:213`).

### Session-bound role-pool claiming

- Added an execution-router claim mutation with no staff-ID input. It derives the active staff
  profile from the authenticated session, checks branch scope and claimable state, delegates to the
  existing atomic claim primitive, and audits a winning claim
  (`src/server/routers/restaurant-sop-execution.ts:488`).
- Projected ownership state to the board and added a Claim SOP action with a friendly lost-race result;
  unclaimed pool work must be claimed before Start is offered
  (`src/app/(app)/restaurant/sop/page.tsx:605`,
  `src/app/(app)/restaurant/sop/page.tsx:1054`,
  `src/app/(app)/restaurant/sop/page.tsx:1225`).
- Added behavioral coverage proving the claim uses the authenticated active staff profile and the
  atomic conditional update (`src/server/routers/restaurant-sop-execution.test.ts:247`).

### Checklist integrity

- Enforced non-blank completion notes for steps whose pinned template requires a note
  (`src/lib/restaurant/sop-execution.ts:168`, `src/lib/restaurant/sop-execution.ts:212`).
- Made submission atomically reload every occurrence step and reject incomplete steps or missing
  required notes, photos, and signatures before changing occurrence status
  (`src/lib/restaurant/sop-execution.ts:369`, `src/lib/restaurant/sop-execution.ts:398`).
- Marked required note fields in the UI and withheld Submit until all displayed steps are complete
  (`src/app/(app)/restaurant/sop/page.tsx:388`, `src/app/(app)/restaurant/sop/page.tsx:764`).
- Added behavioral tests for blank required notes, incomplete checklists, and proof revalidation at
  submission (`src/lib/restaurant/sop-execution.test.ts:194`,
  `src/lib/restaurant/sop-execution.test.ts:606`).

## Validation constraints

The requested Vitest files were invoked, but Bun attempted to resolve `vitest` from npm and received
HTTP 403. This environment therefore could not execute the tests. The test changes are behavioral
mock-based assertions; they do not inspect source text.

The global TypeScript compiler was also invoked, but the checkout has no installed dependencies or
generated Prisma client, so it reported repository-wide missing-module/type errors. The development
server likewise could not start because `next` is not installed; consequently no browser screenshot
could be captured for the additive Claim SOP control.
