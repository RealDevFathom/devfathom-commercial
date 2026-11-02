# AI providers

Last reviewed: 2026-11-02 (DEV-576). This page replaces `docs/ai-provider-1.md` to
`docs/ai-provider-5.md`.

DevFathom sends AI calls (Ask Fathom, growth insights, owner reports, and other features)
through one **routed chain** of three providers. By default the order is Anthropic, then
OpenAI, then Amazon Bedrock. Each provider has a model per tier and a monthly spend cap. A
SuperAdmin can change the active provider, the order, the models and the caps without a
deploy.

- **Keys.** The Anthropic and OpenAI keys live in AWS Secrets Manager. The app reads them at
  runtime through its AWS role. They are never in the task definition, the container
  environment, CloudFormation or the logs.
- **Bedrock.** Bedrock runs in `us-east-1` with the same role and no static AWS keys.
- **Azure.** Azure OpenAI stays in the code as a legacy selector, together with `groq`,
  `google` and `vertex`. None of them is ever the default, and none is ever part of the
  fallback chain.

Code: `src/lib/ai/provider.ts` (selection), `router.ts` (chain, caps, fallback),
`model-defaults.ts` (defaults and env names), `ai-credentials.ts` and `secrets.ts` (keys),
`spend.ts` (ledger). Infrastructure: `infra/aws/environment.yaml`.

## Environment variables

