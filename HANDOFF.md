# HANDOFF — DEV-576 (top priority)

Last updated: 2026-11-02 19:50 UTC

- **Branch:** `feat/dev-576-ai-providers`, from `develop` @ `47518cbf`.
- **PR:** [RealDevFathom/devfathom-commercial#1238](https://github.com/RealDevFathom/devfathom-commercial/pull/1238). Open into develop, not merged; this session watches it.
- **Linear:** https://linear.app/devfathom/issue/DEV-576. The PR link and live results are posted there.
- **Other work:** the claude-label batch lives on branch `saad/nice-thompson-99m17p`, PR
  https://github.com/RealDevFathom/devfathom-commercial/pull/1223, which has its own `HANDOFF.md`.
  That work stays paused until DEV-576 is done.

## Resume here

- **Next action:**
  - When `bun run build` finishes, put its result in the PR body "Checks" table, replacing
    "in progress".
  - Then ask Saad for the "two changes for DEV-576": his message arrived truncated, with
    nothing after the colon.
- **Waiting on ops (Saad):**
  1. Add the IAM policy from the PR body to the develop host role `inky-ec2-ssm` (and/or
     update the ECS staging stack).
  2. In the Bedrock console (us-east-1), submit the Anthropic use-case form and ask AWS to
     enable the Claude 5.5 models.
  3. Set the env vars from the PR body and deploy.
  4. Run `bun run ai:smoke` from a checkout with credentials that carry the policy.
- **Open review questions in the PR:**
  - Should production default to `AiProvider=disabled`?
  - Should the ECS Bedrock IAM stay exact to the 3 parameter models, or be widened to
    `us.anthropic.claude-*` so SuperAdmin switches work?
- **Uncommitted / half-written:** nothing.
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
