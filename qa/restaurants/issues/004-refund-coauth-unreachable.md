[QA][Restaurants][SEV1] Refunds and comps are unreachable because co-authorization ignores job roles
Labels: qa, restaurants, sev1-critical

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Tenant `http://qa-karahi-house.localhost:3000`, organization QA Karahi House (`cmvhhcld5000g1yjsl1lp4a8v`), branch Clifton. Executed 2026-10-21.

## Test case

PAY-06. The same gate blocks comps and REV-02 (device revoke).

## Steps

1. Create a floor staff profile with no linked web user (`restaurantStaff.create` omitting `userId`). Profile `cmvhl1tkv005xchjsjecd9zz9`.
2. Grant that profile the Owner job role (`cmvhhclf000361yjssb1hecpy`). In the database that role includes `coauth:approve`, as do the shift-supervisor and manager job roles.
3. Issue a PIN credential for that profile (`cmvhl2gjg007schjsk0k9wnti`).
4. On an enrolled register, unlock as the acting owner staff profile (`cmvhhclfk004o1yjs8ekhf7z5`) and submit a refund of card tender `cmvhkzgtr004mchjsxn4713ro` with the floor profile as the distinct approving manager.
5. Submit a comp of a split line with the same approving profile.

## Expected

A second staff identity that holds the Owner job role, which includes `coauth:approve`, can approve a refund and a comp. The acting operator and the approver are different people, which is what co-authorization asks for.

## Actual

Both calls returned HTTP 403 `The approving manager lacks the "coauth:approve" capability.`

`operatorHasCapability` loads only the linked `User` organization-role permissions and overrides. Its comment states "No linked user ⇒ denied." Job-role capabilities on `restaurant_job_role_capabilities` are not consulted. A PIN-only floor manager with the Owner job role therefore cannot approve.

A single web administrator also cannot approve their own refund: co-authorization requires a second identity. Combined with the HR invite gate (separate issue: restaurant administrators cannot invite web users), there is no way to create that second linked user from the restaurant workspace. Refunds and comps are unreachable.

This is the same product pattern as pharmacy issue #130 (role templates versus capability checks) and is a different code path. It is filed separately. Pharmacy issue #135 is the sibling "cannot add a cashier" and is not this defect.

## Evidence

- `qa/restaurants/evidence/pos-coauth.json` (refund and comp both HTTP 403 with the capability message).
- `qa/restaurants/evidence/pos-settle.json` recorded the earlier same-identity refund attempt, which is a different refusal (the approver must be distinct). The 403 above is the distinct-approver attempt.

## Suspected code

`operatorHasCapability` in `src/lib/restaurant/checkout-routes.ts` (linked user only; "No linked user ⇒ denied"). Refund and comp bodies in the same module require that capability on a second staff profile. No fix is proposed here.
