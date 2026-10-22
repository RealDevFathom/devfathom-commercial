# Testing

> **Audience:** engineers and coding agents.
> **Based on:** `origin/main` @ `16a2a370` (2026-10-22).
> Related: [onboarding.md](./onboarding.md) · [contributing.md](./contributing.md)

DevFathom has about 120 test files in `tests/`, plus `*.test.ts` files colocated with source. The suites are Vitest for unit and database tests, Playwright for end-to-end tests, and dedicated tenant-isolation (RLS) checks.

---

## Test types

| Type | Where | Runner | Needs Postgres? |
|---|---|---|---|
| Unit | `tests/**`, colocated `*.test.ts` | Vitest 4.1.10 | No |
| Database | `*.db.test.ts` | Vitest | **Yes, a real Postgres** |
| Migration contract | `tests/` | Vitest | Yes |
| RLS / tenant isolation | `tests/` (per milestone), `scripts/` (verify-tenant-isolation) | Vitest / script | Yes |
| Restaurant acceptance and governance (M2–M8) | `tests/` | Vitest | TODO(confirm) |
| AWS context | `tests/aws-*_test.py` | Python | No. TODO(confirm): runner and version |
| End-to-end | `tests/e2e`, `playwright*.config.ts` | Playwright 1.62.0 | Yes, plus seeded data |

`bun run test` **skips** the database-backed suites unless `TEST_DATABASE_URL` is set; they report as skipped, not passed. That role must be neither `SUPERUSER` nor `BYPASSRLS`, or the RLS suites abort. See [LOCAL_SETUP.md](../LOCAL_SETUP.md).

## Commands

```bash
bun run test               # Vitest
bun run test:coverage      # Vitest with coverage
bun run test:rls           # scripts/verify-tenant-isolation.ts; disposable TEST_DATABASE_URL only
bun run test:e2e           # Playwright, default config
bun run test:e2e:agency
bun run test:e2e:restaurant-integrated
bun run test:e2e:pharmacy-counter
bun run test:e2e:platform-control-plane
```

Use `bun run test`, not `bun test`. The bare form runs Bun's built-in test runner, not Vitest.

### Playwright configs

At the repo root there are six configs: `playwright.config.ts` (default), and `playwright.{agency,pharmacy-counter,pharmacy-purchasing,restaurant-integrated,restaurant-sales-demo}.config.ts`. A seventh, `tests/e2e/platform-control-plane.config.ts`, is used by `test:e2e:platform-control-plane`.

The `agency`, `restaurant-integrated` and `pharmacy-counter` scripts go through runners in `scripts/run-*-e2e.ts` (with matching `preflight-*` scripts). `pharmacy-purchasing` and `restaurant-sales-demo` have no package script. TODO(confirm): how to run them (presumably `bunx playwright test --config <file>`).

### E2E data

E2E runs expect seeded fixtures:

- Pharmacy: `scripts/seed-pharmacy-e2e.ts` (the `pharmacy-counter-e2e` demo org)
- Agency: `scripts/seed-agency-e2e.ts`
- Restaurant: `prisma/seed-demo/restaurant.ts` (`bun run demo:seed`)

TODO(confirm): whether the e2e runners in `scripts/` seed automatically.

## What to test when

| You changed… | Add or run |
|---|---|
| Pure domain logic in `src/lib` | Unit tests |
| A router or query touching the database | `.db.test` against real Postgres |
| A migration | Migration-contract test, and `test:rls` |
| A **new tenant-scoped table** | An RLS test proving org A cannot read or write org B's rows |
| ABAC / capabilities | Tests for exact grant, wildcard denial and the default role (see [auth-and-roles.md](./auth-and-roles.md#for-developers)) |
| A user-visible flow | The relevant Playwright suite |

## Rules

- **Never weaken or skip an RLS test to make a build green.** A failing RLS test means a possible cross-tenant leak.
- Test databases must be built **from migrations** (`db:push` is disabled), or RLS is not present.
- No real credentials or production data in fixtures. Use the seed scripts.

## CI

- **`qa.yml`** is the QA gate. It triggers on pushes to `restaurantv2`, pull requests into `integration/**`, and manual dispatch with an optional SHA. It does **not** run automatically on PRs into `main` today. TODO(confirm): when it will be retargeted.
- **`image-build.yml`** runs on every pull request (build only; it does not push or deploy).
- **Docs-only PRs skip QA** but still need a secrets check. There is no gitleaks workflow on `main`, so run `gitleaks` locally before opening the PR. TODO(confirm): whether a CI secrets scan will be added.

See [contributing.md](./contributing.md#ci) for how this fits the PR flow.
