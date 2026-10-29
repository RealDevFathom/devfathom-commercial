# PR683 R17 validation

Validated on 2026-10-29 from detached `a41e4b2`, with the already-merged
`origin/develop`. AGENTS.md and Azure files were unchanged. No application or
security-policy implementation was changed; solo PIN reauthentication,
transaction-bound success audits, staffed approval and earlier authorization
fixes remain covered by the selected tests.

## Reproduction

```sh
NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck
bun run lint
node scripts/validate-pr683-db.mjs
git diff --check
```

The runner reads the local admin DATABASE_URL privately from the environment or
local dotenv files and refuses non-loopback targets. It creates a random database
and fresh logins, applies `prisma/prepare-extensions.sql`, then runs
`prisma migrate deploy` with a temporary configuration that cannot be overridden
by local dotenv files. Admin access is confined to setup/migration and teardown;
test workers receive no inherited admin URL.

DATABASE_URL and TEST_DATABASE_URL identify the fresh app login, verified as
NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE and NOCREATEDB. A separate restricted
NOSUPERUSER/NOBYPASSRLS fixture owner supports transactional DDL replay. Its
membership in the app role permits SET ROLE tests; membership is never granted
in the reverse direction. Solo-approval concurrency connections use the actual
app login. Dedicated fresh clones isolate camera queues, receipt numbering,
SELECT-only repeat-purchasing fixtures and the reserved-loopback returns lane.
Generated credentials are redacted from child output; disposable resources are
removed afterward.

## Changes and evidence

- Vitest runs DB files and legacy RLS suites serially in a separate project;
  ordinary unit files retain parallel workers. Migration-replay suites cannot
  overlap the DB project or the earlier unit group.
- Package inheritance retains exact enabled-set assertions including api,
  identity and team. This checkout's fresh catalog actually defines api/identity
  as PLATFORM and has no team row, so the test explicitly reproduces the reported
  legacy baseline catalog, verifies sync preserves all three BASELINE sources,
  and restores the prior rows during cleanup. Product entitlements were unchanged.
- The 20,000-row medicine-search fixture now supplies its tenant ID. The RLS
  denials and p95 threshold remain intact. Returns services now use the same
  disposable URL checked by their safety assertions. The E2E seed's reserved
  local `module` variable was renamed without changing behavior.
- Fresh deploy applied **180 migrations, zero unfinished**, including
  `20261029100000_pharmacy_owner_identity` and all eight later migrations. No
  migration SQL change or migration-history repair was necessary.

## Results

- Typecheck with `NODE_OPTIONS=--max-old-space-size=8192`: passed.
- Full `bun run lint`: passed. ESLint over every changed TS/TSX file from
  `origin/develop`, plus the runner: zero errors, one pre-existing unused `_args`
  warning in `tests/production-bootstrap.test.ts:152`.
- Runner: **113 suites passed, 1 skipped; 2,175 tests passed, 6 skipped; zero
  failures** across 114 selected files. Selection covers all 84 changed Vitest
  files and all 44 pharmacy `*.db.test.ts` files, including
  `src/server/routers/pharmacy-branch-security.db.test.ts` tenant isolation,
  owner authorization, solo PIN/audit rollback and staffed approvals. There are
  49 conventional DB files in the selection, plus legacy RLS/integration files.
- The only skip is `tests/pharmacy-price-intelligence.integration.test.ts`:
  six existing tests require `WHA1606_DATABASE_TEST=1`, its reserved-port
  `wha1606_runtime` login, and preseeded `org_devfathom`/Alex fixture. This
  separate opt-in lane was not provisioned. No test was newly skipped; every
  pharmacy `*.db.test.ts` file executed. No other skips occurred.
- Post-test migration-history check: **zero unfinished migrations**.
- `git diff --check`: passed. Child output contained existing Vite config-loader
  and pg concurrent-query deprecation notices; neither was a test failure.

The first complete diagnostic run had 2,171 passes and three failures (the two
catalog assertions and fixture-owner SET ROLE permission). The final clean run
above supersedes it. Earlier harness setup attempts were corrected before this
acceptance run; no failed migration was marked resolved.