| Variable                                     | Default                          | Purpose                                                                              |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `AI_PROVIDER`                                | unset (AWS template: `auto`)     | Turns AI on or off and picks routed or legacy mode. See [AI_PROVIDER](#ai_provider). |
| `AI_PROVIDER_ORDER`                          | `anthropic,openai,bedrock`       | Fallback order of the routed chain.                                                  |
| `ANTHROPIC_API_KEY_SECRET_ID`                | unset (AWS template: set)        | Secrets Manager secret (name or ARN) that holds the Anthropic key.                   |
| `OPENAI_API_KEY_SECRET_ID`                   | unset (AWS template: set)        | Secrets Manager secret (name or ARN) that holds the OpenAI key.                      |
| `AI_SECRETS_REGION`                          | `ap-southeast-1`                 | Region of those two secrets.                                                         |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`        | unset                            | Plain keys, **local development only**. Ignored when `NODE_ENV=production`.          |
| `BEDROCK_REGION` (alias `AI_BEDROCK_REGION`) | unset; the region is `us-east-1` | Bedrock region. Setting it is what puts Bedrock in the chain.                        |
| `AI_<PROVIDER>_MODEL_<TIER>`                 | see [Models](#models-and-tiers)  | Model per provider and tier, for example `AI_OPENAI_MODEL_STANDARD`.                 |
| `AI_<PROVIDER>_MONTHLY_CAP_USD`              | `190` / `190` / `300`            | Monthly spend cap per provider, for example `AI_BEDROCK_MONTHLY_CAP_USD`.            |
| `AI_MODEL` and the legacy provider settings  | unset                            | Legacy selectors only. See [Legacy providers](#legacy-providers).                    |

`<PROVIDER>` is `ANTHROPIC`, `OPENAI` or `BEDROCK`. `<TIER>` is `CHEAP`, `STANDARD` or `DEEP`.
`AWS_REGION` has nothing to do with AI. Bedrock uses `BEDROCK_REGION` and the key secrets use
`AI_SECRETS_REGION`.

### `AI_PROVIDER`

| Value                               | Behaviour                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| unset or empty                      | Routed chain, if at least one routed provider is configured. With none configured, AI is off (reason `DISABLED`), as on develop before DEV-576. |
| `auto`                              | Routed chain. With none configured, AI is unavailable (reason `NOT_CONFIGURED`).                                                                |
| `anthropic`, `openai`, `bedrock`    | Routed chain with that provider first. The others still follow as fallbacks, unless a SuperAdmin turns fallback off.                            |
| `disabled`                          | Hard off. The SuperAdmin settings cannot turn AI back on.                                                                                       |
| `azure`, `groq`, `google`, `vertex` | Legacy single-provider path. It bypasses routing, caps, the SuperAdmin settings and the spend ledger.                                           |
| anything else                       | AI unavailable (reason `INVALID_PROVIDER`).                                                                                                     |

`AI_PROVIDER_ORDER` takes a comma-separated list of `anthropic`, `openai` and `bedrock`.
Unknown or repeated names are dropped, and an empty result means the default order. A
provider left out of the list is never tried, unless it is the preferred or forced provider.

### API keys

A deployed environment names the secrets: `ANTHROPIC_API_KEY_SECRET_ID`,
`OPENAI_API_KEY_SECRET_ID`, and `AI_SECRETS_REGION`.

- **How the key is read.** The app calls `secretsmanager:GetSecretValue` with the AWS
  default credential chain (on AWS, the web task role).
- **Secret format.** The secret may hold the key as plain text, or as JSON. JSON is read from
  `apiKey`, `api_key`, `key` or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, or from its only string
  field.
- **Caching.** Each server process keeps the key in memory for 15 minutes. A failed read is
  retried after 1 minute. While a key cannot be read, that provider is skipped as not
  configured.
- **Rotation.** A rotated key takes effect within 15 minutes. A call that fails on the old key
  hands over to the next provider.
- **Logging.** Logs carry only the provider, the secret id, the region and the error name.
  They never carry the key.
- **Precedence.** A `*_SECRET_ID` wins over a plain key.

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` exist for local development. They are ignored when
`NODE_ENV=production`, so a deployed environment cannot fall back to a plain key. Never commit
a real key to any file.

### Bedrock

Bedrock is in the chain when `BEDROCK_REGION` (or `AI_BEDROCK_REGION`) is set, or when
`AI_PROVIDER=bedrock`. The region defaults to `us-east-1`.

- **Credentials.** The app uses the AWS default credential chain (`fromNodeProviderChain`), so
  on AWS it runs as the web task role. Never set `AWS_ACCESS_KEY_ID` or
  `AWS_SECRET_ACCESS_KEY` for it.
- **Inference profiles.** Models are reached through the **US geo inference profiles**. Called
  from `us-east-1`, these Claude models are not served by bare model id in that Region. The
  profile serves each request from one of its destination Regions: `us-east-1`, `us-east-2` or
  `us-west-2`.
- **API.** The SDK (`@ai-sdk/amazon-bedrock`) calls the Converse and ConverseStream APIs.

### Models and tiers

Each feature has a tier (`src/lib/ai/tiers.ts`):

- `periodic-owner-reports` uses `deep`.
- Ask Fathom, growth, WhatsApp, retention, analytics, Rx OCR and menu vision use `standard`.
- Any other or new feature uses `cheap`.

| Provider  | `cheap`                         | `standard`                       | `deep`                         |
| --------- | ------------------------------- | -------------------------------- | ------------------------------ |
| Anthropic | `claude-haiku-5-5`              | `claude-sonnet-5-5`              | `claude-opus-5-5`              |
| OpenAI    | `gpt-5.4-nano`                  | `gpt-5.4-mini`                   | `gpt-5.4`                      |
| Bedrock   | `us.anthropic.claude-haiku-5-5` | `us.anthropic.claude-sonnet-5-5` | `us.anthropic.claude-opus-5-5` |

Override a model with `AI_<PROVIDER>_MODEL_<TIER>`, or per tier in the SuperAdmin settings.

On AWS, the Bedrock models are template parameters, so the IAM policy follows them.
`AiBedrockCheapModelId`, `AiBedrockStandardModelId` and `AiBedrockDeepModelId` set
`AI_BEDROCK_MODEL_*`. A Bedrock model chosen in the SuperAdmin settings that is not one of
those three profiles is refused by IAM (`AccessDeniedException`). The call then fails over
like any other provider error.

### Spend caps

`AI_ANTHROPIC_MONTHLY_CAP_USD`, `AI_OPENAI_MONTHLY_CAP_USD` and `AI_BEDROCK_MONTHLY_CAP_USD`
default to **190, 190 and 300 USD**. A SuperAdmin cap wins over the environment.

- **Invalid values.** A malformed or negative value falls back to the default. It never lifts
  the cap.
- **Zero.** `0` makes the provider permanently capped.
- **The month.** The cap month is the **Asia/Karachi calendar month** (UTC+05:00).
- **When a provider is skipped.** Spend is summed from the ledger before every attempt. A
  provider whose spend has reached its cap is skipped. A provider whose spend cannot be read
  is also skipped (fail closed).
- **Soft limit.** Calls already in flight when a provider reaches its cap still finish, so a
  cap can be exceeded by those calls.

## Precedence

1. `AI_PROVIDER=disabled` turns AI off. A legacy selector (`azure`, `groq`, `google`,
   `vertex`) uses the legacy path, and nothing below applies to it.
2. SuperAdmin mode `Disabled` turns routed AI off.
3. **First provider:** a SuperAdmin force mode (`ForceAnthropic`, `ForceOpenAI`,
   `ForceBedrock`). Otherwise `AI_PROVIDER=anthropic|openai|bedrock`. Otherwise the first in
   the order.
4. **Order:** a saved, non-empty SuperAdmin order. Otherwise `AI_PROVIDER_ORDER`. Otherwise
   the default.
5. **Fallback:** the SuperAdmin `fallbackEnabled` setting (on by default). When it is off,
   only the first provider is tried.
6. **Caps and models:** a SuperAdmin value where one is saved. Otherwise the environment.
   Otherwise the code default.

In short: SuperAdmin settings beat the environment, and the environment beats the code
defaults. `AI_PROVIDER=disabled` is the one switch that SuperAdmin settings cannot override.

- **Settings cache.** Each server process caches the SuperAdmin settings for 30 seconds.
- **Settings read failures.** If the settings cannot be read, the environment policy applies,
  and the failure is logged.

## Fallback behaviour

- **Skipped providers.** A provider that is not configured (no secret id or key, no Bedrock
  region, or an unreadable key) is skipped. So is one that has reached its cap.
- **Errors before output.** A provider that throws before producing output hands over to the
  next provider. This covers authentication, rate limits, 5xx, network errors, an unknown
  model and IAM denials. The log line is
  `[ai-router] provider attempt failed; trying the next provider`, with the provider, the
  error name and the status.
- **Cancellation.** A cancellation (client abort or timeout) is never retried on another
  provider.
- **Streaming.** Failover happens only before the stream starts: connection, auth, rate-limit
  and 5xx errors all surface there. Once output flows, an error belongs to that provider's
  stream.
- **OpenAI storage.** OpenAI calls are sent with `store: false`.
- **When nothing is left.**
  - If every provider was attempted and failed, the reason is `PROVIDERS_FAILED`.
  - If every remaining candidate is capped, the reason is `CAPPED`.
  - If nothing is configured, the reason is `NOT_CONFIGURED`.
  - In each case `AIUnavailableError` is raised, and Ask Fathom answers 503 with its
    "unavailable" message. Ask Fathom checks this before it starts streaming (disabled,
    nothing configured, or everything capped).

## Cost ledger and prices

- **Spend ledger.** `ai_provider_usage` is the platform spend ledger that the caps read. It
  holds one row per successful routed call: provider, tier, model, feature, the organization
  (for attribution only), input and output tokens, `costUsd` and time.
  - It is platform-scoped, with forced RLS, and accessed only through `withPlatformDb`.
  - A failed attempt is not recorded.
  - If the ledger write fails, the paid output is still returned (fail open) and the failure
    is logged.
- **Tenant table.** Develop's tenant `ai_usage` table (organization and branch attribution
  through `routeAI`) is separate. It is never used for spend.
