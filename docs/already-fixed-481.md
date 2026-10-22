# GitHub issue #481 is already fixed

Issue #481 reported that pharmacy offline replay omitted recall state from signed snapshots and
authorized replay with hard-coded, fail-open safety values. The current code already addresses
both paths:

- `src/server/routers/pharmacy-offline.ts:229-247` validates each signed snapshot with the
  snapshot's `recalledBatchIds`, rather than an empty list.
- `src/server/routers/pharmacy-offline.ts:260-292` loads every requested lot within the current
  organization and branch, treats missing or non-active lots as unsafe, checks signed snapshot
  recalls, and supplies those results to replay authorization. It also derives `safetyLeaseOk`
  from the presence of snapshots rather than hard-coding it to `true`.
- `src/server/routers/pharmacy-offline.ts:603-622` collects recalled batches for the device's
  tenant, branch, and quota lots and embeds those identifiers and a current recall version in the
  safety lease used for issued snapshots.
- `src/lib/pharmacy/offline-snapshots.ts:163-181` likewise derives a default safety lease from
  tenant-scoped recalled batches and branch-scoped lots instead of defaulting recall state to
  version zero with no recalled identifiers.
- `src/server/routers/pharmacy-offline.db.test.ts:483-504` covers a recall raised after snapshot
  issuance, confirms refreshed snapshots carry the recalled lot, and confirms replay is denied
  without recording a command.

These fixes are present in commit `f44d47c279b2369723e6874e91d77ca619a96ed6` (`fix(#481)`).
