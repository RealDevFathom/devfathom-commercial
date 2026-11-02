# HANDOFF — DEV-576 (top priority)

Last updated: 2026-11-02 19:20 UTC
Branch: `feat/dev-576-ai-providers` (from `develop` @ `47518cbf`). PR: not opened yet.
Linear: https://linear.app/devfathom/issue/DEV-576
Other work (the claude-label batch) lives on branch `saad/nice-thompson-99m17p`, PR
https://github.com/RealDevFathom/devfathom-commercial/pull/1223. That branch has its own
`HANDOFF.md`. **All other Linear work is paused until DEV-576 is done.**

## Resume here

- **Next action:** integrate the three "adapt" work streams. They are being written now in
  local worktrees (workflow `wf_7dcd7f73-601`):
  - **settings**, branch `dev576-settings`: SuperAdmin router `src/server/routers/ai-settings.ts`
    and console `src/components/platform/ai-settings-console.tsx`. Covers the active provider,
    order, fallback, caps with month spend, per-tier models, and reset.
  - **usage**, branch `dev576-usage`: `src/lib/ai/usage.ts`, `money.ts`, `platform-ai-usage.ts`
    and `ai-usage-panel.tsx` on `ai_provider_usage`, plus the budget alert
    `maybeCreateAIBudgetAlert(provider, now)`. It removes `src/lib/ai/budget.ts`.
  - **infra**, branch `dev576-infra` (queued): `infra/aws/environment.yaml`,
    `tests/infra/aws-environment.test.ts`, and docs. Docs cover the env var list, the IAM
    policy, removing the created secret, and Bedrock us-east-1 ARNs.
- **How to integrate:** cherry-pick each commit with the trailers stripped:
  `git cherry-pick --no-commit <sha>`, then commit with the message minus any
  `Co-Authored-By:` / `Claude-Session:` lines. Then:
  - Run `bunx prettier --write` on the touched files.
  - Resolve formatting overlap in `budget.ts` and `mutation-authorization.ts`. Commit
    `ef9ea5f1` reformatted both.
- **If the agent worktrees are gone:** redo the three streams from the scope above, against
  the contract in `src/lib/ai/router.ts`, `spend.ts` and `model-defaults.ts`.
- **Known open tsc error:** `src/lib/ai/router.ts` default `alert` calls
  `maybeCreateAIBudgetAlert(provider, now)`. It type-checks only once the usage stream lands.
- **Uncommitted / half-written on this branch:** nothing.
- **Worktree:** `/home/user/devfathom-ai` (local). Everything listed below is pushed.

## Status

| Step                                                                                                                                            | Status                                                                         | Commits                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| 1. Branch from develop; merge `feat/ai-provider-3-superadmin-settings`, `-4-usage`, `-5-infra`                                                  | done                                                                           | `35a97a4a`, `f44276c8`, `6add61a4`             |
| Reconcile with develop (ledger renamed `ai_provider_usage`, migration `20261102130000`, tenant `ai_usage` + `routeAI` fail-open kept, lockfile) | done                                                                           | `e362514b`                                     |
| 2. Providers anthropic / openai / bedrock (instance role, `BEDROCK_REGION` default us-east-1)                                                   | done                                                                           | `e362514b`                                     |
| 3. Keys from Secrets Manager at runtime (`*_API_KEY_SECRET_ID`, `AI_SECRETS_REGION`; plain keys only outside production; never logged)          | done                                                                           | `e362514b` (`secrets.ts`, `ai-credentials.ts`) |
| 4. Fallback anthropic → openai → bedrock, configurable (`AI_PROVIDER_ORDER` or SuperAdmin order)                                                | done                                                                           | `e362514b` (`router.ts`)                       |
| 5. SuperAdmin switch: active provider plus model per tier                                                                                       | backend done; router/console being adapted                                     | `e362514b`; settings stream pending            |
| 6. Per-provider monthly caps 190 / 190 / 300 USD (env `AI_<P>_MONTHLY_CAP_USD` or SuperAdmin), Asia/Karachi month, fail-closed on unknown spend | done                                                                           | `e362514b`                                     |
| 7. Azure kept, never default, never in the chain                                                                                                | done (tested)                                                                  | `e362514b`, `372cae63`                         |
| 8. Tests                                                                                                                                        | unit + routed + offline e2e done; DB integration in the settings/usage streams | `372cae63`                                     |
| 8. Typecheck, lint, vitest, build                                                                                                               | pending full run after integration                                             | —                                              |
| 9. Docs: env vars and IAM                                                                                                                       | infra stream (queued)                                                          | —                                              |
| Fold-in DEV-583 (Ask Fathom 503 / honest availability)                                                                                          | done                                                                           | `ef9ea5f1`                                     |
| Fold-in DEV-579 / 580 / 581 (expiry advisor query)                                                                                              | done                                                                           | `770d37bc`                                     |
| PR into develop titled `feat(DEV-576): AI providers Anthropic, OpenAI, Bedrock`; post link on DEV-576                                           | not started                                                                    | —                                              |

