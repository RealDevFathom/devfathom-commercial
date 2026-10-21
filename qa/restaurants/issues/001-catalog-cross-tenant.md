[QA][Restaurants][SEV1] Restaurant catalog reads return another tenant's products
Labels: qa, restaurants, sev1-critical, security

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. App on port 3000. Documented application connection in `docs/LOCAL_SETUP.md` is `postgresql://postgres:postgres@localhost:5432/devfathom` (the PostgreSQL superuser). Tenant hosts: `http://qa-karahi-house.localhost:3000` (QA Karahi House, organization `cmvhhcld5000g1yjsl1lp4a8v`) and `http://qa-karahi-essentials.localhost:3000` (QA Karahi Essentials, organization `cmvhhd11m008f1yjsvn9l8mrd`). Executed 2026-10-21.

## Test case

TNT-03.

## Steps

1. Sign in as the Essentials organization administrator on `http://qa-karahi-essentials.localhost:3000`. Confirm the session organization is QA Karahi Essentials (`cmvhhd11m008f1yjsvn9l8mrd`) and the page URL stays on that host.
2. Call `restaurantCatalog.getProduct` for the House product Chicken Karahi (`cmvhjueo300f51yjsrcfr7m60`), which belongs to organization `cmvhhcld5000g1yjsl1lp4a8v`.
3. Call `restaurantCatalog.listProducts` on the same Essentials session.

## Expected

The Essentials session can read only products owned by QA Karahi Essentials. A House product id returns not found. The list contains no House rows.

## Actual

`getProduct` returned HTTP 200 with Chicken Karahi and `organizationId` `cmvhhcld5000g1yjsl1lp4a8v` while the browser was on `http://qa-karahi-essentials.localhost:3000/dashboard`. `listProducts` on that same session returned both House products (Chicken Karahi and Garlic Naan), each with the House organization id. The House session listing the same product is expected and is recorded only as a control.

`listProducts` and `getProduct` query `restaurantProduct` by id or an empty filter and do not add an `organizationId` predicate. Isolation is left to row-level security. The documented local role is a superuser, and the application does not `SET row_security = on`. `docs/LOCAL_SETUP.md` already says the database-backed isolation suites are meaningful only with a `NOSUPERUSER NOBYPASSRLS` role. On the connection the setup guide tells an operator to use, one restaurant tenant can read another's catalog.

## Evidence

- `qa/restaurants/evidence/pos-rest.json` records `TNT-03-ess` (HTTP 200, House product id and organization id) and `ESS-URL` (`http://qa-karahi-essentials.localhost:3000/dashboard`). `TNT-03-house` is the same-tenant control.
- `qa/restaurants/pos-idor.ts` printed the Essentials session slug `qa-karahi-essentials`, organization `cmvhhd11m008f1yjsvn9l8mrd`, and both product names with the House organization id. It does not print credentials.

## Suspected code

`src/lib/restaurant/catalog.ts` (`listProducts` around the `findMany` with no organization predicate, `getProduct` `findUnique` by id only). The documented superuser `DATABASE_URL` in `docs/LOCAL_SETUP.md` bypasses `FORCE ROW LEVEL SECURITY`. No fix is proposed here.
