# GitHub issue #406 is already fixed

Verified against the current code on 2026-10-22. No additional product-code change is needed:

- `src/server/routers/restaurant-staff.ts:54-59` documents that every staff procedure is gated by `staff:manage`, and line 120 constructs that capability-gated procedure.
- `src/lib/vertical-catalog.ts:990-1024` grants `staff:manage` to the Restaurant General Manager template.
- `src/lib/vertical-catalog.ts:1036-1066` grants `staff:manage` to the Restaurant Branch Manager template.
- `src/lib/vertical-catalog.test.ts:288-294` asserts that the two manager templates, and only those templates, receive the explicit grant.
- `prisma/migrations/20261021200000_restaurant_manager_staff_capability/migration.sql:1-19` repairs existing Restaurant system roles for both manager keys, while `ON CONFLICT ... DO NOTHING` preserves an existing permission row (including an explicit `DENY`).
- `tests/restaurant-manager-staff-capability-migration.test.ts:14-29` verifies the migration's Restaurant, system-role, manager-key, conflict-preservation, and cross-tenant elevation constraints.

The existing implementation was introduced by commit `8dbb4ff6681ebc032ca1d130c314268e77a830b9` (`fix(#406): staff:manage for GM and Branch Manager templates`).
