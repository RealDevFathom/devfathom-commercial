# PR #162 review notes

## Findings addressed

- Restored the already-deployed `20261021110000_pharmacy_sindh_published_rules`
  migration byte-for-byte. Rewriting it would make Prisma reject upgraded
  databases and asking operators to edit `_prisma_migrations` would conceal
  migration drift. The later append-only v2 migration remains the correction.
- Made licence categories and medicine schedules exact allow-lists. Missing,
  malformed, and empty rule values now grant no regulatory capability rather
  than accidentally allowing every client-supplied value.
- Scoped the close of a prior profile version by organization and branch and
  require exactly one open row to change. This preserves tenant isolation and
  turns a concurrent/stale close into a conflict instead of silently writing a
  successor against unexpected state.
- Added focused unit coverage for exact-grant behavior, including the empty-list
  fail-closed case.

## Review constraints

- `git fetch origin main` and `git diff origin/main...HEAD` could not run because
  this checkout has no `origin` remote or `origin/main` ref. The review used the
  available branch history and the PR-specific commits in that history.
- Per request, dependencies were not installed and tests were not run.
- `error.log` was not added or committed.
