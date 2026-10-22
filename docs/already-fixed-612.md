# GitHub issue #612 is already fixed

Issue #612 reports that the restaurant demo's Head Chef was assigned the operator role, which does
not grant `kitchen:operate`, and therefore could not unlock a KDS. The current code already fixes
that trace:

- `scripts/seed-restaurant-demo.ts:460-468` identifies Kashif, the Head Chef, as kitchen staff.
- `scripts/seed-restaurant-demo.ts:1280-1286` resolves the `kitchen` role with the tenant-scoped
  `(organizationId, key)` selector.
- `scripts/seed-restaurant-demo.ts:1358-1385` assigns that role to kitchen staff on both the update
  and create sides of the user upsert, while retaining manager-first role selection and the operator
  role for other staff.
- `src/lib/vertical-catalog.ts:1105-1110` grants the kitchen role `kitchen:operate`.
- `src/app/api/restaurant/terminal/unlock/route.ts:86-102` requires that exact capability when a
  staff member unlocks a KDS.
- `tests/restaurant-e2e-seed.test.ts:159-171` provides a focused regression guard for the Head Chef
  marker, tenant-scoped role lookup, role precedence, and create/replay assignments.

The existing fix is limited to demo seed role wiring. It does not weaken the KDS authorization
check, change capability evaluation, affect pharmacy grants, alter live WhatsApp behavior, or add a
migration.
