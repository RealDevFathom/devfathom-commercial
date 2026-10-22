# PR #115 review notes — Growth G1

## Review scope

The requested `git fetch origin main` could not run because this checkout has no configured
`origin` remote. The review therefore used the available G1 history (`97e9d2c..25834be`) and the
current branch state, including the later G1 migration follow-ups already present at `HEAD`.

No dependencies were installed and no test suite was run, as requested.

## Findings and fixes

- **Migration atomicity:** the privileged customer backfill previously committed before the rest of
  the migration. A later DDL failure could therefore leave a partially applied migration. The whole
  Growth G1 migration is now one explicit transaction, and its transaction-local platform-admin
  setting cannot leak into later work.
- **Tenant isolation:** recipient discount codes used a global unique index and the schema comment
  suggested lookup without tenant scope. That both created a cross-tenant collision side channel and
  encouraged unsafe lookup behavior. Codes are now unique by `(organizationId, code)`, and the model
  contract requires authenticated tenant scope.
- **Authorization:** `growth.manage` fell back to the coarse `ADMIN` role, allowing a pharmacy admin
  whose deliberately restricted pharmacy role had no growth grant. The static fallback is removed;
  pharmacy access now requires an exact `growth.manage` grant. Existing permission resolution still
  evaluates an applicable `DENY` before an `ALLOW`, including user overrides before role rules.
- **Money and bounded-value invariants:** database checks now reject negative metric spend/counts,
  negative or inverted settings budgets, campaign spend above its cap, invalid discount pairs,
  negative reach, invalid quiet hours/send limits, and out-of-range churn values. These invariants
  live in PostgreSQL so raw SQL and future writers cannot bypass them.
- **Missing regression coverage:** the ABAC suite now covers exact-grant-only pharmacy access and
  DENY-over-ALLOW. The migration database test now pins all new checks and the tenant-scoped code
  index, in addition to its existing FORCE RLS/backfill assertions.

## Deliberate non-changes

- The five-table G1 shape, consent-default behavior, WhatsApp phone normalization, demo seed content,
  and later G2 metric fields remain within their existing contracts.
- No dependencies, generated client output, unrelated formatting, or `error.log` were added.
