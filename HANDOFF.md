# HANDOFF — claude-labelled Linear batch

Last updated: 2026-11-06 23:10 UTC · Branch: `saad/nice-thompson-99m17p` · PR:
[RealDevFathom/devfathom-commercial#1223](https://github.com/RealDevFathom/devfathom-commercial/pull/1223)
(into `develop`, open) · Head: the merge `87fb5336` plus this docs commit

## Resume here

- **Saad (2026-11-06):** finish this session's assigned work, run current-head QA, Security and
  local checks here, then merge #1223 into develop and close only verified-resolved linked issues.
  GitHub CI/CD stays disabled; no deploy, workflow change or force-push.
- **Since 2026-11-04:**
  - A Codex owner merged develop (`ba24c89f`) and resolved DEV-721/DEV-512 (`1acec91c`). My
    local resolution of the same conflicts (`b3e0b84f`) was never pushed and is superseded.
  - `87fb5336` merges develop `1906b530` (#1226 invoice numbering, #1120 inventory access, #1421,
    #1010, #1418, #1415, #1430). It wraps the DEV-252 amounts in #1226's locked per-organization
    numbering, and keeps #1120's gated read before DEV-594's advice lookup. Two DEV-252 tests use
    develop's transaction fixtures.
- **Checks on `1acec91c` merged with develop `11660b31` (tree `f481844b`):**
  - Static: typecheck 0, lint 0 errors, build passes, test:rls passes. Prettier fails on develop
    too, and this branch adds no new unformatted file.
  - Every gate lane matched develop or improved it. Main lane: 68 failed, against 74 on develop;
    the 6 fixed are the DEV-577 witness cases. No lane had a new failure.
  - Platform-login a11y passes 16/16 once `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` names the
    installed Chromium. Bicep and the browser gate were not run.
  - The independent QA and Security review (6 areas, 2 skeptics per finding) found no blocking or
    major issue. Its minor notes are in the PR comments.
- **Next step:** rerun the gate on the final head and on develop `1906b530`; merge only if nothing
  regresses. Then close only the issues the per-issue verification rated RESOLVED.
- **Not this session's:** the rest of DEV-582 (delegated to Codex on 3 Nov); #1413's dashboard
  expectations, for whichever of #1413 and #1223 lands second; #1165's flag line.

### Earlier (2026-11-04)

- **Since 2026-11-04 02:15 UTC:**
  - **`ef2719d5` (DEV-249):** the meetings form fields are 44px tall. The Studio visual QA matrix
    is done; screenshots and `matrix.md` are in scratchpad `visual-qa-meetings/`. Every cell
    passed except touch targets (34–38px), which this fixes.
  - **`eb31d46f`:** merges develop (#1238, #1279, #1240, #1224, #1390). Two conflicts:
    - `src/app/api/assistant/route.ts`: both import sets kept;
    - `HANDOFF.md`: this section first, develop's sections after it, unchanged.

    `tsc --noEmit` has 0 errors; `vitest src/app/api/assistant` is 109/109.

  - **`efe660e5` and `b135a982` (DEV-155): security finding 1 is fixed.** Migration
    `20261102150000_audit_logs_retention_purge_exception` lets the append-only trigger allow
    DELETE only when all four hold:
    1. `app.retention_purge_organization_id` names the row's tenant;
    2. `app.current_organization_id` is that same tenant;
    3. the tenant's vertical is PHARMACY;
    4. #1165's `public.pharmacy_record_retention_deadline()` exists and returns a finite
       deadline that has passed.

    UPDATE stays refused. `search_path` puts `pg_temp` last and the tables are
    schema-qualified. Suite `tests/tenant-audit-retention-purge.db.test.ts` has 12 cases and
    never skips, because the QA gate counts a skip as a failure.

  - **Review:** an independent adversarial review (3 lenses, 2 skeptics per finding) confirmed
    two test gaps and a `search_path` gap. All are fixed in `b135a982`.
  - **Posted:**
    - #1165, the one-line flag change and two interplay notes:
      https://github.com/RealDevFathom/devfathom-commercial/pull/1165#issuecomment-6621378839
    - #1223, the security reply:
      https://github.com/RealDevFathom/devfathom-commercial/pull/1223#issuecomment-6621380681
    - The PR body is rewritten.
    - Linear progress comments on DEV-155, DEV-249 and DEV-576 (no status changes).
- **Next step:** wait for the Security and QA re-run on #1223 at `b135a982`. Then fix whatever
  they find, or answer it.
- **Waiting on others:**
  - #1165's owner: apply the one-line flag change, and decide the orphaned-audit-row conflict.
    #1165's guard refuses deleting the audit rows of a deleted organization, which breaks
    `tests/tenant-audit-append-only.db.test.ts` teardown once both merge.
  - The Security and QA re-run on #1223.
- **Follow-ups to propose, not in this PR:**
  - The pharmacy purge is blocked by `pharmacy_reject_append_only_change`.
  - Invoice numbers collide across tenants.
  - The rest of DEV-582: growth cards and marketing assist.
- **Uncommitted / half-written:** nothing in this checkout.

**Local DBs for the retention suite** (Postgres 16; start it with `pg_ctlcluster 16 main start`):

| Database          | Owner                                                                           | Use                                        |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| `audit_ret_test`  | postgres, a superuser                                                           | runtime role `audit_ret_app`               |
| `audit_gate_test` | `audit_gate_owner` (NOSUPERUSER NOBYPASSRLS CREATEROLE, like CI's `gate_owner`) | runtime role `audit_gate_runtime`          |
| `audit_gate_1165` | `audit_gate_owner`                                                              | the same, plus #1165's retention migration |

```bash
OWNER_DATABASE_URL=postgresql://audit_gate_owner:audit-gate-owner-local@localhost:5432/audit_gate_test \
  bunx vitest run tests/tenant-audit-retention-purge.db.test.ts
```

## Rules in force

- PRs into `develop` only. Merge only as Saad authorized on 2026-11-06, after checks pass. Never
  force-push or rewrite pushed commits. No GitHub Actions runs.
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

PR #1223 at head `b135a982` (mergeable, clean):

| Check                                                  | Verdict                          | Notes                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine checks (GitHub check runs)                     | none reported                    | No check runs are attached to this PR. `qa.yml` did not run on it.                                                                                  |
| Codex code review                                      | ✅ no findings                   | At `8fabfc81`.                                                                                                                                      |
| Codex security review                                  | ✅ completed, no findings posted | At `8fabfc81`.                                                                                                                                      |
| Security review (WhatTheStack1), at `b5e29ad0`         | ⚠️ 3 findings + 1 note           | Findings 2 and 3 were fixed in `9bf8e9a0`.                                                                                                          |
| Security re-run, at `754101c2`                         | ⚠️ finding 1 still open          | Findings 2 and 3 were confirmed fixed.                                                                                                              |
| Finding 1 fix (`efe660e5`, `b135a982`)                 | re-run requested                 | Reply: issuecomment-6621380681.                                                                                                                     |
| Internal adversarial review of the retention exception | done                             | 6 findings. 2 confirmed (test gaps): fixed. 4 refuted: 1 hardening fixed anyway, 2 are #1165-side (posted there), 1 was integration with no defect. |
| QA (human)                                             | not started on #1223             | —                                                                                                                                                   |

Security finding 1, as decided by the user ("Narrow exception"): allow DELETE, never UPDATE,
only with the purge flag, a matching tenant context, a pharmacy tenant, and #1165's deadline
function saying the row is past retention. It is implemented in `20261102150000`. #1165 needs
one line, `set_config('app.retention_purge_organization_id', <org>, true)` in
`runPharmacyRecordRetentionJob`'s tenant transaction, which is posted on #1165. I won't push to
its branch.

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

---

# Handoff log: DEV-258 (per-organization invoice numbers)

Last updated: 2026-11-06 (UTC). Branch `saad/exciting-ramanujan-w973fo`, PR
[#1226](https://github.com/RealDevFathom/devfathom-commercial/pull/1226) into `develop`. Linear:
https://linear.app/devfathom/issue/DEV-258. GitHub issue: #441.

## Resume here

- **Status: complete. No further action for DEV-258.** All final checks passed on the code at `9246b61`
  (`develop` @ `ea75045` merged in). PR #1226 is being merged into `develop`, after which DEV-258 and #441
  are closed.
  - Static checks: typecheck 0 errors, lint 0 errors, build passes.
  - Database: migrations apply on a fresh DB and on a DB upgraded from `develop`, no new drift, seed
    passes twice.
  - Tests: the DB tests pass as an admin URL and as the restricted `gate_runtime` role, and the agency
    seed test passes 14/14. The full suite has the same 48 failures as `develop`, none new.
  - Runtime QA over HTTP passes, and the security review and the adversarial review found nothing.
  - The PR #1226 description has the details.
- GitHub CI/CD is disabled: no GitHub checks ran, and none are counted as passing.
- **DEV-618:** PR #1240 was merged into `develop` by another owner on 2026-11-03 (`918d835`). This session
  has no DEV-618 work outstanding.

## What the PR does

- `invoices.invoiceNumber` becomes unique per organization: `@@unique([organizationId, invoiceNumber])`.
  Migration `20261106130000_invoice_number_per_organization` builds the new index and then drops the
  global one. It was renamed from `20261102000000_…` so it sorts after every migration on `develop`,
  the latest being `20261106120000_pharmacy_bootstrap_admin_branch_backfill`.
- `src/lib/finance/invoice-number.ts` takes a per-organization `pg_advisory_xact_lock`, then reads the MAX
  of the year's `INV-<year>-<n>` suffix and inserts, all in one transaction.
  - The tenant comes from `app.current_organization_id`.
  - Allocation fails closed outside a tenant transaction.
- All four creators use the helper: `finance.createInvoice`, `clients.generateInvoiceFromContract`,
  `POST /api/v1/invoices` and the assistant `createInvoice` tool.
- The seed sentinels are scoped to `org_devfathom`.

## History

- 2026-11-02: first implementation, tests and PR. Codex code review found nothing and Codex security
  review posted no findings. Paused for DEV-618 the same evening.
- 2026-11-06 08:43 UTC: QA FAIL because the branch conflicted with `develop`. Saad merged `develop` into
  the branch (`7aebac1`), resolving `HANDOFF.md` by keeping this log first and `develop`'s log after it.
- 2026-11-06: resumed. Migration renamed. Final checks: clean typecheck, lint and Prettier, migrate,
  drift, seed, the DB test as an admin URL and as the restricted `gate_runtime` role, the invoice unit
  suites, the full suite, build, runtime QA over HTTP, and a security review. Results are in the PR
  description.

## How to rerun the checks

Use a disposable Postgres 16 DB, for example
`U=postgresql://qa_admin:qa_admin@localhost:5432/devfathom_test` (local throwaway credentials).

```bash
EXTENSION_ADMIN_DATABASE_URL=$U DATABASE_URL=$U MIGRATION_DATABASE_URL=$U bun prisma/prepare-extensions.ts
DATABASE_URL=$U MIGRATION_DATABASE_URL=$U bunx prisma migrate deploy
NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit
bun run lint
TEST_DATABASE_URL=$U bunx vitest run src/lib/finance/invoice-number.db.test.ts
bunx vitest run src/lib/finance src/server/routers/finance src/server/routers/clients src/app/api/v1/invoices src/lib/ai/tools/finance
NODE_OPTIONS=--max-old-space-size=8192 bun run build
```

---

# Handoff log (from develop)

# HANDOFF — DEV-576 (top priority)

Last updated: 2026-11-04 03:06 UTC

- **MERGED:** #1238 merged into develop as `47ea6c8d` at about 01:00 UTC on 2026-11-03. QA and
  Security were both PASS at head `f8177f10`.
- **Still open:**
  - The Bedrock live test, waiting on AWS approval of the Anthropic use-case form. It's wired;
    re-run the smoke script once approval clears.
  - Saad's browser check of Ask Fathom on develop. Develop runs release `96d372bd`, which has
    the same app code as the merged head.
- **Branch:** `feat/dev-576-ai-providers`, from `develop` @ `47518cbf`.
- **PR:** [RealDevFathom/devfathom-commercial#1238](https://github.com/RealDevFathom/devfathom-commercial/pull/1238). Merged; no longer watched.
- **Linear:** https://linear.app/devfathom/issue/DEV-576. The PR link and live results are posted there.
- **Other work:** the claude-label batch lives on branch `saad/nice-thompson-99m17p`, PR
  https://github.com/RealDevFathom/devfathom-commercial/pull/1223, which has its own `HANDOFF.md`.
  That work stays paused until DEV-576 is done.

## Resume here

**Saad's decisions (2026-11-02 evening)**

They are recorded in full in scratchpad `dev576-routing-contract.md`, which is copied into the
PR body when it is updated.

- **Routing:**
  - Sonnet 5.5 by default.
  - Haiku 5.5 only behind `AF_HAIKU_LOOKUPS=false`. An empty or cut-off answer is resent to
    Sonnet.
  - Opus 5.5 for the weekly owner summary (no failover; retries at +15m / +1h / +6h) and for
    deep strategy when the pharmacy opts in.
- **Fallback order:**
  1. Anthropic.
  2. OpenAI `gpt-6.1-sol`, with `gpt-6-luna` as the small model (Responses API, `store:false`).
  3. Bedrock `global.anthropic.claude-{sonnet,haiku}-5-5` from **ap-southeast-1**, with
     personal data masked first.
- **When to fail over:** only on availability errors. Never on refusals, 400s, or consent or
  permission denials.
- **Limits:**
  - 90 s per turn, 4 model calls and 6 tool calls.
  - SDK retries off, one jittered retry.
  - A circuit breaker per provider, and an alert on 401.
- **Answer rules:**
  - Figures must come from tool results (post-check).
  - Writes are drafts with an idempotency key, and are never replayed.
  - No dosing advice, and no drug names in customer text.
- **Infra:**
  - Production AI is off by default.
  - Bedrock IAM is widened to all Claude models and profiles, including global ones.
- **Bedrock live test:** pending AWS approval of the Anthropic use-case form. It is
  submitted. Bedrock stays wired.
- **#1223:** has no DEV-576 commits, so nothing to move. #1238 is the separate PR.

**In flight**

- **Integrated and pushed (20:45 UTC, head `ae075739`).** Agent commits were cherry-picked
  with plain messages:

  | Commit                 | Change                                                             |
  | ---------------------- | ------------------------------------------------------------------ |
  | `b1de6073`             | deep-strategy opt-in                                               |
  | `1d6f4f96`             | decided routing, failover rules, retry, breaker, masking           |
  | `0cc4a36c`             | grounding and dosing guard                                         |
  | `767837a2`             | turn limits, quick-lookup tier, guards in route                    |
  | `34e245f8`             | marketing drafts reject tenant medicine names                      |
  | `a946e9e0`, `99d2ee0d` | infra: prod off, global profiles ap-southeast-1, widened IAM; docs |
  | `2dabb6ff`, `a45c8db3` | write ledger, approval signing                                     |
  | `e57e4af7`             | e2e within the 4-call limit                                        |
  | `ae075739`             | fresh-db writer column, initializer pins, ledger test              |

  Earlier fix: `d0af5dc4` (unset `AI_PROVIDER` means off).

- **Test results:** 1001/1001 pass on `dev576_int`, which has all three new migrations and the
  LOCAL_SETUP grants. The initializer context test passes. The initializer offline-guard test
  fails here and on develop alike, because this container has no
  `/home/user/initializer-context`.
- **Running now:**
  - The full tsc and a Dockerfile-style build (logs: scratchpad `dev576-tsc4.txt`,
    `dev576-build-docker2.txt`).
  - Adversarial review workflow `wf_66fd213d-49e`, with four lenses and every finding verified.
    Fix whatever it confirms before deploying.
- **Develop prep already done:**
  - Inline policy `devfathom-ai-providers` is attached to `inky-ec2-ssm`. The simulator shows
    both secrets, the global profile and the foundation models allowed, and other secrets
    denied.
  - The develop DB has default privileges (`sehatcart_migrator` → `sehatcart_app`), so the new
    tables are granted automatically.
  - It has 198 migrations up to `20261101172600` and none pending.
  - None of the AI tables exist yet.

**Then deploy to develop and run the live test** (Saad approved: IAM change plus a branch
deploy).

- **Develop host:**
  - EC2 `i-09a24704014a3ffe3` `devfathom-pharmacy`, us-east-1, arm64, 2 vCPU, 3.8 GB, role
    `inky-ec2-ssm`, SSM online.
  - The live develop app is **`sehatcart.service`**: port 3101, served at
    `sehatcart.pharmacy.develop.devfathom.com` and `admin.develop.devfathom.com`, from
    `/home/sehatcart/current` → `releases/47518cbf…` (develop HEAD), env
    `/home/sehatcart/sehatcart.env`, migrations via `/home/sehatcart/migrate.env`.
  - `devfathom.service` on :3000 (`develop.devfathom.com`, release `initial`, Oct 28) is a
    separate, older app. Do not touch it.
- **The previous operator's deploy recipe** (`/root/scdeploy47.sh`):
  1. `cp -a` the current release, then `git apply` a patch.
  2. `bun install --frozen-lockfile` as sehatcart.
  3. `pg_dump` backup.
  4. `prisma migrate deploy` with `MIGRATION_DATABASE_URL`.
  5. `bun run build` with `NEXT_BUILD_SKIP_TYPECHECK=1` and a 2 GB heap.
  6. `ln -sfn` `current`, `systemctl restart sehatcart`, then check `curl /api/ready` on
     :3101.
- **Plan:**
  1. Patch = `git diff --binary 47518cbf..<head>`. Upload it to
     `s3://devfathom-develop-artifacts/deploy-develop/dev576/` with a presigned PUT. The host
     has no AWS CLI, so it fetches with a presigned GET (curl).
  2. Attach the inline policy `devfathom-ai-providers` to `inky-ec2-ssm`: GetSecretValue on
     the 2 secrets, plus the widened Bedrock policy.
  3. Back up `sehatcart.env`, then append the AI env:
     - `AI_PROVIDER=auto`
     - the two `*_SECRET_ID`
     - `AI_SECRETS_REGION=ap-southeast-1`
     - `BEDROCK_REGION=ap-southeast-1`
     - `AF_HAIKU_LOOKUPS=false`
  4. Run the recipe as a new release `releases/<head-sha>`.
  5. Live check:
     - `bun scripts/ai-provider-smoke.ts` in the release, with `sehatcart.env` and the
       instance role.
     - Then ask Saad to send one Ask Fathom message in the browser.
  6. **Rollback:** `ln -sfn` back to `releases/47518cbf…` and restart. Migrations are additive
     and stay.
- **Migrations this applies to the develop DB** (additive; once applied, never edit them, only
  add new ones):
  - `20261102130000_ai_provider_routing`
  - `20261102140000_organization_ai_deep_strategy`
  - `20261102140100_ai_assistant_actions`

**Review verdicts on #1238**

QA and Security at head `1276a75e` (20:16 UTC, box run): **both FAIL**.

- **What ran:** install ✅, lint ✅, typecheck inconclusive (tsc OOM on the box), targeted vitest
  7 failed / 624 passed.
- **Blocker 1:** unset `AI_PROVIDER` turned AI on. **Fixed in `d0af5dc4`:** unset or blank now
  means disabled. The 7 failures came from ambient provider keys. The suites now pass both with
  and without local keys (701/701).
- **Blocker 2:** Bedrock should use the global profiles from ap-southeast-1. In progress
  (router and infra streams).
- **Blocker 3:** widen the Bedrock IAM. In progress (infra stream).
- **Hygiene:** commit messages name model versions, so merge with a clean squash message.
- **Next step:** after integration, reply on the PR with the fixes and ask for QA/Security again.

**Develop deploy: done (21:37 UTC)**

- **State:** release `96d372bd` is live on `sehatcart.service`. `/api/ready` returns 200, and
  the app has logged no errors since the restart.
- **Rollback point:** `releases/47518cbf…` is kept. To roll back:
  - `ln -sfn /home/sehatcart/releases/47518cbf94ac912d0d657122625af03b23bbd1c1 /home/sehatcart/current`
  - `cp -a /home/sehatcart/sehatcart.env.bak-pre-dev576-20261102T212540Z /home/sehatcart/sehatcart.env`
  - `systemctl restart sehatcart`
- **DB backup:** `/root/backups/sehatcart_dev-pre-96d372bd-20261102T212535Z.dump`.
- **Migrations:** all three DEV-576 migrations are applied on develop. They are frozen; add new
  migrations rather than editing these.
- **Env added:**
  - `AI_PROVIDER=auto`
  - `AI_PROVIDER_ORDER=anthropic,openai,bedrock`
  - both `*_SECRET_ID`
  - `AI_SECRETS_REGION=ap-southeast-1`
  - `BEDROCK_REGION=ap-southeast-1`
  - `AF_HAIKU_LOOKUPS=false`
- **IAM:** inline policy `devfathom-ai-providers` on `inky-ec2-ssm`.
- **Live smoke on the host:** ✅ all checks passed.
  - Command: `bun --conditions=react-server scripts/ai-provider-smoke.ts --skip-bedrock`, run as
    sehatcart with `sehatcart.env` and the instance role. `bun run ai:smoke` fails there because
    the host has no Node.
  - Anthropic direct: Sonnet 5.5, 1.5 s.
  - OpenAI direct: gpt-6.1-sol, 2.7 s.
  - Routed chain: Anthropic Sonnet.
  - Cheap tier: Sonnet, because the flag is off.
  - Weekly-summary policy: Anthropic Opus 5.5.
  - Forced fallback (missing model, 404): answered by OpenAI gpt-6.1-sol.
  - `ai_provider_usage`: 4 rows, priced correctly.
  - Bedrock: SKIP, pending AWS approval of the use-case form.
- **Open follow-ups:**
  - Saad to send one Ask Fathom message in the browser (a tenant login is needed).
  - The smoke run printed one warning after it finished:
    `[ai-usage] could not read SuperAdmin AI settings`. There are no `ai_settings` rows; this is
    probably a disconnect race in the script. Watch the app log for it.
  - Re-run the Bedrock live check once AWS approves the use-case form.
- **Done at 21:46 UTC:**
  - The PR #1238 body is rewritten with the decided routing, the live results, the env vars and
    the IAM.
  - QA/Security got a reply covering all 3 blockers, with a re-run requested
    (https://github.com/RealDevFathom/devfathom-commercial/pull/1238#issuecomment-6589266534).
  - DEV-576 has a comment with the deploy and live results, with Bedrock marked pending.
- **Waiting on:**
  - the QA/Security re-run;
  - Saad's browser Ask Fathom check;
  - AWS approval for Bedrock.
- **After that:** go back to the other claude-labelled tasks on #1223 (see that branch's
  HANDOFF).

**Internal adversarial review** (`wf_66fd213d-49e`, four lenses, every finding verified by a
skeptic): 15 confirmed, 6 rejected.

- **Confirmed medium:**
  - Bedrock in-stream errors are not failed over.
  - Prescription images can reach Bedrock unmasked.
  - Urdu stock counts are flagged as dosing advice.
  - Urdu scale words fail grounding.
  - The dosing detector misses common phrasings.
  - The docs say unset `AI_PROVIDER` routes.
  - The QA step quotes the wrong log line, and its 404 blocks Anthropic for 10 minutes.
- **Confirmed low:**
  - Masking misses some phone formats and name keys.
  - Plain 1900-2100 numbers are exempt from grounding.
  - "may" / "mar" are read as months.
  - dd/mm dates are read as figures.
  - Some operations sentences are flagged as dosing advice.
  - Medicine-name variants are not cut at dose forms.
  - Only 5,000 names are read.
  - `docs/deploy/aws.md` is stale.
  - The weekly summary docs overstate what exists.
- **Rejected:** the OpenAI 429 billing text, a throw after a committed write, and the rollout
  parameter values. The per-attempt timeout was rejected as a contract deviation, but it is
  being added anyway, because a stalled provider must fail over.
- **Fixes:**
  - Docs: fixed in `b0438fd8`.
  - Router and guards: workflow `wf_e4807efc-069` (branches `dev576-fix-router`,
    `dev576-fix-guards`, from `11872205`). Cherry-pick them with plain-pick, rerun the suites,
    then deploy.
- **Latest checks at `11872205`:**
  - Dockerfile-style build passes.
  - tsc shows only the 4 baseline test-file errors (one new error fixed in `11872205`).

**Other state**

- **Build:** the Dockerfile-style build of `f579ee24` and later passes. Plain `bun run build`
  stops at tsc on 4 test-file errors that develop has too (confirmed on a clean develop
  worktree: same 4 errors).
- **Codex review on #1238:** 3 P2 findings, fixed in `a66092ca`: the price lock key, the
  launcher routed availability, and the per-provider key cache. The threads are answered and
  resolved.
- **Uncommitted / half-written:** nothing on this branch.
- **Worktree:** `/home/user/devfathom-ai` (local). Everything is pushed.

## Status

| Step                                                                                                      | Status                         | Commits                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------- |
| Merge `feat/ai-provider-3/-4/-5` into a branch from develop                                               | done                           | `35a97a4a`, `f44276c8`, `6add61a4` |
| Reconcile with develop (ledger `ai_provider_usage`, migration `20261102130000`, tenant `ai_usage` kept)   | done                           | `e362514b`                         |
| Providers anthropic / openai / bedrock; keys from Secrets Manager; fallback; caps; Azure out of the chain | done                           | `e362514b`, `74053aec`             |
| SuperAdmin switch: mode, order, fallback, caps, per-tier models, reset, audit                             | done                           | `196e6237`                         |
| Per-provider spend report and 80% / 100% cap alerts; `budget.ts` removed                                  | done                           | `6b617b0a`                         |
| Infra template, IAM and docs (`docs/ai-providers.md`)                                                     | done                           | `bfd509ab`, `f579ee24`             |
| DEV-583 fold-in                                                                                           | done                           | `ef9ea5f1`                         |
| DEV-579 / 580 / 581 fold-in                                                                               | done                           | `770d37bc`                         |
| Tests: unit, DB, offline e2e, smoke script                                                                | done                           | `372cae63`, `8a65a578`, `74053aec` |
| Live checks via the AWS connector                                                                         | partial (see below)            | —                                  |
| PR opened; link posted on DEV-576                                                                         | done                           | #1238                              |
| Studio visual QA matrix for the two SuperAdmin panels                                                     | not done (needs a running app) | —                                  |

## Live checks (2026-11-02, AWS connector, account 892667864163)

The connector authenticates as the account **root**. I used it read-only, plus a few tiny
Bedrock Converse calls.

**Secrets:**

- Both secrets exist in ap-southeast-1 and use AWS-managed KMS.
- They hold JSON `{"value": …}` with a valid key prefix.
- No stack owns them. Values were never printed.

**Bedrock (us-east-1):**

- The `us.anthropic.claude-{haiku,sonnet,opus}-5-5` profiles are ACTIVE, with destinations
  us-east-1, us-east-2 and us-west-2.
- Converse on them is denied: "not available for this account", agreement
  `NOT_AVAILABLE`.
- Haiku 4.5, Opus 4.5 and Opus 4.6 answered.
- Sonnet 4.5 / 4.6 answered once, then said "use case details not submitted".

**IAM:** `SimulatePrincipalPolicy` shows both `inky-ec2-ssm` (EC2 `devfathom-pharmacy`) and
`devfathom-staging-WebTaskRole-…` implicitly denied for GetSecretValue and Bedrock invoke.

**Anthropic / OpenAI live:** not possible from this session.

- The connector sandbox has no internet access.
- The container has internet access but no AWS credentials.
- Moving a key between them would mean printing it.

**Container reachability:** `api.anthropic.com` and `api.openai.com` answer 401 without a key.
`ai:smoke -- --no-db` reached the real Secrets Manager and Bedrock endpoints, and they
rejected the placeholder credentials.

## Checks (latest)

| Check     | Command                                                                                                                                                                                     | Result                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit      | `bunx vitest run src/lib/ai src/server/routers/ai-settings.test.ts src/server/routers/organization-admin.ask-fathom.test.ts src/components/platform src/app/api/assistant src/app/platform` | 716 passed, 3 skipped                                                                                                                                                                          |
| DB        | `TEST_DATABASE_URL=postgresql://devfathom_app:app@127.0.0.1:5432/dev576_core bunx vitest run src/server/routers/ai-settings.db.test.ts src/lib/ai/usage.db.test.ts`                         | 8/8                                                                                                                                                                                            |
| Infra     | `bunx vitest run tests/infra/aws-environment.test.ts tests/local-setup-contract.test.ts`                                                                                                    | 20/20                                                                                                                                                                                          |
| Lint      | `bunx eslint $(git diff --name-only origin/develop...HEAD -- '*.ts' '*.tsx')`                                                                                                               | clean (56 files)                                                                                                                                                                               |
| Typecheck | `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit` (in this worktree)                                                                                                               | 4 errors, all pre-existing on develop in untouched files: `counter-console.test.tsx`, `duplicate-salt-acknowledgement.db.test.ts`, `pharmacy-inventory.test.ts`, `restaurant-catering.test.ts` |
| Build     | `bun run build`                                                                                                                                                                             | running (log: scratchpad `dev576-build.txt`)                                                                                                                                                   |

## Decisions

- **Merge strategy:** merge only, no rebase or force-push. Agent commits were cherry-picked
  with their trailers stripped.
- **Bedrock defaults stay Claude 5.5.** The older working profiles have list prices so a
  SuperAdmin can switch tiers to them until AWS enables 5.5.
- **Staging secret format:** `{"value": …}`, which is read by name.
- **`BEDROCK_REGION` must be set** for Bedrock to join the chain.
- **Template secret ARNs** use the `-??????` suffix. No CloudFormation stack owns the AI key
  secrets, so removing branch 5's secret resource deletes nothing.
- **Known slip:** commit `74053aec` names Bedrock model versions in its body as product facts.
  It is not rewritten (no force-push). Later commit messages are scanned for model names
  too.

# HANDOFF — SehatCart develop QA pass + BA recommendations

Last updated: 2026-11-03 05:01 PKT (00:01 UTC)
Branch: `saad/great-brown-id2w5x` (base `develop` @ `47518cb`)
PR: [#1224](https://github.com/RealDevFathom/devfathom-commercial/pull/1224) into `develop` — docs/evidence/harness only, never merge from this session. Session is subscribed to PR activity.
Linear: no Linear issue is attached to this QA pass (see Open questions)

## Resume here

- **Single next action:** none required. All QA, BA and issue-filing work is done. PR #1224 (docs only) has Machine/QA/Security PASS from a review session (2026-11-02 23:16 UTC) and waits for a human merge decision. Before any push, run `node_modules/.bin/prettier --check` on the changed files: the QA gate runs Prettier on changed files. If anything comes back, handle it per the PR subscription rules. Do **not** start fixing the filed issues: per Saad (2026-11-03), Codex fixes them.
  - Testing is complete. Day 2026-11-02 was CLOSED by QA at 23:48 PKT (variance −4.00, deliberate).
  - Caveat: another tester (`QA-20261102-FUNC-*`, `QA-20261102-CASHCHECK-*`) is using the **same QA Cashier account** on this tenant.
- **Item:** QA pass (no DEV id). W1–W9 done.
- **Half-written / uncommitted:** nothing after this commit. Test bills still holding stock (no UI can release them, #1242): 60 u QA-B1 (3 reload-lost UI bills, ids unknown), 20 u QA-B2 (pre-add preview probe ~00:58 PKT), 10 u QA-B4 (after-close bill), 10 u QA-AMX-1 (Rx test bill). Three API drawers `qa-verify-mvzny1qg-*` are still open (one dated 2026-11-05).

## Issues filed (W9) — report finding → issue

Filed 2026-11-03 01:15–01:30 PKT with labels `bug`, `qa`, severity (`sev1-critical`…`sev4-trivial`) plus `pharmacy`/`security`/`ux`/`a11y` where relevant. **No `claude` label, no assignees, no fixes.**

| Finding                                 | Issue | Finding                               | Issue |
| --------------------------------------- | ----- | ------------------------------------- | ----- |
| 2 Sev1 reload-lost bills leak stock     | #1242 | 15 Sev3 refused payment locks counter | #1254 |
| 3 Sev1 no prescriber/patient creation   | #1245 | 16 Sev3 change disappears             | #1255 |
| 4 Sev1 pharmacist can't tender          | #1241 | 17 Sev3 receipt text/identity         | #1256 |
| 6 Sev1 exportPatient unmasked           | #1243 | 18 Sev3 receipt numbers per device    | #1257 |
| 7 Sev2 pharmacovigilance 500            | #1244 | 19 Sev3 returns "1 BOX"               | #1258 |
| 8 Sev2 Expiry board cost exposure       | #1246 | 20 Sev3 duplicate pack sizes          | #1259 |
| 9 Sev2 write-off witness                | #1248 | 23 Sev3 login throttle message        | #1260 |
| 10 Sev2 Rx without prescription (API)   | #1249 | 24 Sev3 no offline indicator          | #1261 |
| 11 Sev2 client business date            | #1250 | 27 Sev3 opening import cost basis     | #1262 |
| 12 Sev2 day close blocks until midnight | #1251 | 31 Sev4 category growth undercount    | #1263 |
| 13 Sev2 sign-out doesn't revoke         | #1252 | 32 Sev4 no H1 / day-close aria        | #1264 |
| 14 Sev3 keyboard search                 | #1253 |                                       |       |

Not filed because already tracked (no duplicates created):

- 1 → #1227 and 5 → #1227 + closed #509: **comment added** (capability half, onboarding gap, evidence).
- 21 → Linear DEV-498 F14 and 22 → DEV-498 F11 / #1239: **comment added** (F14's proposed fix would block adding controlled items; desktop clipping details).
- 25 → #1233 (names; contrast is #1081/#1092). 26 → #1234: **comment added** (all `text-primary` in dark, token-level fix).
- 28 → Linear DEV-504: **comment added** (unused workspace Locale, Urdu receipt details). 29 → #1236. 30 → #1232.

Corrections after the completeness critic (`wf_7026951b-8f2`, agent `a2d620bc0934d4493`): issue bodies #1242, #1243, #1245, #1251, #1254, #1259, #1264 were edited to cite saved evidence only; UI observations that existed only in run output are now saved verbatim in `qa/sehatcart-2026-11-02/api-evidence/ui-run-log-excerpts.md` (commit `7dbce5d`). `qa-report.md` carries the same corrections and every issue number.

## PR #1224 review status

| Check                                            | Verdict                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine checks (review session)                  | PASS on `d34637b`      | The first run, on `1f73675`, failed Prettier (95 of 98 new md/json/mjs files unformatted). The review session pushed `d34637b`, which only applies Prettier; verified here that all 61 JSON evidence files hold identical data and every harness script parses. Re-run on `d34637b`: deps OK, typecheck no new errors (4 already on develop), ESLint 0 errors, Prettier clean, no related tests, `next build` passed. GitHub itself shows 0 check runs; `mergeable_state: clean`; no Claude Approvals check.                                                                                                                                                                                               |
| Codex code review (`dd6cf1d`)                    | 2 × P2 → fixed         | (1) dark sweeps only set `prefers-color-scheme`; the app reads `localStorage['theme']`, so the "dark" sweep rendered light → `roleContext` now stores the app theme and sweeps record `data-theme`. (2) `print-receipt.mjs` wrote HTML to a hard-coded path → now `path.join(EVIDENCE, …)`. Threads replied to and resolved.                                                                                                                                                                                                                                                                                                                                                                               |
| Codex security review (`dd6cf1d`)                | completed, no findings | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| QA re-check after fix                            | done                   | Genuine dark pass: 34/34 pages `data-theme=dark`, no errors/overflow. New dark finding (report #26). Adversarial verification applied to `qa-report.md` (one finding withdrawn, three added from live follow-ups).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| QA review (review session, 2026-11-02 23:16 UTC) | PASS                   | Non-blocking notes for the owner: (1) root `HANDOFF.md` collides with #1223's — kept at the root because the user asked for it there; rename on merge if #1223 lands first. (2) Harness defaults pointed at this session's paths — fixed in the commit after `d34637b` (repo root derived from the script location, scratch in the OS temp dir). (3) `probe1.json` held the tenant owner's real email — redacted in `probe1.json` and `sweep-desk-results.json` in the same commit; earlier commits still contain it (no history rewrite; a squash merge keeps it out of `develop`). (4) About 10.9 MB of evidence sits in `qa/` and `qa-evidence/` rather than `docs/qa/` — left for the owner to decide. |
| Security review (review session)                 | PASS                   | No credentials, tokens, cookies, JWTs or keys in the 50 text files; screenshots spot-checked; the only phone number is synthetic; receipt HTML is static.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Workstreams (items)

| #   | Item                                                                                  | Status              | Done so far                                                                                                                                                                                                                               | Exact next step                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Recon + GitHub issue index                                                            | done                | 573 issues indexed (`gh api search/issues`), permission model + role templates mapped (`src/lib/vertical-catalog.ts:764-826`)                                                                                                             | —                                                                                                                                                                                              |
| W2  | Harness (per-role sessions, tRPC caller, UI step runner, page sweep)                  | done                | `qa/sehatcart-2026-11-02/harness/*.mjs`; desktop sweep 46 routes × 4 roles                                                                                                                                                                | —                                                                                                                                                                                              |
| W3  | RBAC UI + API denial matrix                                                           | done                | Live: #1010/#507, #1012, #1016, #1036, #412, #517, #509(closed→reproduces) confirmed; new N4, N15, N17. Static audit: `rbac-static.tsv` (350 procs)                                                                                       | —                                                                                                                                                                                              |
| W4  | Functional E2E (purchasing → goods-in → counter → returns → Rx → day close → reports) | done                | PO/GRN/post via UI+API, cash sale + receipt print (EN/UR), return + refund, Rx gate, day-close preview; command-centre sales reconciled to 5 receipts (PKR 505.98)                                                                        | Report accuracy (above) → day close + lock-after-close test (owner; do last, it locks the business day for everyone) → stock count/transfer/write-off/recall/opening-stock CSV import          |
| W5  | AI (Ask Fathom + growth)                                                              | done (blocked live) | Ask Fathom 503 (no `AI_PROVIDER` on develop, #1199/#1159) → accuracy/injection/Urdu **not testable live**; tool authz reviewed in code (`src/lib/ai/tools/pharmacy-reports.ts`); growth insights UNAVAILABLE; basket needs completed days | Write up; optional: deterministic replenishment report check (`pharmacyReports.replenishment`)                                                                                                 |
| W6  | UI/UX/a11y sweep (375/768/1440, dark, Urdu RTL, keyboard, axe)                        | done                | Desktop/tablet/phone sweeps done (no doc overflow; #1032/#1069 reproduce); axe done (N25); no app Urdu (N24); dark sweep running                                                                                                          | `ROUTES="..." node qa/sehatcart-2026-11-02/harness/sweep.mjs tablet 768 1024 light`, then `phone 375 812`, `desk-dark 1440 900 dark`; Urdu switch via Settings; axe via `@axe-core/playwright` |
| W7  | Security + data integrity probes                                                      | done                | XSS pass; CSV pass (Sev4 gap); throttle N19; logout-not-revoked N20; concurrency pass; #521/#636 fixed; offline N21                                                                                                                       | Optional: cross-tenant host probe (needs another tenant host)                                                                                                                                  |
| W8  | Write `qa-report.md` + `ba-recommendations.md`                                        | done                | After verification: 32 new findings (6 Sev1/7 Sev2/15 Sev3/4 Sev4), 23 re-verified, go/no-go = NO-GO; 39 BA recommendations (24 P1, 14 P2, 1 P3) + top 10                                                                                 | —                                                                                                                                                                                              |
| W9  | File new findings as GitHub issues (no `claude` label, no fixes)                      | done                | 23 issues #1241–#1264; 9 already tracked (see table above); 4 evidence comments                                                                                                                                                           | —                                                                                                                                                                                              |

## Environment / test data (no passwords here — creds live only in a local, uncommitted file)

- Tenant: `https://sehatcart.pharmacy.develop.devfathom.com`, org `cmvx5fc310002y5qrvcbv98h9`, single branch `MAIN` `cmvx5fc4p000cy5qrcgzjrc3b` (Lahore). Workspace is **not activated** (onboarding 7/12).
- Accounts: qa.owner (ADMIN, role "Owner / Operator"), qa.cashier (Cashier), qa.manager (Procurement), qa.pharmacist (Pharmacist + `pharmacy:safety` override).
- Setup change made by QA: owner assigned **QA Cashier + QA Pharmacist to branch MAIN** at ~23:20 PKT (before that, nobody had a branch assignment and cashier sales could not be paid — finding N4).
- Medicines: QA Panadol `cmvxpws13002v1xqrfsg4p4hz` (STRIP pack `cmvxpy8hn003t1xqr9az7aste`; duplicate pack `cmvzkrtdx01aw4oqrwe45y3zt` created by QA → N1). Rx test item QA Amoxicillin 500mg `cmvzld6dm01uc4oqrs4vn5m0a` (pack `cmvzld6hf01ui4oqrzi7bnemw`, batch QA-AMX-1, 200 u, MRP 300.00/strip).
- Batches of Panadol: QA-B1 (MRP 25.00, exp 2027-06, mostly locked in abandoned bills), QA-B2 (MRP 28.00, exp 2027-01, ~280 u), QA-B3 (MRP 30.00, exp 2028-03, 300 u).
- Supplier created by cashier (RBAC probe): `QA-RBAC-mvzktau8 supplier` `cmvzktbce01cs4oqrsxjjoswy`.
- **60 units of QA-B1 are still locked in 3 abandoned open bills** (created by QA Cashier ~23:15–23:22 PKT via UI; ids unknown, no UI can list/void them — finding N8).
- Counter drawers are per browser device id (localStorage). Harness persists cashier/pharmacist localStorage with `PERSIST=1`.
- AI: `AI_PROVIDER` not set on develop → Ask Fathom 503, growth insights UNAVAILABLE.

## Commands (checks)

This branch changes **no production code**, so typecheck/lint/unit/build were not run (not applicable). QA checks:

```bash
# one-time: create the creds file OUTSIDE the repo and point QA_CREDS at it
# Defaults: QA_REPO = the checkout that contains the harness; QA_SCRATCH = <OS temp dir>/qa-sehatcart-2026-11-02;
# QA_CREDS = $QA_SCRATCH/secrets/creds.json; QA_EVIDENCE = $QA_REPO/qa-evidence.
export QA_CREDS=/path/outside/repo/creds.json QA_SCRATCH=/tmp/qa-scratch QA_REPO=$(pwd)
node qa/sehatcart-2026-11-02/harness/login-all.mjs          # latest: 4/4 roles OK (~0.8–0.9 s each)
node qa/sehatcart-2026-11-02/harness/rbac-purch.mjs         # latest: cashier supplier→licence→authorise→PO 200; pharmacist approve 200 (BUG #1010)
node qa/sehatcart-2026-11-02/harness/rbac-sale.mjs          # latest: manager/pharmacist/cashier create+addLine 200, cart 403 (N4)
node qa/sehatcart-2026-11-02/harness/rbac2.mjs              # latest: drawer/patient/PV by Procurement 200; exportPatient unmasked (N15); PV create 500 (N16)
node qa/sehatcart-2026-11-02/harness/reports1.mjs           # latest: commandCentre 200 owner; expiryAdvice 500 (#1042)
node qa/sehatcart-2026-11-02/harness/ask.mjs owner "question" # latest: 503 (AI disabled)
node qa/sehatcart-2026-11-02/harness/sweep.mjs desk 1440 900 light   # latest: 184 pages, React #418 on /pharmacy/orders
gh api -X GET search/issues -f q='repo:RealDevFathom/devfathom-commercial is:issue' -f per_page=100 --paginate --jq '.items[] | [.number, .state, (.labels|map(.name)|join(",")), .title] | @tsv' > issues.tsv
```

Known failures: all failures above are product findings on the deployed develop build (not test-harness failures). Harness caveat: each run uses a fresh browser profile unless `PERSIST=1` (new counter device ⇒ `DRAWER_NOT_OPEN`).

## Open questions / decisions

1. **Push policy.** Original brief said "do not push"; at 23:3x PKT the user asked for this HANDOFF.md to be committed and pushed. Decision: push only docs, evidence screenshots and the QA harness (no production code, no session cookies, no credentials).
2. **PR.** Repository workflow requires a PR for a pushed branch → PR into `develop`, docs-only, not to be merged by this session.
3. **Linear.** No Linear issue exists for this QA pass, so there is nowhere to post status comments yet. Asked the user whether to create one or comment on an existing DEV issue.
4. **Concurrent tester** on the same tenant and the same QA Cashier account (`QA-20261102-FUNC-*`). Their activity is mixed into drawers, receipts and report totals.
5. **Day close** locks the business day for everyone on the branch → run it last.
6. Severity rule used: Sev1 = security, data loss, money wrong, blocks selling; existing issues are re-verified and linked, not re-filed.
