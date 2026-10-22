# GitHub issue #428: archive recovery is already fixed

## Decision

Close #428 as obsolete. Do not recreate `fix/qa-129-lows` and do not cherry-pick
the archive wholesale. The valuable changes described by the archived branch are
already present in the current code, while the remaining commits are merges,
superseded migration history, or administrative notes.

The archived tag was not available in this checkout and the repository has no
configured `origin`. A read-only `git ls-remote` against the repository URL was
also blocked by the environment's HTTP 403 policy. The assessment therefore used
the issue's supplied 27-commit inventory and verified every potentially valuable
behavior directly against the current tree.

## Current-code evidence

- `src/server/routers/pharmacy-onboarding.ts:348-354` scopes the branch lookup by
  both `organizationId` and `id`, preserving tenant isolation and rejecting an
  inactive, missing, or foreign-tenant branch.
- `src/server/routers/pharmacy-onboarding.ts:355-370` parses both licence windows
  once and rejects a licence or qualified-person registration that does not cover
  the profile's effective date. The upper bound is exclusive (`validTo <=
  effectiveFrom` is rejected).
- `src/server/routers/pharmacy-onboarding.ts:372-387` resolves rules in force for
  the effective date, rejects an unpublished jurisdiction, and requires the
  submitted province to equal the branch's canonical province.
- `src/server/routers/pharmacy-onboarding.ts:409-457` preserves append-only,
  effective-dated history: a successor must be later than the latest version and
  the close-plus-create operation remains inside one transaction.
- `src/server/routers/pharmacy-onboarding.db.test.ts:203-228` proves that a
  cross-tenant branch cannot be selected or written.
- `src/server/routers/pharmacy-onboarding.db.test.ts:230-279` has focused
  regression coverage for unpublished rules, branch/province mismatch, and both
  effective-date validity windows.
- `prisma/migrations/20261023000428_pharmacy_trgm_runtime_grant/migration.sql:1-4`
  grants only `public.similarity_op(text, text)` to `devfathom_app`; it does not
  grant all functions or restore `PUBLIC` execution.
- `tests/pharmacy-trgm-runtime-grant.test.ts:14-21` locks down that exact grant and
  explicitly rejects broad or public grants.

## Archive disposition

### Valuable behavior already present (skip as duplicate)

- `627e0409`, `d1ec4742`, `eadb00b8`: the two `saveRegulatoryProfile` security
  lows (branch province binding and effective-date coverage) are implemented and
  covered at the locations above.
- `f09ced61`, `1ca3e193`, `66be65c3`: the catalogue search runtime requirement is
  satisfied by the narrow `similarity_op(text, text)` grant and its focused test;
  a broader pg_trgm grant would weaken least privilege.
- `a6ef00fb`, `76c272c5`, `d4c2c45b`, `68d5d37a`, `da0b5835`, `ee28700c`,
  `5f5897bd`, `be318913`, `caeed1d9`, `13f20615`, `9c1178cf`, `14efe61d`: the
  relevant Sindh/profile protections have been superseded by the current
  effective-date, published-rule, branch-province, transaction, and regression
  logic cited above. Replaying old migration iterations would rewrite deployed
  history and risk duplicate or contradictory rule rows.
- `0c32cd2b`, `79d4a3d9`: seat-occupancy copy is unrelated to the two remaining
  security lows and is already represented as merged work in the archive
  inventory; no #428 change is warranted.

### Non-product history (skip)

- `837e57d3`, `cd4433ef`: integration merge commits would import unrelated work
  and are not suitable for a minimal recovery.
- `b22dd550`: an old migration timestamp adjustment has no value without its
  superseded migration chain; the current narrow grant uses the required unique
  issue timestamp `20261023000428`.
- `16091871`, `ba5086e9`, `a8430563`, `bc1dccb9`: blocker/status documents and
  their cleanup commits do not change runtime behavior and should not be revived.

No archived commit should be cherry-picked, and no archive branch should be
reopened.
