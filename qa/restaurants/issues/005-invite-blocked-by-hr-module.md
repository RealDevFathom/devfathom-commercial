[QA][Restaurants][SEV2] Restaurant administrators cannot invite web users because invite requires the HR module
Labels: qa, restaurants, sev2-major

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Tenant `http://qa-karahi-house.localhost:3000`, signed in as the organization administrator of QA Karahi House (Restaurant Enterprise). Executed 2026-10-21.

## Test case

STF-02 and STF-03. This also blocks PERM-01 through PERM-04 and VAL-02, which need a second web user.

## Steps

1. Sign in as the restaurant organization administrator.
2. Call `team.inviteMember` for a cashier, a kitchen user, and a server, using the restaurant role templates.
3. Attempt to accept an invitation.

## Expected

The restaurant administrator can invite web users into the cashier, kitchen, and server organization roles. Restaurant Enterprise does not need the agency HR module to do that. Invitation acceptance can proceed.

## Actual

`team.inviteMember` returned HTTP 403 `The HR module is not enabled for this organization.` No invitation token was issued, so acceptance could not run. `adminProcedure` gates the invite on the HR module. Restaurant organizations are not sold that module, so the documented web-user roles cannot be assigned from the restaurant workspace.

Floor PIN profiles can still be created without a linked user. That does not create a web user, and those profiles cannot satisfy co-authorization (see the separate refund issue).

A follow-up `restaurantStaff.create` that passed `userId: ""` returned HTTP 500 with the raw Prisma `ForeignKeyConstraintViolation` text on `restaurant_staff_profiles_userId_fkey`. That leak is an instance of open issue #15 and is not refiled. Omitting `userId` (rather than sending an empty string) created the profile successfully.

Pharmacy issue #135 is the sibling "owner cannot add a cashier" on a different vertical. This restaurant failure is filed separately.

## Evidence

- `qa/restaurants/evidence/api-results.json` records `STF-02` (`invite 403 The HR module is not enabled for this organization.; accept 0 no token`) and `STF-03` (role lookup 404 because the member was never created, plus the #15 Prisma text on empty `userId`).
- `VAL-02` in the same file is the same 403.

## Suspected code

The HR-module gate on `adminProcedure` in `src/server/trpc.ts`, and `team.inviteMember` in `src/server/routers/team.ts`. No fix is proposed here.
