# Issue #452: archived SEV-1 retest recovery is already fixed

## Decision

Close the archived branch as obsolete. The four commits identified for
`archive/qa/retest-sev1-129-130-142` are successive retest records, while the current tree already
contains both the fixes they exercised and focused regression coverage. Reopening or cherry-picking
those historical reports would add stale QA evidence without changing product behavior.

## Current-code evidence

- **#129 — Sindh tax rules:** the ordinary Sindh profile is enabled with its pinned SRB source,
  eligibility control, and tender-specific 15%/8%/15% rules in
  `src/lib/restaurant/pakistan-tax-profiles.ts:17-39`. The unverified listed-branch profile remains
  fail-closed, with no rules, at `src/lib/restaurant/pakistan-tax-profiles.ts:42-56`. Focused tests
  assert both the verified rates and that the listed profile cannot be activated in
  `src/lib/restaurant/pakistan-tax-profiles.test.ts:21-57` and
  `src/server/routers/restaurant-tax.test.ts:95-109`.
- **#130 — canonical pharmacy capabilities and owner backfill:** the migration maps only known
  legacy grants, omits `pharmacy:safety` from the legacy wildcard expansion, preserves DENY over
  ALLOW, and restricts the Owner-template backfill to `key = 'owner' AND isSystem = true` in
  `prisma/migrations/20261021110000_canonical_pharmacy_capabilities/migration.sql:1-20` and
  `prisma/migrations/20261021110000_canonical_pharmacy_capabilities/migration.sql:56-67`.
- **#142 — restaurant catalogue tenant isolation:** catalogue reads derive the organization from
  trusted workspace context in `src/server/routers/restaurant-catalog.ts:102-130` and
  `src/server/routers/restaurant-catalog.ts:1093-1104`. The regression cases prove foreign reads
  return `NOT_FOUND`, list calls ignore a caller-supplied organization, and foreign relation IDs
  are rejected before writes in `src/server/routers/restaurant-catalog.test.ts:594-644`.
- **Goods in:** receipt creation requires procurement access, derives a trusted receiving scope,
  validates order-line ownership, and writes the scope's organization and branch in
  `src/server/routers/pharmacy-purchasing.ts:960-1013` and
  `src/server/routers/pharmacy-purchasing.ts:1092-1113`. Posting is atomic in
  `src/server/routers/pharmacy-purchasing.ts:1119-1164`. Database regressions verify forced RLS and
  cross-tenant receipt invisibility in `src/lib/pharmacy/goods-receipt.db.test.ts:329-385`.

## Archive disposition

Nothing from the four archive-only commits is worth porting:

| Archive commit | Disposition | Reason |
| --- | --- | --- |
| `65217005` | Skip | First retest record; the current code and focused tests above are stronger, executable evidence. |
| `6d0c3e2b` | Skip | Second retest record of the same fixes; superseded by the current regression coverage. |
| `1e42926c` | Skip | Third retest record; owner backfill and Goods in are already implemented and covered. |
| `17064c86` | Skip | Final retest record; it adds historical verification only and no missing product fix. |

No migration or runtime code change is required for #452.