- **Prices.** `costUsd` uses the latest `ai_model_prices` row for the provider and model that
  was effective at call time. Without one, it uses the list price in `model-defaults.ts`
  (`DEFAULT_MODEL_PRICES_USD_PER_MTOK`, USD per million tokens). Bedrock list prices carry a
  10% allowance over first-party prices.
- **Unknown models.** A model with neither a price row nor a list price is charged
  deliberately high rates (15 / 75 USD per million tokens, or 16.5 / 82.5 for Bedrock), so it
  can only make a cap trip early.
- **Budget alert.** When a recorded call takes a provider to 80% of its cap, SuperAdmins get
  one platform notification for that provider and month (`ai_budget_alert_months`). See
  `maybeCreateAIBudgetAlert` in `src/lib/ai/usage.ts`. It is best effort and never fails a
  call.

## SuperAdmin switch

The AI section of the platform console's Settings page (`admin.<BaseDomain>`) is open to
`SUPER_ADMIN` only. It stores one `ai_settings` row:

- the mode: `Auto`, `ForceAnthropic`, `ForceOpenAI`, `ForceBedrock` or `Disabled`;
- the provider order;
- whether fallback is on;
- a cap per provider;
- a model per provider and tier.

An empty field means "use the environment". Every change is audited. The page never accepts
or shows a key.