## Checks (latest)

| Check                  | Command                                                                                                  | Latest result                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Routed + key tests     | `bunx vitest run src/lib/ai/secrets.test.ts src/lib/ai/router.routing.test.ts`                           | 38/38 pass                                                |
| Offline Ask Fathom e2e | `bunx vitest run src/app/api/assistant/route.providers.e2e.test.ts`                                      | 7/7 pass                                                  |
| AI unit suites         | `bunx vitest run src/lib/ai src/app/api/assistant`                                                       | provider 42, router, tiers pass (rerun after integration) |
| Typecheck              | `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc --noEmit` (run in this worktree, not the main checkout) | 1 known error: the `alert` signature (see Resume here)    |
| Lint                   | `bunx eslint <changed files>`                                                                            | clean on the new test files                               |
| Full vitest / build    | `bunx vitest run`, `bun run build`                                                                       | not run yet                                               |

**What "end to end" means here:** `route.providers.e2e.test.ts` drives `POST /api/assistant`
through:

- the real `ai` SDK and the real `@ai-sdk/anthropic`, `@ai-sdk/openai` and
  `@ai-sdk/amazon-bedrock`;
- the routed chain, the caps and the key loader.

Only the network is faked, in each provider's wire format: Anthropic SSE, OpenAI Responses
SSE, and the Bedrock binary event stream.

What it shows:

- Anthropic answers.
- Anthropic 529 falls back to OpenAI with `store:false`.
- Both failing falls back to Bedrock, SigV4-signed for us-east-1.
- ForceBedrock, ForceOpenAI and Disabled behave as set.
- All providers capped returns 503.

**Live calls were not possible from this container.** Its AWS credentials are placeholders
(`UnrecognizedClientException`) and the AWS connector needs sign-in. Live verification
belongs on the develop server once the env and IAM are applied.

## Decisions

- **Merge strategy:** merge only, no rebase or force-push. Develop behaviour was restored in
  one reconcile commit.
- **Routing:** `createAIModel` stays synchronous. It returns a lazy `LanguageModelV3`
  (`devfathom.routed`) that resolves settings, keys and caps per call. Failover happens
  only before any output, and never on abort.
- **Settings precedence:** a SuperAdmin force mode wins, then `AI_PROVIDER=anthropic|openai|bedrock`
  (preferred first), then the SuperAdmin order, then `AI_PROVIDER_ORDER`, then the default.
  `AI_PROVIDER` unset or `auto` means routed. Azure, groq, google and vertex remain explicit
  legacy selectors only.
- **Model defaults** (overridable by `AI_<P>_MODEL_<TIER>` or SuperAdmin):

  | Provider                        | cheap                           | standard                         | deep                           |
  | ------------------------------- | ------------------------------- | -------------------------------- | ------------------------------ |
  | Anthropic                       | `claude-haiku-5-5`              | `claude-sonnet-5-5`              | `claude-opus-5-5`              |
  | Bedrock (us-east-1 US profiles) | `us.anthropic.claude-haiku-5-5` | `us.anthropic.claude-sonnet-5-5` | `us.anthropic.claude-opus-5-5` |
  | OpenAI                          | `gpt-5.4-nano`                  | `gpt-5.4-mini`                   | `gpt-5.4`                      |

- **Bedrock IAM:**
  - Converse and ConverseStream are authorized by `bedrock:InvokeModel` and
    `bedrock:InvokeModelWithResponseStream`. There is no separate Converse IAM action.
  - The US geo profile needs the inference-profile ARN in us-east-1, plus foundation-model
    ARNs in us-east-1, us-east-2 and us-west-2, conditioned on `bedrock:InferenceProfileArn`.
- **Secrets:**
  - Branch 5 created `devfathom/<env>/anthropic-api-key` and injected it as env. That is
    replaced by `*_SECRET_ID` env vars plus runtime GetSecretValue on the workload role.
  - Keys are cached for 15 min; a failure is retried after 1 min.
- **Ledgers:** the platform spend ledger `ai_provider_usage` drives the caps. Develop's
  tenant `ai_usage` attribution stays separate and unchanged.
