[QA][Restaurants][SEV2] A restaurant administrator can render the agency host dashboard
Labels: qa, restaurants, sev2-major

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Agency host `http://devfathom.localhost:3000` is a tenant host whose slug is `devfathom` (seeded organization `org_devfathom`), not a shared login host. Restaurant tenant `http://qa-karahi-house.localhost:3000`. Executed 2026-10-21.

## Test case

No numbered case. Found while opening the restaurant administrator session against the agency host. LCY-04 (sign-in on the restaurant slug host) passed and is not this defect.

## Steps

1. Sign in as the QA Karahi House administrator (`qa-karahi-owner@example.com`) with the browser pointed at `http://devfathom.localhost:3000`.
2. Open `/dashboard` on that host.
3. Repeat the sign-in after the server had been restarted and note the URL and session slug.

## Expected

A restaurant session is not rendered inside the agency workspace. The host organization and the session organization must match, and a mismatch sends the user to the login page on the correct host without painting the other tenant's shell.

## Actual

The first attempt rendered the restaurant administrator inside the agency shell: `http://devfathom.localhost:3000/dashboard` showed Ayesha Khan, Organization administrator, on the DevFathom company workspace. Screenshot `qa/restaurants/evidence/tenant-home.png`.

A later retry stayed on `http://devfathom.localhost:3000/login`. The session slug reported for that attempt was `devfathom`, and a following navigation to `/restaurant/catalog` also landed on `/login`. Screenshot `qa/restaurants/evidence/tnt-host.png` is that login page. This report does not claim the retry painted the dashboard. The first screenshot is the defect: the restaurant administrator was rendered on the agency host.

An agency user on the same host is correctly denied restaurant catalog (TNT-01 passed, HTTP 403, no House product leak). That denial does not cover this host mismatch.

## Evidence

- `qa/restaurants/evidence/tenant-home.png` (Ayesha Khan rendered on `devfathom.localhost`).
- `qa/restaurants/evidence/pos-rest.json` record `TNT-HOST`: first and next URL both `http://devfathom.localhost:3000/login`, session slug `devfathom`.
- `qa/restaurants/evidence/tnt-host.png`.

## Suspected code

Host classification in `src/lib/tenancy/host-routing.ts` (`devfathom.localhost` is a tenant host), the app layout in `src/app/(app)/layout.tsx`, and the session organization check in `src/lib/auth.ts` / tenant actor resolution. No fix is proposed here.
