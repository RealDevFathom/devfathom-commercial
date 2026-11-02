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

- **Workflow `wf_6b764edf-fc8`:** four worktree agents on branches `dev576-router`,
  `dev576-guards`, `dev576-ledger` and `dev576-infra`, all from `9d360630`.
  1. When it reports, cherry-pick the commits with the plain-pick script (trailers stripped,
     model-name scan).
  2. Resolve `route.ts` overlaps between guards and ledger. The ledger agent reports its
     route lines.
  3. Run the AI suites, the DB tests, and a Dockerfile-style build:
     `AUTH_SECRET=container-build-only NEXT_BUILD_SKIP_TYPECHECK=1 next build`.
  4. Push, then reply on any new Codex threads.
- **If the agent worktrees are lost:** redo the streams from the contract.

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
