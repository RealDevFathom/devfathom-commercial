[QA][Restaurants][SEV2] Disabling restaurant-pos leaves the Point of sale workspace available
Labels: qa, restaurants, sev2-major

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Platform control on `http://admin.localhost:3000`. Tenant `http://qa-karahi-house.localhost:3000`. Module `restaurant-pos` id `cmvhh2f1o000vg9jsr1u3o3be` on organization QA Karahi House (`cmvhhcld5000g1yjsl1lp4a8v`). `restaurant-pos` is not mandatory; `restaurant-core` is. Executed 2026-10-21. The module was set back to ENABLED immediately after the check. The database now shows ENABLED.

## Test case

REV-01.

## Steps

1. From the platform control desk, call `organization.module` to set `restaurant-pos` to DISABLED for QA Karahi House, with a reason.
2. While the module is DISABLED, sign in as the restaurant administrator and open `GET /pos` on the tenant host.
3. Re-enable the module.

## Expected

Disabling `restaurant-pos` hides or denies the Point of sale workspace. The operator sees an entitlement or not-found response, not the register shell.

## Actual

The disable command returned HTTP 200 with module status DISABLED. `GET /pos` still returned HTTP 200 and rendered the register shell ("This browser is not enrolled" / device session). The enable command then returned HTTP 200 and the module is ENABLED again.

The terminal order API was not called during the disabled window. This report does not claim that order commands stayed authorized. It claims the workspace route stayed available.

## Evidence

- `qa/restaurants/evidence/pos-rest.json` record `REV-01`: disable 200 with `status` DISABLED, `pos 200` at `http://qa-karahi-house.localhost:3000/pos`, enable 200.
- `qa/restaurants/evidence/rev-01.png`.

## Suspected code

The `/pos` page and its layout entitlement gate. `restaurant-pos` is declared `mandatory: false` in `src/lib/vertical-catalog.ts`, so a disable is a supported platform command, but the workspace does not honor it. No fix is proposed here.
