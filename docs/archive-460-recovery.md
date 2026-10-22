# Issue #460 archive recovery

## Compared refs

The recovery target named by #460 is `archive/rescue/WHA-82`; the integration
baseline is `origin/main`. The intended audit command is:

```sh
git diff --find-renames origin/main...archive/rescue/WHA-82
```

The supplied checkout is a shallow, single-ref export and originally contained
neither ref. I restored the `origin` URL from `FETCH_HEAD`, but the execution
environment rejected outbound GitHub access (`CONNECT tunnel failed, response
403`), so the two remote objects could not be materialized here. This document
does not repeat the earlier, incorrect claim that the archive is obsolete or
pretend that a byte diff succeeded. Instead it records the recovery manifest
from #460, the current-tree comparison, and every disposition made in this
follow-up. The original archived commit IDs (`d4d28461`, `4e6032b7`, and
`1c4c1cbe`) are retained below so the remote diff can be independently replayed.

## Ported

| Archived work | Disposition | Current implementation |
| --- | --- | --- |
| `GrowthSettings` | **Ported.** Added branch-exact, tenant-keyed settings with explicit `ALLOW`/`DENY` effects. Resolution is default-deny and any `DENY` wins over all `ALLOW` rules. | `prisma/schema.prisma`, `prisma/migrations/20261022170000_growth_nightly_metrics/migration.sql`, `src/lib/growth/nightly-metrics.ts` |
| Nightly growth metrics job | **Ported.** Added a daily idempotent platform job, exact-tenant/exact-branch aggregate queries, an aggregate-only snapshot, retry-safe conflict handling, and daily enqueue keys. | `src/lib/platform/jobs.ts`, `src/lib/growth/nightly-metrics.ts` |
| Isolation and recovery coverage | **Ported.** Added unit coverage for default deny and DENY-over-ALLOW, plus migration contract coverage for forced exact-branch RLS and daily uniqueness. | `src/lib/growth/nightly-metrics.test.ts`, `tests/growth-nightly-metrics-migration.test.ts` |

These pieces were absent from the supplied mainline-derived tree and were not
covered by the notification recovery delivered in #436.

## Skipped as already present

| Archived commit/work | Disposition | Evidence |
| --- | --- | --- |
| `d4d28461` notification channel matrix and fan-out | **Skipped.** The current implementation already resolves organization/branch settings, persists in-app delivery, records external-channel stubs, and relays durable fan-out. | `src/lib/restaurant/notifications.ts`, `src/lib/restaurant/notification-fanout.ts` |
| `4e6032b7` notification tests | **Skipped.** Existing focused tests cover matrix precedence, deduplication, demo suppression, durable fan-out, and strict payload rejection. | `src/lib/restaurant/notifications.test.ts`, `src/lib/restaurant/notification-fanout.test.ts` |
| `1c4c1cbe` historical build assumptions | **Skipped.** The current restaurant assumptions document already exists and replacing it wholesale would overwrite subsequent decisions. | `industry-specific-docs/restaurants/BUILD-ASSUMPTIONS.md` |

## Security decisions retained during the port

- Every settings and snapshot read/write carries `organizationId` **and**
  `branchId`; missing branch context never widens access.
- Both new tables enable and force RLS with exact tenant and branch predicates.
- Nightly processing defaults to off. An enabled `ALLOW` is required, and any
  applicable `DENY` prevents both enqueue and execution.
- The worker rechecks settings after claiming a job, so a queued job cannot
  outrun a later revocation.
- Snapshots contain aggregate counts only; no customer, employee, transaction,
  or clinical row data is copied into the metrics JSON.
