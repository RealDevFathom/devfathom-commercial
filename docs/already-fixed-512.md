# GitHub issue #512 was already fixed

Issue #512 reports that `catalog.package.upsert` could change an existing package's vertical
without checking its module links or assigned organizations. The current branch already rejects
both invalid states, so no production or test code was changed for this issue.

## Code evidence

- `src/lib/platform/commands.ts:3408-3417` loads the existing package whenever an update supplies
  a vertical, selecting its current vertical, linked modules' verticals, and assigned
  organizations' verticals. It also rejects an update for a missing package before attempting the
  write.
- `src/lib/platform/commands.ts:3419-3429` rejects a genuine vertical change when any vertical-bound
  module link belongs to a different vertical. Modules with no vertical remain compatible.
- `src/lib/platform/commands.ts:3430-3440` rejects a genuine vertical change when any assigned
  organization does not match the requested vertical.
- `src/lib/platform/commands.ts:3442-3447` performs the package update only after those checks have
  passed.
- `src/lib/platform/commands.ts:3459-3479` independently preserves the invariant in the other
  direction by rejecting a newly written module link whose vertical differs from the package.

## Regression evidence

- `src/lib/platform/commands.vertical.test.ts:879-899` covers rejection of a vertical change that
  would strand an incompatible module link and verifies that the update is not called.
- `src/lib/platform/commands.vertical.test.ts:901-921` covers rejection of a vertical change that
  would strand an assigned organization and verifies that the update is not called.
- `src/lib/platform/commands.vertical.test.ts:923-944` confirms that a vertical change remains
  allowed when all linked modules and assigned organizations are compatible with the target
  vertical.

The fix and its focused regression coverage are present in commit
`021880c60ed067ad02b63226eefe0a2797640f42` (`fix(#512)`).
