# Handoff log: DEV-258 (per-organization invoice numbers)

Last updated: 2026-11-06 (UTC). Branch `saad/exciting-ramanujan-w973fo`, PR
[#1226](https://github.com/RealDevFathom/devfathom-commercial/pull/1226) into `develop`. Linear:
https://linear.app/devfathom/issue/DEV-258. GitHub issue: #441.

## Resume here

- **Status: resumed, finishing.** On 2026-11-06 Saad asked for the remaining DEV-258 fixes, full QA and a
  security review on the final commit, then a merge into `develop` and closing the verified issues.
  GitHub CI/CD stays disabled, and there is no deploy and no force-push.
- **Next action:** run the final checks on the PR head, merge #1226 into `develop`, verify the change on
  the merge commit, then close DEV-258 and #441. The results are recorded in the PR #1226 description and
  on DEV-258.
- **Uncommitted / half-written:** nothing.
- **DEV-618:** PR #1240 was merged into `develop` by another owner on 2026-11-03 (`918d835`). This session
  has no DEV-618 work outstanding.

## What the PR does

- `invoices.invoiceNumber` becomes unique per organization: `@@unique([organizationId, invoiceNumber])`.
  Migration `20261106090000_invoice_number_per_organization` builds the new index and then drops the
  global one. It was renamed from `20261102000000_…` so it sorts after `develop`'s
  `20261102140100_ai_assistant_actions`.
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

Last updated: 2026-11-02 21:47 UTC

- **Branch:** `feat/dev-576-ai-providers`, from `develop` @ `47518cbf`.
- **PR:** [RealDevFathom/devfathom-commercial#1238](https://github.com/RealDevFathom/devfathom-commercial/pull/1238). Open into develop, not merged; this session watches it.
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
