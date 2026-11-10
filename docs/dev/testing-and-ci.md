# Testing and CI

> Checked against `develop` at `1906b530` on 10 Nov 2026 (PKT). Counts: 1178 Vitest test files (145 of them `*.db.test.ts`) and 40 Playwright specs under `tests/e2e`.

## Test types

| Kind | Files | Run with | Needs |
|---|---|---|---|
| Unit / component | `*.test.ts(x)`, mostly next to the source | `bun run test` (Vitest 5); `bun run test:watch`; `bun run test:coverage` | Nothing external |
| Database | `*.db.test.ts` | Included in `bun run test`. They **skip themselves** when their database URL isn't set, so a green local run may not have run them. | A migrated Postgres. Set `TEST_DATABASE_URL`, or the suite-specific URL named at the top of the file, to a **non-superuser runtime role** so RLS actually applies. |
| RLS / tenant isolation | `scripts/verify-tenant-isolation.ts` | `bun run test:rls` | A migrated database. It creates its own NOLOGIN role. |
| Browser (E2E) | `tests/e2e/*.spec.ts`; configs `tests/e2e/{platform-control-plane,restaurant-acceptance,restaurant-growth,time-to-first-sale,login-redesign}.config.ts` | `test:e2e:platform-control-plane`; `test:e2e:agency`; `test:e2e:restaurant-integrated`; `test:e2e:pharmacy-counter` | A built app, a database and Chromium (`bunx playwright install chromium`). The runners in `scripts/run-*-e2e.ts` provision their own fixtures. There's no root `playwright.config.ts`, so plain `bun run test:e2e` runs without a config. Use the named scripts or `--config`. |
| AI provider smoke | `scripts/ai-provider-smoke.ts` | `bun run ai:smoke` | A configured provider. Not part of CI. |

Static checks: `bun run typecheck` (`tsc --noEmit`; give it memory with `NODE_OPTIONS=--max-old-space-size=8192` or more), `bun run lint` (ESLint on `src/`), `bun run format:check` (Prettier on `src/`).

### Writing tests

- Every authorization change needs a refusal test: wrong capability, wrong branch, wrong tenant, and the `*`-admin-without-exact-grant case for regulated pharmacy actions.
- Every new tenant table needs an RLS test that a second organization can't read or write it.
- Money and stock changes need a `*.db.test.ts` that runs on a real database, not only mocks.
- Use fixtures and demo organizations. **Never use real customer data or logins.**

## CI (GitHub Actions)

> **Status on 10 Nov 2026: GitHub Actions is disabled for this repository** (`actions/permissions` → `enabled: false`). None of the workflows below are running. A green check on a PR doesn't exist today, so **run the checks locally and paste the results into the PR body.** TODO(confirm): when, and where, CI will run again.

| Workflow | Trigger | What it does |
|---|---|---|
| `qa.yml` (QA gate) | Push to `develop` (and `restaurantv2`); PRs into `develop`, `staging`, `main`, `integration/**` **only when the PR has the `ci-ready` label**; manual | **Automated gate:** migrate deploy on fresh Postgres databases with non-superuser roles, Prisma generate, runtime grants, the full Vitest run plus reserved DB suites (reports, boundary, growth, catering, cohort, receipts), `test:rls`, lint and typecheck. **Browser gate:** clean build, provisioning, then the restaurant, catering, platform, agency and pharmacy counter (time-to-first-sale) lanes. Evidence is uploaded as artefacts. |
| `image-build.yml` | PRs with `ci-ready` | Builds the container image on native amd64. Pushes nothing. |
| `deploy-develop.yml` | After a successful QA gate on a push to `develop`, or manual | Deploys `develop` to the develop environment. Infrastructure details are CTO-owned. |
| `deploy-staging.yml` | Manual only | **Still targets the retired Azure staging. Don't run it.** |
| `promote-production.yml` | Manual, with an image digest | **Still references Azure. Don't run it.** Production promotion is Saad's call. Azure removal: DEV-755 / #1437. |

Before you open a PR, run at least `typecheck`, `lint`, `format:check` and `test`, plus `test:rls` and the relevant DB and E2E suites for the area you changed.