## Legacy providers

`AI_PROVIDER=azure` (deprecated), `groq`, `google` or `vertex` selects one fixed model,
`AI_MODEL`, which has no default. That model's settings are:

- `azure`: `AZURE_OPENAI_RESOURCE_NAME`, authenticated with Azure identity.
- `groq`: `GROQ_API_KEY`.
- `google`: `GOOGLE_GENERATIVE_AI_API_KEY`.
- `vertex`: `GOOGLE_VERTEX_API_KEY`, or `GOOGLE_VERTEX_PROJECT` and `GOOGLE_VERTEX_LOCATION`.

These selectors are explicit only:

- They are never chosen by default.
- They are never added to the routed chain.
- They get no caps and no ledger rows.
- The AWS template does not offer them (`AiProvider` allows only `auto`, `anthropic`,
  `openai`, `bedrock` and `disabled`).

## AWS: what the environment template sets

`infra/aws/environment.yaml` passes the web container these values:

| Container variable                                                                        | Template parameter                                                            | Default                                         |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| `AI_PROVIDER`                                                                             | `AiProvider`                                                                  | `auto`                                          |
| `AI_PROVIDER_ORDER`                                                                       | `AiProviderOrder`                                                             | `anthropic,openai,bedrock`                      |
| `ANTHROPIC_API_KEY_SECRET_ID`                                                             | `AnthropicApiKeySecretId` (name only; empty means the default)                | `devfathom/<EnvironmentName>/anthropic-api-key` |
| `OPENAI_API_KEY_SECRET_ID`                                                                | `OpenAiApiKeySecretId` (name only; empty means the default)                   | `devfathom/<EnvironmentName>/openai-api-key`    |
| `AI_SECRETS_REGION`                                                                       | `AiSecretsRegion`                                                             | `ap-southeast-1`                                |
| `BEDROCK_REGION`                                                                          | fixed                                                                         | `us-east-1`                                     |
| `AI_BEDROCK_MODEL_CHEAP`, `AI_BEDROCK_MODEL_STANDARD`, `AI_BEDROCK_MODEL_DEEP`            | `AiBedrockCheapModelId`, `AiBedrockStandardModelId`, `AiBedrockDeepModelId`   | the three `us.anthropic.claude-*-5-5` profiles  |
| `AI_ANTHROPIC_MONTHLY_CAP_USD`, `AI_OPENAI_MONTHLY_CAP_USD`, `AI_BEDROCK_MONTHLY_CAP_USD` | `AiAnthropicMonthlyCapUsd`, `AiOpenAiMonthlyCapUsd`, `AiBedrockMonthlyCapUsd` | `190`, `190`, `300`                             |

- **No secrets created.** The template creates no AI secret: the two key secrets already
  exist, outside the stack.
- **No values injected.** It injects no key value: there is no `ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY` in the task definition.
- **Removed.** The `devfathom/<env>/anthropic-api-key` resource and its execution-role grant
  from `feat/ai-provider-5-infra` are removed. So are the `ap-southeast-1` Bedrock pin and the
  "stack only in ap-southeast-1" rule.
- **Production.** Before creating production, decide `AiProvider` and create the
  `devfathom/production/*` secrets. With `auto` and no secrets, only Bedrock can answer, and
  the app logs a secret read failure (at most once a minute per process, while calls are
  made).

### Which role

The web service runs on **ECS Fargate**, which has no EC2 instance profile.

- **The workload role.** Inside the container, the AWS SDK default credential chain resolves
  the ECS container credentials of the **task role, `WebTaskRole`**. That is the role the app
  uses for AWS: the "instance role" of this deployment, and the one that holds the policy
  below.
- **The execution role.** `WebTaskExecutionRole` is used only by the ECS agent (image pull,
  logs, `Secrets:` injection). It gets no AI permission, and neither does the migration
  task's role.
- **Running on EC2.** If the app is ever run directly on an EC2 host, attach the same policy
  to that host's instance-profile role. Nothing in the app changes.

