# WHA-1591 bounded implementation evidence

Base: `89f39834e7688c7f93dc467b945c980ada708463`.
Owned worktree: `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex-WHA-1591-controlled-interlock`.
Branch: `codex-WHA-1591-controlled-interlock`.
Disposition: incomplete; board review after the authorized additional correction pass (see latest evidence below).

## Change

Before: counter addLine had no controlled authorization; the register AFTER INSERT serial check included NEW and rejected insertion; register had no print action.
After (implementation, not full acceptance): server requires Rx, patient CNIC, independent active staff PIN and pharmacy:dispense capability. Existing bcrypt/lockout primitives are reused; failed attempts return a denial so counters commit. Prescription quantity, validity and consent are checked. Stock allocation, fill, pharmacist signature and register rows share a transaction. Counter collects authorization and clears PIN after attempts. Register opens a printable page. New migration excludes NEW from the prior-serial calculation while preserving other checks. Offline policy was not modified.

## Commands and results

All repository commands ran in the owned worktree. Disposable PostgreSQL used 127.0.0.1:55691 / wha1591_disposable. Owner wha1591_owner: LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE; runtime wha1591_runtime: LOGIN NOSUPERUSER NOBYPASSRLS. `caffeinate -dimsu` wrapped PostgreSQL. No shared database was used.

- `df -h /`: exit 0; 36 GiB before implementation, 17 GiB before browser compilation, 21 GiB at final inspection.
- `bun install --frozen-lockfile` (prior heartbeat): exit 0; 1294 packages installed, Prisma client generated.
- `initdb -D "$PAPERCLIP_RUN_SCRATCH_DIR/pgdata" -A trust --no-locale`: exit 0. First startup failed, exit 1, because scratch path exceeded Unix socket length. Corrected once using `postgres -h 127.0.0.1 -p 55691 -k ''` under caffeinate; server started.
- `EXTENSION_ADMIN_DATABASE_URL=postgresql://Saad@127.0.0.1:55691/wha1591_disposable bunx tsx prisma/prepare-extensions.ts`: exit 0.
- `DATABASE_URL=postgresql://wha1591_owner@127.0.0.1:55691/wha1591_disposable bunx prisma migrate deploy`: exit 0; all migrations applied, including the new migration. See migrate.log.
- Runtime grants issued through psql: exit 0. `PHARMACY_E2E=1 PHARMACY_E2E_DATABASE_URL=<runtime URL> DATABASE_URL=<runtime URL> PHARMACY_E2E_ADMIN_EMAIL=controlled-cashier@example.test PHARMACY_E2E_ADMIN_PASSWORD=<disposable test password> bunx tsx scripts/seed-pharmacy-e2e.ts`: exit 0. See seed.log.
- `NODE_OPTIONS=--no-experimental-webstorage bunx vitest run tests/pharmacy-controlled-interlock.test.ts`: exit 0; initial 4/4 passed.
- `NODE_OPTIONS=--no-experimental-webstorage bunx vitest run tests/pharmacy-controlled-interlock.test.ts src/server/routers/pharmacy-sales.tender-outcome.test.ts`: exit 0; expanded 50/50 passed across 2 files. See interlock-tests.log.
- `PHARMACY_E2E=1 PHARMACY_E2E_DATABASE_URL=<runtime URL> NODE_OPTIONS=--no-experimental-webstorage bunx vitest run tests/pharmacy-controlled-register.db.test.ts`: exit 0; 1/1 passed. Proves consecutive entries, skipped-serial rejection, balance decrement, no reconciliation incident; transaction rolled back. See register-db.log.
- `PHARMACY_E2E=1 PHARMACY_E2E_DATABASE_URL=<runtime URL> DATABASE_URL=<runtime URL> NODE_OPTIONS=--no-experimental-webstorage bunx vitest run tests/pharmacy-controlled-sale.db.test.ts`: exit 1; 0 passed, 1 failed. Router returned authorization denial. Diagnostic psql count found 0 organization_role_permissions for the fixture administrator role; credential failedAttempts=0 and lockedUntil=null. Missing capability grant is a fixture gap; successful authorization remains unproven. See sale-db.log.
- `bunx playwright test --config=playwright.pharmacy-counter.config.ts --grep 'controlled interlock'` with PHARMACY_E2E=1, PHARMACY_E2E_DATABASE_URL/DATABASE_URL/TEST_DATABASE_URL=<runtime URL>, matching disposable seed credentials, AUTH_TRUST_HOST=true, a disposable AUTH_SECRET, PLAYWRIGHT_PORT=4391, NODE_OPTIONS=--max-old-space-size=2048: first exit 1, 0 passed/1 failed, fixture incorrectly used medicines table. Single correction pass fixed table to pharmacy_medicines and made unit selector match its accessible label. Final run exit 1, 0 passed/1 failed: signIn expected /dashboard|pharmacy/, remained at http://127.0.0.1:4391/login after 30000 ms. See e2e.log and e2e-final.log.
- Initial `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit --pretty false`: exit 0, zero diagnostics. Final rerun after additional test source is recorded separately below.
- Scoped `bunx eslint` on 5 changed production TS/TSX files plus changed test files: exit 0, zero diagnostics. `bunx prettier --write` on changed TS/TSX files: exit 0. `git diff --check`: exit 0.
- `pg_ctl -D "$PAPERCLIP_RUN_SCRATCH_DIR/pgdata" stop -m fast`: exit 0; disposable database stopped.

