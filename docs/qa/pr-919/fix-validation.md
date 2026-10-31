# PR #919 review fixes

The six local review findings are addressed: the migration backfill runs as a
standalone committed-batch call, billed gross is bounded by the MRP ceiling,
allocations and returns preserve charged money, lot revenue/refund reversals use
those snapshots, the live receipt uses exact allocation pricing, and the missing
required-gross fixtures are populated. The develop conflict is resolved while
retaining its cash-received/change handling.

Historical append-only allocation and return evidence stays unchanged. Null money
snapshots use the historical uniform-price/cumulative-return rules. New return
snapshots keep unidentified holds stable and cap total reversals at the original
net; a complete physical return recovers the rounding remainder.

Validation performed directly, without the prohibited broad checks:

- 130 tests passed across the affected loyalty, sale, reservation, money, posting,
  receipt and cart unit/component suites.
- 80 additional counter, browser-print and receipt-identity unit tests passed.
- Five mixed-lot PostgreSQL regressions passed under a NOSUPERUSER/NOBYPASSRLS
  runtime role: exact settlement/rollback/concurrent retry, per-lot revenue, cheap
  and expensive identified refunds/reversals, and the billed MRP ceiling.
- Two exact-script migration cases passed in isolated schemas under a table owner
  subject to forced tenant RLS: empty tables and 5,001 historical rows per tenant
  in two tenants. Each migration file was sent as one PostgreSQL query. No Prisma
  migration command was used.
- Eight existing finance sale/return, margin and tenant-isolation database tests
  passed when selected by test name.
- Browser layout checks rendered the actual receipt component with Studio CSS in
  an isolated harness: 375/768/1024/1440px, light/dark, normal/reduced motion, and
  ready/loading/idle/error/printing states (80 combinations). No document overflow
  or render errors; receipt controls were keyboard reachable and printing controls
  disabled. The component tests also cover both receipt languages and exact
  allocation pricing. This harness does not exercise authenticated route loading,
  hydration, network requests or browser print-dialog integration.
- `git diff --check` passed.

The dedicated `dfpr_919` database already contained the review's test-only schema
workaround. Behavioral tests used its updated schema; migration evidence comes
from the separate exact-script cases, not that workaround. Five deliberately
invalid gross values left by the earlier security probe were restored in that
sandbox before validating the new ceiling.

Running the whole existing finance-postings DB file also reproduced two unrelated
`COAUTH_REQUIRED` failures in write-off scenarios: develop requires an authorized
witness but those fixtures do not provide one. The write-off implementation is
identical to origin/develop and was not changed by this fix. No test or check was
removed or weakened.
