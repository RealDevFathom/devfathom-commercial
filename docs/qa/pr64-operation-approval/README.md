# PR64 follow-up verification

Base: merged develop at `ddea7df2`. Changes retain existing recall/licence,
security-invoker statement, witness-PIN, purge-trigger and email fallback fixes.
AGENTS.md and Azure files, including deploy-staging.yml and promote-production.yml,
are unchanged.

The branch exemption now uses the active tenant's persisted system-owner identity
for branch reads and controlled-register scope, independently of session ADMIN.
Returns, refunds and batch overrides supply fresh approval credentials in SOLO and
STAFFED modes. STAFFED checkers retain independent identity, branch, role and PIN
checks; approval audit remains atomic with the document. PINs are cleared after
submission and excluded from persisted retry payloads; retries require re-entry.
The UI reuses Studio Input, Label, Button and Dialog plus existing semantic tokens.

AWS prepares the restricted runtime role before migrations. Preparation tolerates
an empty schema, safely quotes the current database name and preserves default
privileges for newly migrated tables. Host activation stops before migrations or
release switching if preparation fails. `docs/deploy-develop.md` documents the
restricted APP_DATABASE_URL setting needed by deployment.

Validation on 2026-10-29:

- Typecheck with `NODE_OPTIONS=--max-old-space-size=8192`; lint; production webpack
  build passed. The default Turbopack build cannot resolve the environment's shared
  node_modules symlink. No application build configuration was changed.
- Changed and related Vitest: 592 passed, zero skipped, including fresh SOLO/STAFFED
  UI and router regressions, owner scope, role preparation, deploy failure ordering,
  existing Rx, witness, email and inventory checks.
- Fresh isolated local PostgreSQL: wallet bridge 44, reporting 36, wallet security
  8, receipt authorization 1 and branch security 13 passed (102 total), zero skipped.
  Full tenant-isolation verification also passed after seeding that disposable DB.
  The verifier requires FORCE RLS for tables and security_invoker for tenant views.
- `scripts/verify-pharmacy-wallet-db.cjs` creates a private Unix-socket cluster,
  applies every migration, checks idempotent role preparation before schema creation,
  runs both destructive wallet opt-ins as a restricted role, checks every requested
  suite ran with zero skips, verifies tenant isolation, then destroys the cluster.
  DATABASE_URL is required and validated as local; connection strings are never
  printed or saved. CI uploads its logs under gate/pharmacy-wallet-db.
- Interactive browser matrix: 32 passed, zero skipped (375/768/1024/1440, light/dark,
  normal/reduced motion, SOLO/STAFFED). Actual production components and Studio CSS,
  mocked RPC data. Checked loading/empty/error/disabled states, masked PIN and purge,
  refund completion, keyboard order, Escape/focus restoration, bounded layout, no
  render errors and WCAG axe checks. Representative screenshots and the matrix are
  beside this report. Authenticated route/network acceptance was not exercised.

Dependency audit: Zod resolves exclusively to 4.6.7, with a direct minimum of
4.6.6. Updating shadcn removes its Zod 3 dependency; a scoped Vercel CLI override
removes its pinned Zod 4.1.11 copy. Typecheck found no application type fallout.
`bun audit --json` reports no Zod findings and no newly affected packages relative
to the base lockfile: affected packages decreased from 14 to 9. Remaining 21
advisories are in @azure/msal-node, @vitest/mocker, deepmerge, deepmerge-ts,
fast-uri, qs, systeminformation, vite and vitest. Azure dependencies were not
upgraded as part of this work.

An additional initializer snapshot check (`python3 tests/aws-context_test.py`)
passed 24/25 checks; its initializer manifest assertion fails against the composed
application checkout with extensive pre-existing pin differences. Initializer
manifests were left unchanged. This is separate from the passing deployment and
runtime-role regressions above.
