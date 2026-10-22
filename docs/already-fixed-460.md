# Issue #460: archived WHA-82 work is already present

## Decision

Close the recovery issue as obsolete. Do not recreate `rescue/WHA-82` and do not
cherry-pick its three archived commits. The valuable behavior described by those
commits is already in the current code, with focused unit coverage. Reapplying it
would duplicate the notification implementation and its tests.

The checkout supplied for this issue has no `origin` remote, `main` ref, archive
tag, or archived commit objects. Consequently, the requested Git object diff
cannot be reproduced locally: `git fetch origin tag archive/rescue/WHA-82` fails
because `origin` is not configured. The recovery decision below therefore compares
the provided three-commit manifest with the current tree's concrete behavior,
rather than claiming an unavailable byte-for-byte branch diff.

## Current-tree evidence

The archived feature commit is already represented by all of its stated behavior:

- The complete channel matrix (`IN_APP`, `WEBHOOK`, `EMAIL`, `SMS`, `PUSH`, and
  `WHATSAPP`) is declared in `src/lib/restaurant/notifications.ts:8-15`.
- Organization settings and branch overrides are resolved in scoped storage, with
  branch taking precedence over organization and the default applied only when no
  setting exists, in `src/lib/restaurant/notifications.ts:65-93`.
- In-app notifications are persisted per deduplicated recipient in
  `src/lib/restaurant/notifications.ts:97-123` and written with retry-safe
  `skipDuplicates` behavior in `src/lib/restaurant/notifications.ts:136-142`.
- Non-webhook external channels remain explicit `STUBBED` delivery records while
  in-app is `DELIVERED_IN_APP`; there is no live WhatsApp send path in this
  fan-out, in `src/lib/restaurant/notifications.ts:124-133`.
- The durable fan-out path writes a deterministic pending outbox event, converts it
  to an idempotent scheduler job, validates the payload, and invokes delivery in
  `src/lib/restaurant/notification-fanout.ts:20-77`. The consumer is registered in
  `src/lib/restaurant/notification-fanout.ts:79-83`.
- Tenant boundaries are enforced in the database as well: composite tenant foreign
  keys are declared in
  `prisma/migrations/20260820000000_restaurant_scheduler_sop_notifications/migration.sql:710-713`,
  and notification, channel-setting, and delivery tables have forced RLS/policies
  in the same migration at lines 750-755 and 782-785.

The archived test commit is also already represented:

- Matrix precedence is covered in `src/lib/restaurant/notifications.test.ts:70-87`.
- Real in-app persistence, external-channel stubbing, recipient deduplication, and
  disabled channels are covered in `src/lib/restaurant/notifications.test.ts:89-110`.
- Retry idempotency and demo outbound suppression are covered in
  `src/lib/restaurant/notifications.test.ts:112-132`.
- Durable consumer registration, deterministic outbox insertion, and idempotent
  fan-out job creation are covered in
  `src/lib/restaurant/notification-fanout.test.ts:47-95`; strict payload rejection
  is covered at lines 97-125.

## Archived commits skipped

| Archived commit | Decision | Why |
| --- | --- | --- |
| `d4d28461` — notifications feature | Skip | Its channel matrix, real in-app delivery, external stubs, and durable fan-out are already implemented at the evidence locations above. |
| `4e6032b7` — notification unit batteries | Skip | Focused current tests already cover the core matrix/delivery and fan-out contracts. Adding parallel copies would reduce clarity without increasing coverage. |
| `1c4c1cbe` — BUILD-ASSUMPTIONS documentation | Skip | The implementation and tests are the authoritative current-tree evidence. Restoring an older milestone assumptions document without the archived bytes available for comparison risks reintroducing stale decisions. This disposition document records the useful recovery decision instead. |

No application code, authorization behavior, migration, or existing live-send
guard is changed by resolving issue #460.
