# HANDOFF — claude-labelled Linear batch

Last updated: 2026-11-02 22:10 UTC · Branch: `saad/nice-thompson-99m17p` · PR:
[RealDevFathom/devfathom-commercial#1223](https://github.com/RealDevFathom/devfathom-commercial/pull/1223)
(into `develop`, open, not merged)

## Resume here

DEV-576 is done and deployed to develop. It lives on PR #1238, branch
`feat/dev-576-ai-providers`, with its own HANDOFF. This batch resumed at 21:47 UTC.

- **Integrated and pushed (21:48 UTC, head `3a578a60`):** the 14 finished agent commits, with
  trailers stripped; 184/184 touched tests pass.

  | Group     | Commits                                                                | Issues                                                           |
  | --------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
  | reports   | `6e86f60e`, `93c08770`, `de24163b`                                     | DEV-595, DEV-601 work pack, DEV-596                              |
  | marketing | `4e8c2cec`, `c07c8605`, `64ff270c`, `bdc8081a`, `33a76c92`             | DEV-606, DEV-591, DEV-597, DEV-601 marketing                     |
  | panel     | `e2a76920`, `116f2830`, `6b43e67d`, `90894229`, `28c932c0`, `3a578a60` | DEV-584/605, DEV-599, DEV-598, DEV-603, DEV-600/592/593, DEV-604 |

- **Linear:** a ✅ Finished comment is posted on all 17 issues: DEV-595, 601, 596, 606, 591,
  597, 584, 605, 599, 598, 603, 600, 592, 593, 604, 602 and 594. No status was changed.
- **Fixes integrated and pushed (22:05 UTC, head `bc50cd65`):**
  - `9bf8e9a0`: the migrations.
    - Security finding 2 (explicit `BEGIN`/`COMMIT`) and finding 3 (idempotent re-runs). Every
      changed file re-runs cleanly; there are 171 + 125 DB tests.
    - Honest custody and audit-trigger comments.
  - `f80590a9` (DEV-249): the meeting forms gain an End date and judge full instants. A meeting
    that crosses midnight is allowed. **The Studio visual QA matrix for the new End date field
    is not done yet.**
  - `8089090f` (DEV-347): the seed's P2002 hint lists the documented rebuild.
  - `bc50cd65` (DEV-582): Ask Fathom pharmacy tools answer in the workspace locale. The growth
    cards and marketing assist remain, so a progress comment was posted, not Finished.
  - Tests: 197 + 417 related tests pass. A full tsc run is in progress (scratchpad
    `pr1223-tsc.txt`).
- **#1223:** a reply to the security review is posted
  (https://github.com/RealDevFathom/devfathom-commercial/pull/1223#issuecomment-6589646259),
  with a re-run requested.
- **Full tsc at `bc50cd65`:** only the 4 baseline errors develop also has.
- **PR #1223 body:** rewritten at 22:10 UTC with both batches, the fixes, the open decision and
  the follow-ups.
- **Remaining on this PR:**
  - Security finding 1 (needs the user's decision).
  - The Studio visual QA for the meetings End date field.
  - The QA/Security re-run.
- **Waiting on the user:** security finding 1. The append-only trigger on `audit_logs`
  conflicts with #1165's retention DELETE. Proposal: a narrow carve-out under
  `app.retention_purge_organization_id`.
- **Follow-ups to propose, not in this PR:**
  - The pharmacy purge is blocked by `pharmacy_reject_append_only_change`.
  - Invoice numbers collide across tenants.
- **Uncommitted / half-written:** nothing in this checkout.

## Rules in force

- PRs into `develop` only. Never merge. Never force-push or rewrite pushed commits. No
  GitHub Actions runs.
- Commit messages are plain: no Co-Authored-By line, no model name, no Claude-Session
  link. This applies from `09c6e54b` onward; the 14 earlier commits keep their old
  trailers by instruction and are not rewritten.
- Linear: do not change any issue's status. Mark an issue finished with a "✅ Finished"
  comment (PR link + commit + what changed), and post a progress comment when status
  changes.
- UI work: read `docs/design-system/DEVFATHOM-STUDIO.md` first and do its visual QA matrix.

## Items

Status key: done = committed and pushed to PR #1223, with a "Finished" comment on Linear.

### Done — code changes on PR #1223

| DEV                       | GitHub     | Commit(s)              | Summary                                                                                                                                                                            |
| ------------------------- | ---------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEV-577                   | —          | `2013e66f`             | Stale router test given a valid witness. Kept #911's witness-first order.                                                                                                          |
| DEV-155                   | #620       | `22e3e9cd`             | Migration `20261102090000`: `audit_logs` append-only trigger (55000). Allowed exceptions: FK SET NULL of a deleted actor, sanctioned purge, orphaned rows.                         |
| DEV-325, DEV-329          | #340, #334 | `7ccc1050`             | Auth placeholders/divider and platform form help `text-text-faint` → `text-text-muted` (5.27:1 light / 6.60:1 dark).                                                               |
| DEV-344                   | #315       | `7de50f12`             | Operator reset sets `mustChangePassword`, emails the user via `afterCommit`, page `confirm=`.                                                                                      |
| DEV-124                   | #657       | `c866c940`             | Migration `20261102090100`: composite FK custody `witnessId` → `users`, NOT VALID then conditional VALIDATE. Fixed 5 stale stock-ledger DB fixtures.                               |
| DEV-140                   | #640       | `435dea3c`             | API docs meetings row fixed and pinned by `tests/api-docs.test.ts`.                                                                                                                |
| DEV-312                   | #359       | `ba9cc8f2`             | `consentKeyword` regression tests. The reported migration does not exist.                                                                                                          |
| DEV-249                   | #451       | `ee72fb3e`             | Meetings end > start on every path. Migration `20261102090200` repairs bad rows and adds a CHECK.                                                                                  |
| DEV-348                   | #311       | `922ad66e`             | `prisma/load-env.ts`: real env > `.env.local` > `.env`. Missing-URL error. Docs.                                                                                                   |
| DEV-347                   | #312       | `8fabfc81`             | Seed runs in two transactions, logs the operator outcome, P2002 hint, `db:reset` chains the seed. **Caveat:** `prisma migrate reset` itself drops the extensions; see LOCAL_SETUP. |
| DEV-243                   | #458       | `ed306846`, `f285299a` | Invoice print shows the agency issuer. Migration `20261102090350` adds `invoiceAddress` / `invoiceTaxId`.                                                                          |
| DEV-252                   | #448       | `7eeda02a`             | Tax and discount. Shared cent-exact `invoice-amounts.ts`. Migration `20261102090400`.                                                                                              |
| DEV-250                   | #450       | `09c6e54b`             | `Task.completedAt` kept on every write path; stats read it. Migration `20261102090300` with backfill.                                                                              |
| DEV-579, DEV-580, DEV-581 | #1042      | `47d1a33d`             | Expiry advisor SQL: real table and column names, explicit tenant and branch scope. Postgres tests.                                                                                 |

### Done — verified already fixed on develop (no code; "Finished" comment posted)

- DEV-137
- DEV-191
- DEV-297 (superseded by `prisma/prepare-extensions.sql`)
- DEV-310
- DEV-337
- DEV-346
- DEV-308 (only the failures it names; see Known failures)

### Blocked — human-only ops (comment posted, not marked finished)

- **DEV-336:** SCIM credential rotation and remediation. Must be run by a human against
  the live deployments.
- **DEV-341:** staging Bicep what-if drift. Needs Azure access and someone to decide on
  each change.

### In progress — local agent worktrees, not yet on the branch

| DEV                                                                             | Scope (files)                                                                                                                                                     | Next step                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEV-583, DEV-582                                                                | `src/lib/ai/**`, `src/app/api/assistant/**`, `askFathomSettings` in `src/server/routers/organization-admin.ts`, launcher in `src/components/layout/app-shell.tsx` | One shared provider-availability function; settings report unavailable, launcher disabled. Thread locale into every pharmacy AI tool.                                                 |
| DEV-584, DEV-592, DEV-593, DEV-598, DEV-599, DEV-600, DEV-603, DEV-604, DEV-605 | `src/components/assistant/assistant-panel.tsx` and children                                                                                                       | Focus input on open; block duplicate submit; keep the conversation per session; theme via tokens; `dir="auto"`; role-aware empty state with examples; plain error message plus Retry. |
| DEV-591, DEV-597, DEV-606, DEV-601 (marketing half)                             | `src/app/(app)/pharmacy/marketing/**`                                                                                                                             | Plain inputs with defaults (PKT dates → UTC); name the missing requirement on denial; dark-mode contrast.                                                                             |
| DEV-595, DEV-596, DEV-601 (work-pack half)                                      | `src/app/(app)/pharmacy/reports/**` (`daily-work-pack.tsx`, `replenishment/**`)                                                                                   | Map enums to plain labels; one short missing-source note; PKT date picker; contrast.                                                                                                  |
| DEV-594, DEV-602                                                                | `src/app/(app)/dashboard/pharmacy-dashboard-content.tsx`, dashboard data and layout save, labels in `src/lib/pharmacy/reports.ts`                                 | Cashier: no owner title or edit mode; check that the layout-save authorization is server-side; plain labels instead of table/permission keys; entry links to advice.                  |

**Integration recipe** for each finished worktree commit:

```bash
git cherry-pick --no-commit <sha>
git log -1 --format=%B <sha> | grep -viE '^(co-authored-by|claude-session):' > /tmp/msg
git commit -F /tmp/msg
```

Then:

- rerun that commit's tests;
- scan the new commit messages with
  `git log --format=%B origin/saad/nice-thompson-99m17p..HEAD | grep -iE 'co-authored|claude-session|opus|sonnet'`, which must print nothing;
- push;
- post a "Finished" comment on each DEV issue.

**Migration timestamps already used on this branch:** `20261102090000`, `…090100`,
`…090200`, `…090300`, `…090350`, `…090400`. Use a later value for any new migration.

## Reviews

PR #1223 at head `6b20958a` (mergeable, clean):

| Check                                              | Verdict                          | Notes                                                                 |
| -------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| Machine checks (GitHub check runs)                 | none reported                    | No check runs are attached to this PR. `qa.yml` did not run on it.    |
| Codex code review                                  | ✅ no findings                   | At `8fabfc81`. Re-runs on each push.                                  |
| Codex security review                              | ✅ completed, no findings posted | At `8fabfc81`.                                                        |
| Security review comment (19:16 UTC, at `b5e29ad0`) | ⚠️ 3 findings + 1 note           | See the list below the table. Not a merge verdict.                    |
| QA (human)                                         | not started                      | —                                                                     |
| Internal adversarial review (first 10 commits)     | done                             | 3 confirmed low findings plus 1 disputed. Queued under "Resume here". |

Security review findings, verified against the files on 2026-11-02:

1. **Retention vs append-only, blocking a merge of either PR.**
   - Draft #1165 (DEV-96) expects a plain `DELETE` of expired audit rows of a live tenant to
     succeed. Its fixture also expects it for non-pharmacy audit rows.
   - Our `audit_logs_append_only` trigger (`090000`) refuses that.
   - **Proposed carve-out, waiting on the user's decision:** allow `DELETE` (never `UPDATE`)
     only when `app.is_platform_admin` is set and `app.retention_purge_organization_id`
     equals `OLD."organizationId"`. #1165's coordinator sets that flag inside its
     transaction, and its own guard still enforces the deadline and legal holds, so both
     triggers must pass.
2. **Transactions.** Wrap `090200` (and `090100`) in `BEGIN;`/`COMMIT;` like `090300`, since
   they use `set_config(..., true)` before writing to FORCE-RLS tables. Develop is mixed
   (6 of 19 such migrations are wrapped), but the fix is cheap. Queued after DEV-576.
3. **Idempotency.**
   - `090000`: `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`.
   - `090100` / `090200`: `pg_constraint` guards, `CREATE INDEX IF NOT EXISTS`.
   - `090300`: `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.

   Queued after DEV-576.

4. **Note:** `scripts/verify-pharmacy-demo.ts` disables the trigger for a demo cleanup. It
   is not a runtime path. No change.

## Checks: how to rerun, latest result

**Local test database:** Postgres 16, `pg_ctlcluster 16 main start`. To build it:

1. `CREATE DATABASE devfathom_test;`
2. `EXTENSION_ADMIN_DATABASE_URL=<superuser url> bun prisma/prepare-extensions.ts`
3. `DATABASE_URL=<superuser url> bunx prisma migrate deploy`
4. Create a `devfathom_app` role (NOSUPERUSER NOBYPASSRLS) with the grants in `docs/LOCAL_SETUP.md` §3.

DB tests read `TEST_DATABASE_URL`, set to the app-role URL. Some suites also need
`OWNER_DATABASE_URL`, `PHARMACY_TEST_OWNER_DATABASE_URL` or
`QA144_DATABASE_URL`/`QA144_OWNER_DATABASE_URL`.

**First, after any schema change:** `bunx prisma generate`. A stale generated client
caused false failures earlier.

| Check           | Command                                                    | Latest result                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck       | `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit` | Not yet green-confirmed on the integrated branch; it was OOM-killed under agent load. Agents report 8 errors, all pre-existing, in `counter-console.test.tsx`, `tools-routing.test.ts`, `restaurant-reports.test.ts`, `duplicate-salt-acknowledgement.db.test.ts`, `pharmacy-inventory.test.ts`, `restaurant-catering.test.ts`. If a run picks up `.claude/worktrees`, exclude it. |
| Lint            | `bunx eslint <changed files>`                              | Clean on changed files. `prisma/seed-demo.ts` has 48 `no-explicit-any` errors, the same as on develop.                                                                                                                                                                                                                                                                             |
| Tests, per item | `bunx vitest run <files>` with the DB envs above           | All per-item suites pass (see commit bodies).                                                                                                                                                                                                                                                                                                                                      |
| Platform suite  | `bunx vitest run src/lib/platform tests/platform-*`        | 12 failures, identical to develop.                                                                                                                                                                                                                                                                                                                                                 |
| Full suite      | `bunx vitest run`                                          | Not rerun on the integrated branch yet.                                                                                                                                                                                                                                                                                                                                            |
| Build           | `bun run build`                                            | Not run.                                                                                                                                                                                                                                                                                                                                                                           |

## Known failures

**Fail on develop as well** (baseline run at `47518cb`, stale generated client, no DB). 50 tests across 21 files:

- `commands.opportunity-convert` (8)
- `recipe-measurement-domains-migration` (7)
- `pharmacy-baskets` (6)
- `growth-review.db` (5)
- `daily-close-clock` (4)
- `commands.organization-create` (4)
- `finance-evidence-review` (3)
- `restaurant-recipe-concurrency` (2)
- `tenders-posting` (2)
- `whatsapp/message-log.db` (2)
- `pharmacy/inventory` (2)
- 1 each: `vertical-foundation`, `restaurant-tax`, `pharmacy-inventory`, `restaurant/reports.db`, `membership-lock.db`, `pharmacy/reports`, `offline-action-matrix`, `hotel/foundation`, `abac/index`, `restaurant-tax-console`

Fixed on this branch: `pharmacy-inventory` (DEV-577).

`membership-lock.db` passes when run with a real DB.

**Also fail on develop when run with a DB, not caused here:**

- `tests/pharmacy-capabilities.db.test.ts`: the template expects `pharmacy:close`.
- `src/lib/restaurant/terminal-checkout.db.test.ts`: the daily-close cases.

**New failures introduced by this branch:** none known.

**Load-sensitive:** `src/app/(app)/meetings/meetings-content.test.tsx` pagination cases can
exceed 5s under heavy parallel load. 9/9 pass when run alone.

## Decisions and open questions

- **DEV-577:** kept the witness-first order from #911 and fixed the stale test, rather than
  reordering production checks.
- **DEV-124:** added the FK NOT VALID, then validated it only when history is clean, so a
  deploy never fails on pre-#911 evidence. Rows are never rewritten.
- **DEV-155:** user deletion still works (FK SET NULL is allowed only when the actor row is
  gone). Test cleanups delete audit rows after the organization. Fixtures that fake history
  disable the trigger for one transaction.
- **DEV-249:** repaired bad rows instead of using NOT VALID, because the occurrence
  materializer updates meeting rows.
- **DEV-347:** `db:reset` chains the seed, but `prisma migrate reset` drops `btree_gist` /
  `pg_trgm`. _Open:_ decide on a real reset path (drop the DB → prepare-extensions →
  migrate deploy → seed).
- **DEV-583:** develop's AI provider env still needs to be configured by ops. The code only
  makes availability honest.
- **Follow-up, not in this PR:** invoice numbers are globally `@unique` but counted per
  tenant, so a second agency collides. Queued as a separate suggested task.
- **Tooling:** a local `commit-msg` hook to enforce plain messages was denied by the
  permission classifier. The rule is enforced by hand with the scan above.