### IAM policy for the develop / staging role

This is the effective policy for `EnvironmentName=staging`, with default parameters. Replace
`<account-id>`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadAIProviderKeys",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:ap-southeast-1:<account-id>:secret:devfathom/staging/anthropic-api-key-??????",
        "arn:aws:secretsmanager:ap-southeast-1:<account-id>:secret:devfathom/staging/openai-api-key-??????"
      ]
    },
    {
      "Sid": "InvokeUsInferenceProfiles",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:us-east-1:<account-id>:inference-profile/us.anthropic.claude-haiku-5-5",
        "arn:aws:bedrock:us-east-1:<account-id>:inference-profile/us.anthropic.claude-sonnet-5-5",
        "arn:aws:bedrock:us-east-1:<account-id>:inference-profile/us.anthropic.claude-opus-5-5"
      ]
    },
    {
      "Sid": "InvokeProfileModelsOnlyThroughProfiles",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-5-5",
        "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-5-5",
        "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-5-5",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5-5",
        "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-5-5",
        "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-5-5",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5",
        "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-opus-5-5",
        "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-5-5"
      ],
      "Condition": {
        "StringEquals": {
          "bedrock:InferenceProfileArn": [
            "arn:aws:bedrock:us-east-1:<account-id>:inference-profile/us.anthropic.claude-haiku-5-5",
            "arn:aws:bedrock:us-east-1:<account-id>:inference-profile/us.anthropic.claude-sonnet-5-5",
            "arn:aws:bedrock:us-east-1:<account-id>:inference-profile/us.anthropic.claude-opus-5-5"
          ]
        }
      }
    }
  ]
}
```

- **The `-??????` suffix.** It matches the six random characters that Secrets Manager appends
  to a secret's ARN. It is narrower than `-*`, which would also match a secret such as
  `devfathom/staging/anthropic-api-key-old`.
- **Converse.** The Converse API is authorized by `bedrock:InvokeModel`, and ConverseStream by
  `bedrock:InvokeModelWithResponseStream`. **There is no separate `bedrock:Converse` IAM
  action.**
- **What an inference-profile call needs.** It needs the profile ARN, plus the foundation
  model in every destination Region of that profile. The `bedrock:InferenceProfileArn`
  condition allows the foundation models only through those profiles. There is no wildcard
  model resource.
- **KMS.** If either key secret is encrypted with a customer managed KMS key rather than
  `aws/secretsmanager`, also allow `kms:Decrypt` on that key. Condition it on
  `kms:ViaService = secretsmanager.ap-southeast-1.amazonaws.com`.
- **Network.** Tasks reach Secrets Manager (`ap-southeast-1`), Bedrock Runtime (`us-east-1`),
  `api.anthropic.com` and `api.openai.com` over their public addresses. No VPC endpoint is
  needed.

### One-time account prerequisites (not in the template)

These are done once, by an administrator, not by the workload role.

- **Anthropic on Bedrock.** Submit the Anthropic first-time-use form (Bedrock console, or
  `PutUseCaseForModelAccess`).
- **First Bedrock call.** Make the first invocation of each model as a principal with
  `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe` and
  `aws-marketplace:ViewSubscriptions`. That call starts the Marketplace subscription.
  `WebTaskRole` deliberately has no Marketplace permission.
- **Check the destination Regions.** For each profile, confirm its destination Regions match
  the policy:

  ```bash
  aws bedrock get-inference-profile --region us-east-1 \
    --inference-profile-identifier us.anthropic.claude-sonnet-5-5 \
    --query 'models[].modelArn'
  ```

  A destination Region missing from the policy shows up as an occasional
  `AccessDeniedException`. Add it to `InvokeProfileModelsOnlyThroughProfiles` in the template.

- **Check the secrets.** Confirm both secrets exist, without printing their values:

  ```bash
  aws secretsmanager describe-secret --region ap-southeast-1 \
    --secret-id devfathom/staging/anthropic-api-key
  ```

### Rolling it out (not done by this change)

Nothing here has been deployed. For `devfathom-staging`:

1. **Check the old secret resource.** If the stack was ever updated from
   `feat/ai-provider-5-infra`, it holds an `AnthropicApiKeySecret` resource: the existing
   `devfathom/staging/anthropic-api-key` secret. The update removes it from the stack.
   Before executing, confirm that the deployed template set `DeletionPolicy: Retain` on it,
   so the secret and its value are kept:
   `aws cloudformation get-template --stack-name devfathom-staging`. **Do not execute the
   change set if it would delete that secret.**
2. **Create the change set.** Use the new template. Keep every other parameter's previous
   value, and pass `AiProvider=auto` explicitly, because the stack's previous value may be
   `disabled`.
3. **Review the change set:**
   - no secret is created or deleted;
   - `WebTaskRole` gains the two policies above;
   - neither execution role reads an AI secret;
   - the web task definition carries the variables in the table above.
4. **Execute.** ECS rolls the web service. Run the QA plan below.

**Rollback.** In the SuperAdmin settings, set mode `Disabled`: AI is off within 30 seconds,
with no deploy. For a hard off, update the stack with `AiProvider=disabled`.

## Local development

For a quick local run, set a plain key in `.env.local`, for example
`ANTHROPIC_API_KEY=<your key>`, and leave `AI_PROVIDER` unset or set it to `auto`.

- **Secrets Manager.** To test the deployed path locally, set the `*_SECRET_ID` variables and
  use an AWS profile (`AWS_PROFILE`) that can read them.
- **Bedrock.** To test Bedrock, set `BEDROCK_REGION=us-east-1` with such a profile. Static
  AWS keys in env files are not supported for Bedrock.
- **Tests.** The tests need no network: `bunx vitest run src/lib/ai src/app/api/assistant`
  fakes each provider's wire format.

## QA plan

Run this on the develop (staging) environment after rollout. You need:

- a SuperAdmin account;
- a tenant with Ask Fathom enabled;
- the web log group `/devfathom/staging/web`;
- read access to `ai_provider_usage`, through a migration-task-definition run with a command
  override.

1. **Baseline.** Ask Fathom answers, and a growth insight generates. A new ledger row shows
   `provider=anthropic` with the `standard` model. The log shows no `[ai-router]` warning.
2. **Each provider through the SuperAdmin switch.** Turn fallback off, then set
   `ForceAnthropic`, `ForceOpenAI` and `ForceBedrock` in turn. Wait 30 seconds after each
   change. Send one Ask Fathom message and generate one growth insight. Each ledger row shows
   the forced provider and its model for the tier. Streaming works on all three.
3. **Model per tier.** Change one provider's `standard` model in the SuperAdmin settings. The
   next row shows the new model. Restore it.
4. **Forced first-provider failure falls back.** Set mode `Auto` with fallback on. Set the
   Anthropic `standard` model to a model id that does not exist.
   - The next call succeeds.
   - The log shows `provider attempt failed; trying the next provider` with
     `provider: 'anthropic'`.
   - The ledger row shows `openai`.
   - Break OpenAI the same way, and the next call lands on `bedrock`.
   - Break all three, and Ask Fathom answers 503 (`PROVIDERS_FAILED`).
   - Restore the models. No real key or secret needs to change.
5. **Caps.** Set the Anthropic cap below this month's recorded Anthropic spend, for example
   `0.0001` once step 2 has recorded a call. The next call skips Anthropic without an error,
   and the row shows `openai`. Do the same for all three providers, and Ask Fathom answers 503
   (`CAPPED`) before streaming. Restore the caps, or clear them back to the environment
   defaults.
6. **Disabled.** Set SuperAdmin mode `Disabled`. Within 30 seconds Ask Fathom answers 503, and
   AI features show their unavailable state. Set it back to `Auto`.
7. **No Azure, no key leaks.**
   - `aws ecs describe-task-definition` for `devfathom-staging-web` shows only `*_SECRET_ID`
     names: no key values and no `AZURE_*` variables.
   - The ledger holds no `azure` row.
   - A CloudWatch Logs search for `sk-` finds nothing.

Automated coverage:

- `tests/infra/aws-environment.test.ts`: the template contract and least-privilege IAM.
- `src/lib/ai/router.routing.test.ts`: selection, fallback and caps.
- `src/lib/ai/secrets.test.ts`: key loading.
- `src/app/api/assistant/route.providers.e2e.test.ts`: offline end to end, through the real
  SDK providers.
