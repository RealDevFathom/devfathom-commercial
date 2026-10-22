# GitHub issue #436 — archive recovery is already superseded

## Decision

Close `archive/improve/ai-growth-g2` as obsolete; do not recreate the branch or
cherry-pick it. The archived G1/G2 design has been superseded on `main` by the
shared, review-gated growth implementation described below. Porting the old
schema, seed data, or nightly tick would create a second growth model rather
than repair a missing capability.

The checkout used for this review is shallow and did not contain object
`304a4aa6`. Fetching the named archive tag was attempted, but the environment's
GitHub tunnel returned HTTP 403. Consequently the recovery inventory below was
checked commit-by-commit from the issue's authoritative 12-commit manifest,
then verified against the current implementation; no claim is made that an
unavailable patch was byte-for-byte diffed.

## Current-code evidence

- The accepted shared data model already stores tenant and branch scope,
  vertical, actor, version/hash, status, provider/model, the immutable input
  snapshot, output, and creation time in `GrowthInsight`
  (`prisma/schema.prisma:14098-14117`). Pharmacy review lineage is represented
  separately (`prisma/schema.prisma:14120-14132`), while Restaurant review and
  draft records are tenant/branch scoped and idempotent
  (`prisma/schema.prisma:14135-14176`).
- The corresponding migration constrains valid verticals, statuses, hashes,
  successful versus failed results, review decisions, and draft lineage
  (`prisma/migrations/20261006160000_growth_insights/migration.sql:2-38`). It
  also enables and forces RLS with organization and optional branch predicates
  on both shared tables
  (`prisma/migrations/20261006160000_growth_insights/migration.sql:39-48`).
- Restaurant growth generation is explicitly authorized before reading or
  writing, binds identity to organization, branch, actor, and request ID, and
  scopes replay lookup by organization, branch, and vertical
  (`src/lib/restaurant/growth-generation.ts:59-90`). It rechecks source state
  after generation and reauthorizes immediately before persistence
  (`src/lib/restaurant/growth-generation.ts:92-145`).
- Pharmacy growth input is computed from aggregate, organization/branch-scoped
  completed-sale facts; cohorts smaller than ten are suppressed and incomplete
  Finance coverage cannot emit money metrics
  (`src/lib/pharmacy/growth-insights.ts:74-124`). WhatsApp audience facts require
  current opt-in plus the latest unrevoked marketing consent and are likewise
  cohort-suppressed (`src/lib/pharmacy/growth-insights.ts:126-145`).
- The code-level production WhatsApp block remains unconditional: the factory
  returns disabled send functions even when provider configuration exists
  (`src/lib/pharmacy/whatsapp/provider.ts:279-295`).

These controls are materially safer and more complete than restoring a gated
tick skeleton plus a parallel `GrowthSettings` model. In particular, the
current design preserves tenant isolation and human review while avoiding an
automatic nightly path that could turn recommendations into live outreach.

## Archive inventory: skipped work and rationale

| Archived commit | Disposition | Reason |
| --- | --- | --- |
| `7b81f39e` gated growth tick skeleton | Skip | Obsolete orchestration. Current generation has authorization, deterministic idempotency, source revalidation, and review lineage; adding the skeleton would create a competing execution path. |
| `97e9d2c4` blocked G1 schema draft | Skip | Explicit WIP/blocker documentation, not production work. |
| `67df65b5` G2 blocked by invalid G1 schema | Skip | Historical blocker documentation; the accepted shared schema and migration now exist. |
| `dcbd97cc` G1 data model and migration | Skip | Superseded by `GrowthInsight` plus vertical review/draft models and forced-RLS migrations. Restoring it risks schema duplication and weaker scope guarantees. |
| `646692de` demo `GrowthSettings` and templates | Skip | Targets the superseded schema and introduces seeded operational settings. Current recommendations remain review-gated and the live WhatsApp sender remains blocked. |
| `25834be5` clear resolved G1 blocker | Skip | Historical documentation only. |
| `6e152825` merge of G1 | Skip | Merge-only history; its relevant schema content is superseded as above. |
| `1378c79e` nightly tenant customer metrics job | Skip | The old job belongs to the superseded G1 model. Current vertical implementations build scoped, privacy-thresholded evidence at generation time; restoring the job would duplicate facts and broaden unattended processing. |
| `f6463f25` G2 validation stop/remaining checks | Skip | Historical validation notes for the archived implementation, not applicable to the replacement. |
| `304a4aa6` PostgreSQL fixture timestamps as UTC | Skip | Test-only correction for archived fixtures. Current persisted timestamps use `TIMESTAMPTZ`, and current Restaurant source timestamps are validated and converted explicitly before use. |
| `d3e8cdad` Restaurant loyalty wallet receipt | Skip | Unrelated feature commit carried by archive ancestry, not an AI-growth fix. |
| `ecfc2f76` merge PR #106 Restaurant loyalty | Skip | Unrelated merge-only ancestry; do not replay it as part of issue #436. |

## Verification outcome

No production code, migration, seed, permission, outbound-message, or test
change is needed for #436. The valuable intent of the archive is already
covered by the newer shared implementation, while the remaining commits are
obsolete documentation, merge ancestry, or unrelated loyalty work.