## Remaining and risks

No successful end-to-end controlled sale, print verification, or responsive/theme/keyboard visual matrix yet. No production build run because acceptance is unresolved. PIN provisioning relies on existing staff credentials plus an explicit pharmacy:dispense grant; the acceptance fixture omitted that grant. No claim of legal compliance or release readiness. No push, merge, deployment, or existing migration modification.

Next bounded pass needs board authorization under the one-correction-pass contract: repair the test pharmacist capability grant, diagnose the browser login failure, and rerun successful interlock/printing acceptance and visual checks. Keep server authorization intact. Existing migration regression evidence can be reused if migration stays unchanged.

Recovery: local branch only. No shared database changes; disposable database stopped. Do not deploy this incomplete branch.

Final verification: full `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit --pretty false` exited 0, zero diagnostics, after all test additions. Final scoped ESLint exited 0, zero diagnostics.

## Authorized correction pass — 2026-09-29

Starting HEAD: `46158ab85af9ca621273db63fbac0226f04e3fd5`; original base remains above.
Board authorization: comment `7eb32c04-3610-4032-a4c8-64f5814166a5`.
Only code change: `tests/e2e/pharmacy-controlled-fixture.ts` grants the existing fixture role `pharmacy:dispense` with effect ALLOW. Production authorization is unchanged.

- `df -h /`: exit 0, 51 GiB free both before setup and browser compilation.
- New run-owned disposable PG initialized with `initdb -D "$PAPERCLIP_RUN_SCRATCH_DIR/pgdata" -A trust --no-locale`: exit 0. Started under `caffeinate -dimsu postgres` on loopback 55691, Unix sockets disabled. Owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE; runtime LOGIN NOSUPERUSER NOBYPASSRLS.
- `EXTENSION_ADMIN_DATABASE_URL=<disposable admin URL> bunx tsx prisma/prepare-extensions.ts`: exit 0. `DATABASE_URL=<disposable owner URL> bunx prisma migrate deploy`: exit 0. Runtime grants through psql: exit 0. `bunx tsx scripts/seed-pharmacy-e2e.ts` with guarded disposable runtime environment: exit 0.
- Seed and browser both used the exact counter CI login settings from `.github/workflows/qa.yml:296`, via one run-owned environment file. No secret or login override was added to the repository.
- `NODE_OPTIONS=--no-experimental-webstorage bunx vitest run tests/pharmacy-controlled-sale.db.test.ts`: exit 0, **1/1 passed**, one test file. See `sale-db-correction.log`. This proves atomic authorized allocation, fill, signature and running balance reconciliation; transaction rolled back.
- `bunx prettier --check tests/e2e/pharmacy-controlled-fixture.ts`: exit 0, all matched files formatted. `bunx eslint tests/e2e/pharmacy-controlled-fixture.ts`: exit 0, zero diagnostics. `git diff --check` before evidence additions: exit 0.
- `NODE_OPTIONS=--max-old-space-size=2048 bunx playwright test --config=playwright.pharmacy-counter.config.ts --grep 'controlled interlock'`: exit 1, **0/1 passed**, login remained `/login` after 30000 ms. See `browser-correction.log`. No login timeout change.
- Trace network extraction (Python zipfile/json): exit 0. See `browser-network-correction.log`: GET /login 200 in 88 ms; POST /login 200 in 37 ms; no /api/login request. This suggests native form submission before JavaScript hydration, not slow authentication; root cause not fully proven. Original failed trace/screenshot remain in `playwright-artifacts/pharmacy-counter/` (ignored artifacts).

No further correction or browser rerun in this bounded pass. Browser success, controlled UI acceptance and printing remain unverified. No production build or repeat full typecheck; previous TypeScript evidence remains applicable to unchanged production code. Prior base-to-HEAD raw-log whitespace diagnostics remain outside this correction's scope. Board review must decide the next action for browser login synchronization. No push, merge or deploy.

Cleanup: `pg_ctl -D "$PAPERCLIP_RUN_SCRATCH_DIR/pgdata" stop -m fast` exit 0; database stopped. Final correction diff check: `git diff --check` exit 0.
