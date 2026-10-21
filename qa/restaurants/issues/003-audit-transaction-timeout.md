[QA][Restaurants][SEV1] Restaurant page reads fail when the audit transaction expires
Labels: qa, restaurants, sev1-critical

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Tenant `http://qa-karahi-house.localhost:3000`, signed in as the restaurant administrator. Executed 2026-10-21 during an authenticated page sweep of the restaurant workspace.

## Test case

Observed while loading restaurant workspace pages (reports, catalog, inventory, payments, catering, wastage, and others). It is not a single numbered case. It also made later UI checks of catalog and branches unreadable until the dev server was restarted.

## Steps

1. Sign in on the restaurant tenant host.
2. Open restaurant workspace routes in sequence, including `/restaurant/reports`, catalog, inventory, payments, catering, and wastage.
3. Watch the Next.js server log and Postgres responsiveness.

## Expected

Page reads return in normal request time. A failure to write an audit row does not hold the page transaction open until it expires, and it does not make later pages render an error shell or stall Postgres.

## Actual

Restaurant page reads run inside Prisma interactive transactions that expire. The server logged `[audit] failed to record ...` with `PrismaClientKnownRequestError` code `P2028` ("Transaction not found ... timeout" / commit cannot be executed on an expired transaction). `prisma.auditLog.create()` was the failing invocation. Procedures named in the log include workforceFinancial, sop, inventory, catering, wastage, `restaurantCatalog.listProducts`, and payments.

`GET /restaurant/reports` returned HTTP 200 in 17.7 minutes (`next.js: 8ms`, `proxy.ts: 4ms`, `application-code: 17.7min`). While the transactions were piled up, `psql` and `curl` against the app hung, load rose to about 22–28, and the `next-server` process RSS grew to about 13.4 GB. After the process was restarted, the same catalog and branches pages rendered their data. The outage screenshots that look like missing buttons are this failure, not absent controls.

## Evidence

- `qa/restaurants/evidence/audit-hang-snippet.txt` (P2028 lines and the 17.7 minute reports timing).
- Memory growth of `next-server` to about 13.4 GB was observed on the same pile-up and belongs to this defect.

## Suspected code

`src/server/audit.ts`, where restaurant reads record an audit row inside the same interactive transaction as the page query. No fix is proposed here.
