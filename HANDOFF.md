# HANDOFF — DEV-576 (top priority)

Last updated: 2026-11-02 20:25 UTC

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

**Develop deploy in progress (started 21:23 UTC)**

- **Release:** `96d372bd` (head after the review fixes; 1128/1128 tests; the Dockerfile-style
  build passes).
- **Patch:** `s3://devfathom-develop-artifacts/deploy-develop/dev576/96d372bd.patch.gz`
  (sha256 `393f0b7e…`).
- **Script:** `/root/scdeploy576.sh` on the host (copy at `deploy-develop/dev576/scdeploy576.sh`).
  It runs as transient unit `dev576-deploy.service` and logs to
  `/var/log/sehatcart-deploy-96d372bd.log`, with markers DOWNLOAD_OK, PATCH_OK, INSTALL_OK,
  BACKUP_OK, MIGRATE_OK, ENV_OK, BUILD_OK and DONE.
- **What the script does:**
  1. Guards that `current` is `47518cbf`.
  2. Takes a `pg_dump` backup into `/root/backups/sehatcart_dev-pre-96d372bd-*.dump`.
  3. Backs up the env to `sehatcart.env.bak-pre-dev576-*`, then appends the AI env.
  4. Builds, switches `current`, restarts, and checks `/api/ready`.
  5. If `/api/ready` is not 200, it relinks `47518cbf`, restores the env and restarts.
- **Manual rollback:**
  - `ln -sfn /home/sehatcart/releases/47518cbf94ac912d0d657122625af03b23bbd1c1 /home/sehatcart/current`
  - Restore the env backup.
  - `systemctl restart sehatcart`
  - Migrations stay; they are additive.
- **After DONE:**
  - On the host, run
    `cd /home/sehatcart/current && sudo -u sehatcart … bun run ai:smoke -- --skip-bedrock`
    with `sehatcart.env` sourced. This uses the instance role and prints no key.
  - Ask Saad to send one Ask Fathom message at `sehatcart.pharmacy.develop.devfathom.com`.
  - Then reply to QA/Security on #1238, rewrite the PR body, and post on DEV-576. Mark the
    Bedrock live test as pending AWS approval.

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
