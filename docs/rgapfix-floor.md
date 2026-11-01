# Restaurant floor gap follow-up — 2026-10-22

## Selection and verification

This follow-up selected the first three **High/Medium** findings in the supplied impact order
(findings 3, 4, and 5). The two preceding Critical findings were not part of the requested
High/Medium selection.

None of the selected findings was already fixed in the starting revision:

- **Finding 3 — inactive default promotion:** `setDefaultStation` did not read or validate the
  station's active state, and the console offered **Make default** for every non-default station.
- **Finding 4 — course routing:** the persisted rule, resolver target, mutation input, ticket
  generation path, and editor supported only product/category targets despite the documented
  product → category → course/default precedence.
- **Finding 5 — read-only console:** floor reads and mutations had different server gates, but the
  console had no authoritative `floor:manage` decision and rendered mutation controls after any
  successful read.

## Open-issue screening

No selected finding is identified by an issue reference in the checkout (`TICKETS.md`, `.github`,
or `docs/**`). Authoritative GitHub screening was not possible: this checkout has no Git remote,
`gh auth status` reports no authenticated host, and the public GitHub API request is blocked by the
environment's HTTP 403 proxy. Therefore no selected finding was skipped as issue-covered; this is
the same best-effort limitation recorded by the source report, not a claim that a private issue
cannot exist.

## Changes

- **Finding 3:** reject inactive candidates in the station domain before the default-changing
  transaction, hide **Make default** for inactive stations, and cover both safeguards in behavioral
  tests. (`src/lib/restaurant/stations.ts:168`,
  `src/components/restaurant/floor/floor-console.tsx:796`,
  `src/lib/restaurant/stations.test.ts:245`,
  `src/components/restaurant/floor/floor-console.test.tsx:215`)
- **Finding 4:** add a positive integer course target to the database XOR constraint, station rule
  CRUD/read model, router input, resolver precedence, fire-time item facts, and floor editor; cover
  domain creation and resolution behavior. (`prisma/schema.prisma:6730`,
  `prisma/migrations/20261022120000_restaurant_course_station_routing/migration.sql:1`,
  `src/lib/restaurant/stations.ts:217`, `src/server/routers/restaurant-floor.ts:513`,
  `src/lib/restaurant/station-routing.ts:23`, `src/lib/restaurant/kitchen-tickets.ts:42`,
  `src/lib/restaurant/orders.ts:822`,
  `src/components/restaurant/floor/floor-console.tsx:1083`)
- **Finding 5:** expose a read-gated, centrally evaluated `floor:manage` access view and use it to
  show an explicit read-only notice while removing every mutation control. Behavioral router and
  console tests cover the denied-management path. (`src/server/routers/restaurant-floor.ts:96`,
  `src/components/restaurant/floor/floor-console.tsx:112`,
  `src/components/restaurant/floor/floor-console.tsx:481`,
  `src/server/routers/restaurant-floor.test.ts:189`,
  `src/components/restaurant/floor/floor-console.test.tsx:200`)
