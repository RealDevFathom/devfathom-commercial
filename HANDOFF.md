# HANDOFF — DEV-576 (top priority)

Last updated: 2026-11-02 ~18:50 UTC
Branch: `feat/dev-576-ai-providers` (from `develop` @ `47518cbf`). PR: not opened yet.
Linear: https://linear.app/devfathom/issue/DEV-576
Other work (the claude-label batch) lives on branch `saad/nice-thompson-99m17p`, PR
https://github.com/RealDevFathom/devfathom-commercial/pull/1223. That branch has its own
`HANDOFF.md`.

## Resume here

- **Next action:** the "reconcile" commit. It makes the merged tree consistent with develop:
  - **Schema:** develop already has a tenant-scoped `model AIUsage` (`ai_usage`, migration
    `20261029000277`). The branches add a second platform `model AIUsage` on the same table.
    Rename the branch one to `AIProviderUsage` (`ai_provider_usage`).
  - **Migrations:** renumber the branch migrations `20261023200001` / `20261023200004` to
    after develop's latest. They were never applied anywhere, so they can be reshaped.
  - **Develop behaviour to restore:** fix #663. Tenant/branch attribution via the tenant
    `recordAIUsage` plus fail-open metering in `routeAI`, with develop's `router.test.ts`
    cases. The merge took the branch side of `router.ts`, `router.test.ts`, `spend.ts` and
    `marketing-assistance.*`.
  - **Lockfile:** `bun.lock` kept develop's side. Run `bun install` to add the branch deps.
- **Uncommitted / half-written:** nothing yet.
- **Worktree:** `/home/user/devfathom-ai` (local only).

## Status

| Step                                                                                                   | Status                                         | Commits                            |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------- |
| 1. Branch from develop; merge `feat/ai-provider-3-superadmin-settings`, `-4-usage`, `-5-infra`         | done (pushed)                                  | `35a97a4a`, `f44276c8`, `6add61a4` |
| Reconcile with develop (schema, migrations, tenant attribution, lockfile)                              | in progress                                    | —                                  |
| 2. Providers: anthropic, openai (new), bedrock (instance role, us-east-1)                              | not started                                    | —                                  |
| 3. Keys from Secrets Manager (ap-southeast-1, env-named secret ids; plain env keys only for local dev) | not started                                    | —                                  |
| 4. Ordered fallback anthropic → openai → bedrock, configurable                                         | not started                                    | —                                  |
| 5. SuperAdmin switch: active provider and model per tier                                               | not started (branch 3 has a console to extend) | —                                  |
| 6. Per-provider monthly caps (190 / 190 / 300 USD), configurable                                       | not started                                    | —                                  |
| 7. Azure: kept, never default, never in the chain                                                      | not started                                    | —                                  |
| 8. Tests (unit + integration), typecheck, lint, vitest, build                                          | not started                                    | —                                  |
| 9. Docs: env vars and IAM                                                                              | not started                                    | —                                  |
| Fold-ins: DEV-583 (`4d7393bc` in a local agent worktree), DEV-579/580 (`47d1a33d` on the other branch) | not started                                    | —                                  |
| PR into develop (links DEV-576, supersedes the 3 branches); post the link on DEV-576                   | not started                                    | —                                  |

## Decisions so far

- **Merge strategy:** merge only, never rebase or force-push.
  - For conflicts in the new routing modules, the merge commits take the branch side.
  - For `bun.lock`, they take develop's side.
  - Develop behaviour is restored in a separate reconcile commit, so the merges stay easy to read.
- **Model defaults** (configurable):

  | Provider                        | cheap                           | standard                         | deep                           |
  | ------------------------------- | ------------------------------- | -------------------------------- | ------------------------------ |
  | Anthropic                       | `claude-haiku-5-5`              | `claude-sonnet-5-5`              | `claude-opus-5-5`              |
  | Bedrock (us-east-1 US profiles) | `us.anthropic.claude-haiku-5-5` | `us.anthropic.claude-sonnet-5-5` | `us.anthropic.claude-opus-5-5` |
  | OpenAI                          | `gpt-5.4-nano`                  | `gpt-5.4-mini`                   | `gpt-5.4`                      |

  The bare Bedrock IDs are not served in-region in us-east-1.

- **Bedrock IAM:**
  - Converse and ConverseStream are authorized by `bedrock:InvokeModel` and
    `bedrock:InvokeModelWithResponseStream`. There is no separate Converse IAM action.
  - A US geo inference profile needs the inference-profile ARN in us-east-1 plus the
    foundation-model ARNs in us-east-1, us-east-2 and us-west-2.
- **Secrets:** branch 5 _created_ `devfathom/<env>/anthropic-api-key` and injected it as env.
  The secrets already exist and the app must read them at runtime, so that resource and
  injection are replaced by `*_SECRET_ID` env vars plus runtime GetSecretValue on the
  workload role.

## Checks (latest)

None run yet on this branch.
