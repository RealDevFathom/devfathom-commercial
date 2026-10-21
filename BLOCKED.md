# Blocked: restaurant SEV2 QA fixes

Stopped under the explicit rule to stop after two failed attempts at the same problem.

## Completed

- Read AGENTS.md and the complete Studio design contract, installed dependencies with `TMPDIR=/tmp bun install`, and read installed Next.js route and notFound guidance.
- Read issues #146, #147, #148, #149, and #151 in full through `/usr/local/bin/gh api`, including their comments endpoints (all had no comments). `gh issue view --comments` returned no output.
- Fixed #146 in commit `03823c8b`: workspace invitations now use the Administration entitlement rather than HR. The existing administrator authorization and seat limits remain enforced. Regression tests now invoke the fully namespaced tRPC route so the entitlement middleware actually executes.
- Passed: `TMPDIR=/tmp bun run test src/server/routers/team.invite.test.ts src/server/routers/team.account.test.ts src/server/trpc.test.ts src/lib/module-catalog.test.ts` — 4 files, 264 tests.

## Failure requiring the prescribed exit

Issue #147 requires duplicate organization slugs to return a friendly conflict. A proposed change mapped Prisma `P2002` with `meta.target` containing `slug` to HTTP 409. Its mocked regression passed, but real PostgreSQL verification did not.

A disposable database `restaurant_sev2_test` was created with role `restaurant_sev2_app` (`NOSUPERUSER NOBYPASSRLS`). All 152 migrations applied successfully; FORCE RLS was retained. The database test checked role enforcement before executing the real control route and platform command.

1. First database test attempt returned HTTP 400 because its restaurant payload omitted primary contact and first-branch fields. The fixture was corrected against `organizationInput`.
2. Second database test attempt reached the real unique violation but returned HTTP 500. Prisma 7.9.1 with the installed Postgres adapter supplied `meta.modelName: Organization` and `meta.driverAdapterError`, without `meta.target`. Consequently the proposed predicate did not recognize the slug conflict.

No third attempt was made. Uncommitted partial changes and test fixtures for #147 and #148 were removed before this report; only the completed #146 change remains. A future authorized attempt should inspect the adapter's structured constraint cause and map only the slug constraint while retaining transaction rollback and failure auditing.

## Remaining work

- #147: implement and verify the adapter-compatible duplicate slug conflict with real Postgres.
- #148: map missing/expired/ambiguous tax profile errors at the checkout transport boundary to actionable client errors without leaking internal identifiers. The original mapper returned null in the reproduction.
- #149: gate the POS page on effective restaurant-pos entitlement while retaining device-only terminal access.
- #151: verify the reported host mismatch and correct-host login redirect. The current tenant actor resolver already compares session organization against host organization.
- Required final typecheck, broader affected tests, DB/RLS verification, and applicable UI QA have not been completed.
- No success PR was created because all five fixes and required checks are incomplete. No other branch was mutated, no merge occurred, and WhatsApp medicine promotion behavior was unchanged.
