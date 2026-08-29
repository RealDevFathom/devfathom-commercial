# M9 final verification evidence

## Verdict

**FAIL** at cut `8a46543565edd47a616288eecb7e1d10082d2d31` on 2026-08-29.

This is the one consolidated M9-L9 verification pass. The release tag is not authorized. No source
fix, merge, tag, deployment, remote synchronization, or shared-ref movement was performed.

## Cut and scope

- Supervisor-published cut: `8a46543565edd47a616288eecb7e1d10082d2d31`.
- Verified parent: `046fbff523a4e371141176e0854696f4067c2586`.
- Accepted M8/M9-union ancestor used for the milestone diff: `332318d`.
- L9 changed file: this evidence file only.
- `restaurant-management-system-plan.md` remains unchanged because the failed gates do not prove a
  status promotion.
- `BUILD-ASSUMPTIONS.md` was cross-checked and remains unchanged.

## Gate evidence

| Gate                         | Result  | Exact evidence                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh install                | PASS    | `bun install`: 1,209 packages installed; exit 0.                                                                                                                                                                                                                                                          |
| Prisma generate              | PASS    | Prisma Client 7.9.1 generated; exit 0.                                                                                                                                                                                                                                                                    |
| Next type generation         | PASS    | `bunx next typegen`: “Types generated successfully”; exit 0.                                                                                                                                                                                                                                              |
| Empty-DB migration deploy    | NOT RUN | No `M8_TEST_OWNER_DATABASE_URL`, `TEST_DATABASE_URL`, `DATABASE_URL`, or `DIRECT_URL` was supplied.                                                                                                                                                                                                       |
| M8-tip migration deploy      | NOT RUN | Same missing PostgreSQL dependency.                                                                                                                                                                                                                                                                       |
| Full unit suite              | FAIL    | 3 failed files, 156 passed files, 44 skipped files; **6 failed / 1,999 passed / 602 skipped** tests. This does not match the sanctioned `8F / 2,139P / 159S` baseline. Five failures are in the DB-environment-dependent M8 battery/tax RLS suite; one is the excluded explicit-host test.                |
| `test:rls`                   | NOT RUN | Process exited before tests: `Error: TEST_DATABASE_URL is required; tenant isolation tests never use DATABASE_URL.`                                                                                                                                                                                       |
| Targeted M9 unit tests       | PASS    | 7 files passed; **134/134** tests passed. Covered KDS board, POS checkout, POS client store/queue, terminal customers, loyalty, and orders.                                                                                                                                                               |
| Security/governance subset   | PARTIAL | 2 files passed, 1 skipped; **10 passed / 13 skipped**. Skips are environment-gated, so this is not a complete security pass.                                                                                                                                                                              |
| Playwright, both projects    | FAIL    | After installing pinned Chromium, **22 passed / 2 failed / 26 skipped**. Desktop and mobile both time out in `staging-smoke.spec.ts` “a wrong password never reveals whether the account exists”: expected password input type `text`, received `password`.                                               |
| Axe/screenshots              | NOT RUN | M9 menu-import visual/axe cases were fixture-gated and skipped. Failure screenshots exist only for the two staging-smoke failures and are not axe acceptance evidence.                                                                                                                                    |
| Load smoke                   | NOT RUN | `restaurant-m9-load-smoke.ts` exits with `PLAYWRIGHT_BASE_URL is required`; the DB fixture variables are also absent.                                                                                                                                                                                     |
| Typecheck                    | PASS    | `bun run typecheck`; exit 0.                                                                                                                                                                                                                                                                              |
| Lint                         | PASS    | `bun run lint`; exit 0.                                                                                                                                                                                                                                                                                   |
| Production build             | FAIL    | First attempt compiled then stopped because `AUTH_SECRET` was absent. One environment-only recheck with a non-persisted verification secret compiled, passed TypeScript, then terminated with `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`. |
| Repository format check      | FAIL    | `bun run format:check`: 38 files reported style issues.                                                                                                                                                                                                                                                   |
| M9 changed-file format check | PASS    | All TypeScript/TSX/CSS files changed from `332318d` to the cut use Prettier style.                                                                                                                                                                                                                        |
| Dependency audit             | FAIL    | `bun audit`: **31 vulnerabilities (11 high, 17 moderate, 3 low)**.                                                                                                                                                                                                                                        |

## Strict parsing, money, storage-secret, and object-scope audit

The milestone diff was searched directly for added strict-Zod/parse, Decimal/money, storage/secret,
and tenant/object-scope lines. The respective review populations were 63, 71, 51, and 151 added
lines. The targeted M9 tests passed, but the DB-backed governance and RLS evidence did not execute
fully; therefore no complete security or tenant-isolation claim is made.

## Forbidden-scope diff proof

Against accepted ancestor `332318d`, D23 and `src/lib/tenancy/explicit-host.ts` plus its test are
untouched. The same milestone diff **does** contain:

- `prisma/schema.prisma`
- `prisma/migrations/20260827120000_restaurant_menu_ocr_import/migration.sql`

Consequently, the named literal proof of “no schema/migration” is not satisfied for the milestone
diff. L9 itself changes neither schema nor migrations.

## Findings and ownership

1. **High — release evidence cannot execute:** the supervisor/control-plane owner must provide the
   required owner/runtime PostgreSQL URLs and a seeded M9 application base URL, then return the task
   for the single correction/recheck pass.
2. **High — browser acceptance fails:** the owning staging-smoke implementation lane must reconcile
   the password-visibility readiness assertion on both Playwright projects without weakening the
   negative account-disclosure assertion.
3. **High — production build fails:** the owning build/integration lane must address the reproducible
   Next build heap exhaustion or provide the sanctioned build resource envelope.
4. **High — dependency audit fails:** the dependency-owning lane must adjudicate the 11 high, 17
   moderate, and 3 low advisories; L9 is not authorized to update dependencies.
5. **Medium — repository formatting gate fails:** the owning files/format lane must resolve or
   explicitly sanction the 38-file baseline. L9 makes no formatting repair.
6. **High — forbidden milestone diff is non-empty:** the supervisor must adjudicate whether the OCR
   schema/migration is authorized milestone scope or recut the milestone.

## Risk and rollback

Do not publish or deploy this cut while the verdict is FAIL. Recovery is a supervisor-owned recut or
one correction pass in each named owning lane, followed by one L9 recheck on an exact published SHA.
No rollback is needed for this verification pass because it changes documentation only.

## Tag preparation

Proposed annotated tag name after a passing recheck: `milestone/m9-pos-kds-client-hardening`.
Proposed target SHA if and only if this exact cut later passes: `8a46543565edd47a616288eecb7e1d10082d2d31`.
The tag was not created and is not currently authorized.
