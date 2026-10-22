# GitHub issue #453: archive/rescue/WHA-100 is already present

## Decision

Close the recovery issue as obsolete. No archive commit should be cherry-picked or
re-opened as a PR: the current tree already contains the final WHA-100 acceptance
battery and its focused governance and database-isolation contracts.

## Current-tree evidence

- `tests/restaurant-m8-acceptance.test.ts:1` identifies the suite as the isolated
  WHA-100 M8 API, reconciliation, and privacy acceptance battery.
- `tests/restaurant-m8-acceptance.test.ts:6-43` groups the customer/privacy,
  loyalty, insights, governance, and restricted-runtime RLS contracts.
- `tests/restaurant-m8-acceptance.test.ts:45-54` requires distinct migration-owner
  and restricted-runtime database connections rather than relying on an Auth.js
  application session.
- `tests/restaurant-m8-acceptance.test.ts:56-75` runs every focused contract with
  the restricted runtime URL and rejects both failed and silently skipped suites.
- `tests/restaurant-m8-governance.test.ts:372-405` pins the typed M8 actions to
  default deny.
- `tests/restaurant-m8-governance.test.ts:407-432` keeps schema and tenant-isolation
  verification explicit for all thirteen M8 tables.
- `tests/restaurant-m8-governance.test.ts:551-589` verifies forced RLS and the
  mutable-versus-append-only command contract.
- `tests/restaurant-m8-rls.test.ts:122-140` creates independent owner/runtime
  connections and configures their database contexts.
- `tests/restaurant-m8-rls.test.ts:397-477` proves the runtime role is non-superuser,
  cannot bypass RLS, and has only the intended policies.
- `tests/restaurant-m8-rls.test.ts:479-518` proves tenant A cannot see or write
  tenant B data.
- `tests/restaurant-m8-rls.test.ts:552-584` proves append-only and effective loyalty
  records cannot be updated or deleted by a tenant runtime.

## Archive disposition

All five commits listed on `archive/rescue/WHA-100` are skipped because their
valuable result is already represented in the current tree:

| Archive commit | Disposition |
| --- | --- |
| `6df2de58` — add M8 acceptance battery | Skip: the WHA-100 battery exists at `tests/restaurant-m8-acceptance.test.ts`. |
| `035a3211` — align M8 acceptance contracts | Skip: the current battery names and runs the complete contract groups. |
| `13e6a0aa` — isolate M8 acceptance from Auth.js | Skip: the current suite uses explicit owner/runtime database URLs. |
| `f750989e` — correct WHA-100 acceptance fixtures | Skip: the current governance and RLS fixtures cover all thirteen M8 tables and two tenants. |
| `2b5d4149` — pin M8 review contracts | Skip: the current runner rejects failures and skipped contract suites. |

Porting any of these historical commits would duplicate or regress the current
contracts rather than add a missing fix. No production code, migration, permissions,
tenant boundaries, pharmacy grants, or WhatsApp behavior is changed by this issue.
