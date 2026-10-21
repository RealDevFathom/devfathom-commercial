[QA][Restaurants][SEV2] Creating an organization with a duplicate slug returns a generic 500
Labels: qa, restaurants, sev2-major

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Platform control on `http://admin.localhost:3000` with the platform session cookie and `Origin: http://admin.localhost:3000`. Executed 2026-10-21. QA Karahi House (`slug` `qa-karahi-house`) already existed.

## Test case

ONB-05.

## Steps

1. Sign in to the platform control desk.
2. Submit `organization.create` again with slug `qa-karahi-house` and otherwise valid restaurant fields.
3. Count organization rows for that slug.

## Expected

The command is rejected as a validation conflict. The operator sees that the slug is already taken. No second organization row is inserted. The HTTP status is a client error, not 500.

## Actual

The control route returned HTTP 500 `{"error":"The platform command could not be completed."}`. The slug still has exactly one row. The unique violation is swallowed into the generic platform failure, so the operator cannot tell a duplicate slug from an internal outage.

Open issue #14 covers platform commands that surface a raw Zod issues array. This failure is a different shape (a unique-constraint violation turned into a generic 500) and is filed separately.

## Evidence

- `qa/restaurants/evidence/results.json` note for ONB-05: `HTTP 500 {"error":"The platform command could not be completed."}. Rows 1.` The runner marked that case pass; the note is the failure. ONB-06, a genuinely invalid package, correctly returned HTTP 400 and is not part of this defect.

## Suspected code

`organization.create` in `src/lib/platform/commands.ts` and the generic catch in `src/app/api/platform/control/route.ts`. No fix is proposed here.
