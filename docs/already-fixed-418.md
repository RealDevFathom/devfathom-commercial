# GitHub issue #418: already fixed

Issue #418 is already fixed on the current branch by commit
`309b28fc9f6460333e761ce78dc17d0f3bf9b356` (`fix(#418): attempt 2 — reject
empty/cross-org ids (cumulative)`). No production code changes are needed.

## Current-code evidence

- `src/app/api/v1/transactions/[id]/route.ts:25-26` rejects empty `projectId`
  and `clientId` values during request validation while retaining `null` as the
  explicit detach operation.
- `src/app/api/v1/transactions/[id]/route.ts:30-32` requires the
  `finance:write` scope and receives the authenticated API context.
- `src/app/api/v1/transactions/[id]/route.ts:50-70` looks up every non-null,
  supplied project and client through `authCtx.db` and returns HTTP 400 before
  the transaction update when either reference is not visible.
- `src/app/api/v1/transactions/[id]/route.ts:72-75` performs the update only
  after those checks succeed.
- `src/lib/api-auth.ts:112-121` constructs `authCtx.db` with
  `createTenantDb(candidate.organizationId)`, so the reference lookups are
  restricted to the API token's organization.
- `src/app/api/v1/transactions/[id]/route.test.ts:32-103` contains focused
  regression coverage proving foreign project/client references do not call
  `transaction.update`, invalid empty IDs are rejected, `null` detaches remain
  supported, and visible references can be updated.

Because this is not an archive-recovery issue, there is no archive branch diff
or skipped-fix inventory to report.
