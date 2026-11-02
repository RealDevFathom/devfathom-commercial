# HANDOFF — claude-labelled Linear batch

Last updated: 2026-11-02 19:25 UTC · Branch: `saad/nice-thompson-99m17p` · PR:
[RealDevFathom/devfathom-commercial#1223](https://github.com/RealDevFathom/devfathom-commercial/pull/1223)
(into `develop`, open, not merged)

## Resume here

- **PAUSED for DEV-576** (top priority). Its state is in `HANDOFF.md` on branch
  `feat/dev-576-ai-providers`. Come back here only once the DEV-576 PR is open.
- **Next action here after that:** cherry-pick the finished agent commits onto this branch,
  stripping trailers:
  - reports: `9014980b`, `be910e97`, `65571821` (DEV-595, DEV-601 work-pack half, DEV-596)
  - marketing: `0cbb059c`, `0394e82d`, `040e3fec`, `b40c67d1`, `526383a9` (DEV-606, DEV-591,
    DEV-597, DEV-601 marketing half, test-race fix)
  - panel: `532905f9`, `ed0c0924`, `2efd61ec`, `329d0d71`, `76374820`, `8acad851`
    (DEV-584/605, DEV-599, DEV-598, DEV-603, DEV-600/592/593, DEV-604)

  Then run the full typecheck and push, and post the "Finished" comments.

- **Already pushed, Finished comments still owed:** DEV-602 `bb4777cd`, DEV-594 `b5e29ad0`.
- **DEV-583** moved to the DEV-576 PR (`ef9ea5f1`). **DEV-582** is partial (WIP `6a0ddedc`
  in an agent worktree).
- **Review fixes queued** (internal review, confirmed, low severity):
  1. The custody migration `20261102090100` comment wrongly claims the purge handles custody
     rows. Pharmacy purge is blocked by `pharmacy_reject_append_only_change`: file a
     separate task for that.
  2. The meetings edit/create forms block valid meetings that cross local midnight
     (`meetings-content.tsx` ~498).
  3. The `seed-failure.ts` P2002 hint points to `db:reset`; point it to the rebuild
     procedure.
  4. Reword the disputed audit-trigger comment about staff-profile deletion.
- **Uncommitted / half-written:** nothing in this checkout. The agent commits above exist
  only in local worktrees under `.claude/worktrees/` (unpushed). If they are lost, redo each
  stream from its Linear issue using the scope notes below.

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

PR #1223 at head `47d1a33d`:

| Check                                          | Verdict                          | Notes                                                                       |
| ---------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| Machine checks (GitHub check runs)             | none reported                    | No check runs are attached to this PR. `qa.yml` did not run on it.          |
| Codex code review                              | ✅ no findings                   | At `8fabfc81`. Re-runs on each push.                                        |
| Codex security review                          | ✅ completed, no findings posted | At `8fabfc81`.                                                              |
| QA (human)                                     | not started                      | —                                                                           |
| Internal adversarial review (first 10 commits) | queued / running                 | Six areas, each finding checked by two verifiers. Fix whatever it confirms. |

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
