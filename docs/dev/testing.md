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
| Migration contract | `tests/` | Vitest | SQL text assertions need no DB; execution tests need Postgres |
| RLS / tenant isolation | `tests/` (per milestone), `scripts/` (verify-tenant-isolation) | Vitest / script | Yes |
| Restaurant acceptance and governance (M2–M8) | `tests/` | Vitest | Database batteries need Postgres; inspect each suite's environment requirements |
| AWS context | `tests/aws-*_test.py` | Python 3 `unittest` | No; some cases need preserved initializer source/context fixtures |
| End-to-end | `tests/e2e`, `playwright*.config.ts` | Playwright 1.62.0 | Yes, plus seeded data |

Most database-backed Vitest suites use `TEST_DATABASE_URL`; others need suite-specific URLs, sometimes both an owner and a runtime connection (for example `WHA910_TEST_OWNER_DATABASE_URL` / `WHA910_TEST_RUNTIME_DATABASE_URL`, or `M8_TEST_OWNER_DATABASE_URL` / `M8_TEST_RUNTIME_DATABASE_URL`). Read the selected suite's environment requirements before running it. Missing URLs cause those suites to report as skipped, not passed; setting `TEST_DATABASE_URL` alone does not enable every database suite. Runtime connections must be neither `SUPERUSER` nor `BYPASSRLS`, or the RLS suites abort. See [LOCAL_SETUP.md](../LOCAL_SETUP.md).

The standalone `bun run test:rls` verifier has different requirements: its `TEST_DATABASE_URL` must be a setup connection to a disposable, migrated and seeded database, able to create and grant roles and `SET ROLE`. It creates its own restricted role for the isolation probes. Do not use the app's restricted runtime connection for this script.

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

Run the AWS Python files directly (their hyphenated filenames are not discovered by `unittest discover`):

```bash
for test_file in tests/aws-*_test.py; do
  python3 "$test_file" || exit 1
done
```

The initializer cases may require `INITIALIZER_SOURCE_ROOT`, `LEGACY_INITIALIZER_SOURCE_ROOT` and `INITIALIZER_TEST_CONTEXT` pointing to the preserved fixtures; inspect the selected file for its requirements.

### Playwright configs

At the repo root there are six configs: `playwright.config.ts` (default), and `playwright.{agency,pharmacy-counter,pharmacy-purchasing,restaurant-integrated,restaurant-sales-demo}.config.ts`. A seventh, `tests/e2e/platform-control-plane.config.ts`, is used by `test:e2e:platform-control-plane`.

The `agency`, `restaurant-integrated` and `pharmacy-counter` scripts go through runners in `scripts/run-*-e2e.ts` (with matching `preflight-*` scripts). `pharmacy-purchasing` and `restaurant-sales-demo` have no package script. TODO(confirm): how to run them (presumably `bunx playwright test --config <file>`).

### E2E data

E2E runs expect seeded fixtures:

- Pharmacy: `scripts/seed-pharmacy-e2e.ts` (the `pharmacy-counter-e2e` demo org)
- Agency: `scripts/seed-agency-e2e.ts`
- Restaurant: `scripts/seed-restaurant-e2e.ts` (the demo seed `bun run demo:seed` alone does not supply the complete acceptance fixtures)

The agency, pharmacy-counter and restaurant-integrated runners run preflight, then seed twice to verify idempotency, then start Playwright. Use their package scripts with the disposable databases and environment required by each runner.

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

- **`qa.yml`** is the QA gate. It triggers on pushes to `restaurantv2`, pull requests into `integration/**`, and manual dispatch with an optional SHA. It does **not** run automatically on PRs into `develop`, `staging` or `main` today.
- **`image-build.yml`** runs on every pull request (build only; it does not push or deploy).
- **Docs-only PRs skip QA** but still need a secrets check. There is no gitleaks workflow on `main`, so run `gitleaks` locally before opening the PR. There is no CI secrets scan yet.

See [contributing.md](./contributing.md#ci) for how this fits the PR flow.
