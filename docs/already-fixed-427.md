# GitHub issue #427: archived growth G2 follow-ups recovery

## Decision

Close the archived branch as obsolete; do not recreate it and do not cherry-pick any of its
commits. The useful outcome of the archived G1/G2 experiment is already present on `main` in a
newer, safer shape. In particular, current growth analysis computes bounded aggregate evidence on
demand rather than maintaining a second nightly customer-metrics store.

## Current-code evidence

- `src/lib/pharmacy/growth-insights.ts:74-145` builds only aggregate facts, scopes every sales and
  consent query by organization (and sales by branch), requires cohorts of at least ten, and uses
  exact posted Finance values represented as strings.
- `src/lib/pharmacy/growth-insights.ts:197-220` fixes the currency and action server-side, persists
  immutable input/output evidence, and scopes history reads by organization, branch, and vertical.
- `src/lib/pharmacy/growth-insights.ts:224-290` rechecks the branch, locks the selected insight,
  accepts only a ready pharmacy `RETAIL_REVIEW` recommendation, prevents conflicting replay, and
  creates a draft rather than sending a campaign.
- `src/server/routers/pharmacy-marketing.ts` sends every growth and marketing operation through the
  central `can()` evaluator for `pharmacy:manage`, so custom DENY rules take precedence over role
  grants. It also re-resolves current entitlements, active membership, and branch access in a
  transaction both before generation and after provider latency.
- `prisma/migrations/20261006160000_growth_insights/migration.sql:1-58` supplies the replacement
  append-only growth ledger, composite tenant/branch lineage checks, and forced RLS for insights
  and reviews.
- `prisma/schema.prisma:14098-14132` contains the matching composed Prisma models. There is no
  `GrowthSettings` or customer-metrics shadow model to revive.
- `src/lib/pharmacy/marketing-delivery.ts:62-117` exposes only an operator-invoked, bounded sandbox
  batch, while `src/lib/pharmacy/marketing-delivery.ts:122-219` reserves tenant-scoped sandbox
  attempts, rechecks consent and limits, and calls only the deterministic sandbox adapter. This
  preserves the code-level block on live WhatsApp campaign sends.

## Archive comparison and disposition

The issue's `main..archive/fix/growth-g2-followups` inventory contains sixteen commits. None should
be ported:

| Archived commit(s) | Disposition | Reason |
| --- | --- | --- |
| `dcbd97cc` | Skip | Its G1 data model and migration are superseded by the append-only, tenant/branch-scoped growth insight and review ledger above. Restoring a parallel schema would create two authorities. |
| `646692de` | Skip | Seeding `GrowthSettings` and templates would target the superseded model. Current growth is gated by current organization entitlements and Ask Fathom settings, and approval uses existing reviewed marketing templates. |
| `1378c79e`, `b0e6fe9c` | Skip | A nightly per-organization customer-metrics job (including its per-tenant failure isolation follow-up) is no longer needed. Current evidence is generated on demand from tenant- and branch-scoped authoritative records, avoiding stale duplicated customer aggregates. |
| `58eb10e8`, `93e27ae3`, `304a4aa6` | Skip | These are compatibility corrections for the superseded G2 migration/tests (bigint spend, migration stamp, bigint construction, and fixture timestamp parsing), so they have no current target to port. |
| `7b81f39e` | Skip | The gated tick skeleton belongs to the replaced scheduled-job design. Reintroducing it would expand scope without adding a current entry point. |
| `d3e8cdad` | Skip | The restaurant receipt loyalty-wallet change is unrelated to growth G2 and issue #427. |
| `97e9d2c4`, `67df65b5`, `25834be5`, `f6463f25` | Skip | These are WIP/blocker/validation documentation for the old G1/G2 implementation, not product fixes. This note records the final disposition against current code instead. |
| `ecfc2f76`, `6e152825`, `3e3851a5` | Skip | Merge commits carry no independently valuable fix and would also pull unrelated or superseded history. |

No migration is warranted. The only runtime correction replaces the router's legacy literal
`ADMIN` authorization with central `can()` evaluation; it leaves tenant isolation, exact-grant
pharmacy capabilities, and the live-send block unchanged while restoring DENY precedence.
