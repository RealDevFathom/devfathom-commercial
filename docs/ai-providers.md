# AI providers

Last reviewed: 2026-11-02 (DEV-576). This page replaces `docs/ai-provider-1.md` to
`docs/ai-provider-5.md`.

DevFathom sends AI calls (Ask Fathom, growth insights, owner reports, and other features)
through one **routed chain** of three providers, in this order:

1. **Anthropic API**: `claude-sonnet-5-5` for everything by default.
2. **OpenAI API**: `gpt-6.1-sol` through the Responses API, with `store: false`.
3. **Amazon Bedrock**: the global cross-Region profiles `global.anthropic.claude-sonnet-5-5`
   and `global.anthropic.claude-haiku-5-5`, called from `ap-southeast-1`, with personal data
   masked before the request is sent.

Each provider has a model per tier and a monthly spend cap. A SuperAdmin can change the
active provider, the order, the models per tier and the caps without a deploy.

- **Keys.** The Anthropic and OpenAI keys live in AWS Secrets Manager. The app reads them at
  runtime through its AWS role. They are never in the task definition, the container
  environment, CloudFormation or the logs.
- **Bedrock.** Bedrock uses the same AWS role and no static AWS keys.
- **Azure.** Azure is never used for routed AI. Azure OpenAI stays in the code only as a
  legacy selector, together with `groq`, `google` and `vertex`. None of them is ever the
  default, and none is ever part of the fallback chain.
- **Production.** The AWS template turns AI off in production unless `AiProvider` is set
  explicitly. Staging defaults to the routed chain.

Code: `src/lib/ai/provider.ts` (selection), `router.ts` (chain, caps, failover, circuit
breaker), `model-defaults.ts` (defaults, prices and env names), `tiers.ts` (feature tiers),
`turn-budget.ts` (per-turn limits), `ai-credentials.ts` and `secrets.ts` (keys), `spend.ts`
(ledger). Infrastructure: `infra/aws/environment.yaml`.

## Environment variables

| Variable                                     | Default                                                           | Purpose                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                                | unset (AWS template: `auto` in staging, `disabled` in production) | Turns AI on or off and picks routed or legacy mode. See [AI_PROVIDER](#ai_provider).                        |
| `AI_PROVIDER_ORDER`                          | `anthropic,openai,bedrock`                                        | Fallback order of the routed chain.                                                                         |
| `ANTHROPIC_API_KEY_SECRET_ID`                | unset (AWS template: set)                                         | Secrets Manager secret (name or ARN) that holds the Anthropic key.                                          |
| `OPENAI_API_KEY_SECRET_ID`                   | unset (AWS template: set)                                         | Secrets Manager secret (name or ARN) that holds the OpenAI key.                                             |
| `AI_SECRETS_REGION`                          | `ap-southeast-1`                                                  | Region of those two secrets.                                                                                |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`        | unset                                                             | Plain keys, **local development only**. Ignored when `NODE_ENV=production`.                                 |
| `BEDROCK_REGION` (alias `AI_BEDROCK_REGION`) | unset, so Bedrock is off (AWS template: `ap-southeast-1`)         | Bedrock source Region. Setting it is what puts Bedrock in the chain. Use `ap-southeast-1`.                  |
| `AF_HAIKU_LOOKUPS`                           | `false`                                                           | `true` lets the small model answer Ask Fathom quick lookups. Anything else sends them to the default model. |
| `AI_<PROVIDER>_MODEL_<TIER>`                 | see [Models](#models-and-tiers)                                   | Model per provider and tier, for example `AI_OPENAI_MODEL_STANDARD`.                                        |
| `AI_<PROVIDER>_MONTHLY_CAP_USD`              | `190` / `190` / `300`                                             | Monthly spend cap per provider, for example `AI_BEDROCK_MONTHLY_CAP_USD`.                                   |
| `AI_MODEL` and the legacy provider settings  | unset                                                             | Legacy selectors only. See [Legacy providers](#legacy-providers).                                           |

`<PROVIDER>` is `ANTHROPIC`, `OPENAI` or `BEDROCK`. `<TIER>` is `CHEAP`, `STANDARD` or `DEEP`.
`AWS_REGION` has nothing to do with AI. Bedrock uses `BEDROCK_REGION` and the key secrets use
`AI_SECRETS_REGION`.

### `AI_PROVIDER`

| Value                               | Behaviour                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset or empty                      | **Off** (reason `DISABLED`), even when keys or a Bedrock region are present. AI is never on by default; set `auto` or a provider name to turn it on. |
| `auto`                              | Routed chain. With none configured, AI is unavailable (reason `NOT_CONFIGURED`).                                                                     |
| `anthropic`, `openai`, `bedrock`    | Routed chain with that provider first. The others still follow as fallbacks, unless a SuperAdmin turns fallback off.                                 |
| `disabled`                          | Hard off. The SuperAdmin settings cannot turn AI back on.                                                                                            |
| `azure`, `groq`, `google`, `vertex` | Legacy single-provider path. It bypasses routing, caps, the SuperAdmin settings and the spend ledger.                                                |
| anything else                       | AI unavailable (reason `INVALID_PROVIDER`).                                                                                                          |

On AWS, the template parameter `AiProvider` defaults to empty, which means the environment
default: `auto` in staging and `disabled` in production. Production AI stays off until its
keys exist and someone sets `AiProvider` explicitly.

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
`AI_PROVIDER=bedrock`. The source Region is `ap-southeast-1`, which is both the code default
and the AWS template default.

- **Credentials.** The app uses the AWS default credential chain (`fromNodeProviderChain`), so
  on AWS it runs as the web task role. Never set `AWS_ACCESS_KEY_ID` or
  `AWS_SECRET_ACCESS_KEY` for it.
- **Global inference profiles.** From `ap-southeast-1`, the 5.5 models are offered only
  through the global cross-Region profiles `global.anthropic.claude-sonnet-5-5` and
  `global.anthropic.claude-haiku-5-5`. A global profile can serve a request from any
  supported commercial Region, so processing may leave Singapore. Invocation logs and data at
  rest stay in the source Region.
- **Personal-data masking.** Because processing may happen in any Region, personal data (for
  example customer names, phone numbers and email addresses) is masked in the prompt before a
  request is sent to Bedrock.
- **No 4.x models.** The Bedrock defaults are the 5.5 global profiles. Do not point the
  Bedrock tiers at older 4.x profiles.
- **API.** The SDK (`@ai-sdk/amazon-bedrock`) calls the Converse and ConverseStream APIs.

### Models and tiers

Each feature has a tier (`src/lib/ai/tiers.ts`):

- Ask Fathom, growth, marketing assistance, WhatsApp, retention, analytics, Rx OCR and menu
  vision use `standard`.
- An Ask Fathom **quick lookup** (a short read-only question that needs one read tool and has
  no write intent) uses `cheap`.
- `weekly-owner-summary` and `periodic-owner-reports` use `deep`.
- Any other or new feature uses `cheap`.

| Provider  | `cheap`                                                                 | `standard`                           | `deep`                                                                   |
| --------- | ----------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| Anthropic | `claude-haiku-5-5` (only with `AF_HAIKU_LOOKUPS=true`)                  | `claude-sonnet-5-5`                  | `claude-opus-5-5` (weekly owner summary and opted-in deep strategy only) |
| OpenAI    | `gpt-6-luna` (only with `AF_HAIKU_LOOKUPS=true`)                        | `gpt-6.1-sol`                        | `gpt-6.1-sol`                                                            |
| Bedrock   | `global.anthropic.claude-haiku-5-5` (only with `AF_HAIKU_LOOKUPS=true`) | `global.anthropic.claude-sonnet-5-5` | `global.anthropic.claude-sonnet-5-5`                                     |

- **The default model.** `claude-sonnet-5-5` answers everything unless a rule below applies.
- **Small model behind a flag.** With `AF_HAIKU_LOOKUPS` unset or `false` (the default), the
  `cheap` tier resolves to the provider's `standard` model. The flag stays off until the small
  model passes the 125-question evaluation. With the flag on, an empty or cut-off answer from
  the small model is sent again to the default model.
- **Opus.** `claude-opus-5-5` always writes the weekly owner summary. It runs deep strategy
  only for a pharmacy that has opted in (`organizations."aiDeepStrategyEnabled"`, default
  `false`). Any other `deep` request resolves to the `standard` model.
- **Weekly owner summary.**
  - The routing policy is in code. Feature id `weekly-owner-summary` runs on Anthropic only
    and never fails over (it still honours the SuperAdmin `Disabled` switch).
  - The retry schedule is in code: +15 minutes, +1 hour and +6 hours
    (`WEEKLY_SUMMARY_RETRY_DELAYS_MS` and `nextWeeklySummaryAttemptAt` in
    `src/lib/ai/workload.ts`).
  - **The weekly summary itself is not built yet.** No job generates or schedules it today.
    Whoever builds it must use this feature id and this retry schedule.
- **OpenAI.** Calls use the Responses API with `store: false`, so OpenAI keeps no stored
  response for later retrieval.

Override a model with `AI_<PROVIDER>_MODEL_<TIER>`, or per tier in the SuperAdmin settings.
Both win over the defaults above.

On AWS, `AiBedrockCheapModelId`, `AiBedrockStandardModelId` and `AiBedrockDeepModelId` set
`AI_BEDROCK_MODEL_*`. They accept `global`, `us`, `eu`, `apac`, `au` and `jp` Anthropic
profile ids. The IAM policy allows every Anthropic Claude model and profile, so IAM does not
refuse a Bedrock model chosen in the SuperAdmin settings, as long as it is an Anthropic
Claude model.

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

## Failover and limits

The router tries the providers in order. It fails over **only on availability errors**:
connection failures, timeouts, 429, 5xx/529, and billing or authentication stops. It never
fails over on a refusal, a 400, or a consent or permission denial inside the app.

| Error                                                                                                                                                                                                                                     | Retry once                           | Fail over | Circuit breaker     | Alert                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------- | ------------------- | -------------------------------------------------------------------- |
| Connection error, retryable fetch error, per-attempt timeout (not the caller's abort)                                                                                                                                                     | yes                                  | yes       | counts              | none                                                                 |
| 408, 500, 502, 503, 504, 529; Bedrock `ThrottlingException`, `ModelNotReady`, `ServiceUnavailable`, `InternalServer`                                                                                                                      | yes                                  | yes       | counts              | none                                                                 |
| 429 rate limit                                                                                                                                                                                                                            | only if `retry-after` is 3 s or less | yes       | counts              | none                                                                 |
| Billing or quota stop: 402; 429 `insufficient_quota` or a spend, credit or usage limit; a 400 about credit balance, usage limits or billing; Bedrock `AccessDenied` about Marketplace, a subscription or "not available for this account" | no                                   | yes       | open for 10 minutes | log                                                                  |
| 401                                                                                                                                                                                                                                       | no                                   | yes       | open for 10 minutes | SuperAdmin platform notification, at most once per provider per hour |
| 403 or 404 from the provider (key lacks permission, model not found)                                                                                                                                                                      | no                                   | yes       | open for 10 minutes | log                                                                  |
| Other 400, 413, 422; an invalid 2xx response; a refusal (`finishReason` `content-filter`)                                                                                                                                                 | no                                   | **no**    | no                  | none                                                                 |
| Caller abort (request aborted, turn deadline)                                                                                                                                                                                             | no                                   | no        | no                  | none                                                                 |

- **Retries.** SDK retries are off. The router makes at most one retry per provider, after a
  jittered delay of 0.5 to 2 seconds, and honours a `retry-after` of up to 3 seconds.
- **Circuit breaker.** Each provider has one in-memory breaker per server process.
  - It opens after 5 consecutive counted failures within 60 seconds, and stays open for 60
    seconds.
  - It then lets one probe through. A success closes it; a failure opens it again.
  - Billing, quota and authentication stops open it for 10 minutes.
  - An open provider is skipped with reason `CIRCUIT_OPEN`.
- **Per-turn limits for Ask Fathom.** One owner turn gets:
  - 90 seconds in total (the route's `maxDuration` is 120 seconds);
  - at most **4 model calls**, counting every first call, retry and failover;
  - at most **6 tool calls**. A seventh tool call returns `Tool call limit reached for this
turn.` without running.

  When the turn runs out of model calls or time, the router stops with reason `TURN_LIMIT`.

- **Streaming.** Failover happens only before the stream starts. Once output flows, an error
  belongs to that provider's stream.
- **Skipped providers.** A provider is skipped when it is not configured (no secret id or
  key, no Bedrock region, or an unreadable key), when it has reached its cap, or when its
  breaker is open. A failed attempt logs
  `[ai-router] provider attempt failed` with `{ provider, kind, status, next }`, where
  `kind` is the classified error and `next` is `retry`, `next` or `stop`.
- **When nothing is left.**
  - If every provider was attempted and failed, the reason is `PROVIDERS_FAILED`.
  - If every remaining candidate is capped, the reason is `CAPPED`.
  - If nothing is configured, the reason is `NOT_CONFIGURED`.
  - `TURN_LIMIT` and `CIRCUIT_OPEN` are described above.
  - In each case `AIUnavailableError` is raised, and Ask Fathom answers 503 with its
    "unavailable" message. Ask Fathom checks this before it starts streaming (disabled,
    nothing configured, or everything capped).

## Answer safety

- **Numbers come from tools.** SQL and the assistant tools compute every number. Before an
  answer reaches the owner, a grounding post-check compares each figure in the text with:
  - the numbers in this turn's tool results (including minor units divided by 100, ratios
    shown as percentages, and list lengths);
  - the owner's own messages;
  - small integers up to 10, and dates, times and years.

  A figure matches within its displayed precision, including k, lakh, crore and million. If a
  figure has no source, the answer is replaced with a fixed message and the server logs
  `ASSISTANT_GROUNDING_REJECTED` (counts only, no content).

- **Writes are drafts.** An AI write is a draft that a person confirms. Each write is
  recorded in the `AIAssistantAction` ledger (tenant RLS) under an idempotency key: a sha256
  of the organization, user, tool call id, tool name and canonical input. A row moves through
  `PROPOSED`, `EXECUTING`, `SUCCEEDED` and `FAILED`.
  - A missing row or a changed payload is refused.
  - A write that already succeeded returns the stored result. It is never replayed.
  - A failover never replays a write.
- **No dosing advice.** An answer with dosing instructions (frequency, administration or
  per-kg dosing) is replaced with a fixed message that refers the owner to a pharmacist. Plain
  strengths such as "500mg" in a stock list are fine.
- **No drug names in customer text.** Customer-facing text never names a drug. A pharmacy
  marketing draft that contains any of the tenant's medicine names (product, brand, alias or
  ingredient) is rejected.

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
  (`DEFAULT_MODEL_PRICES_USD_PER_MTOK`). List prices in USD per million tokens:

  | Model                                 | Input             | Output            |
  | ------------------------------------- | ----------------- | ----------------- |
  | `claude-sonnet-5-5`                   | 2                 | 10                |
  | `claude-opus-5-5`                     | 4                 | 20                |
  | `gpt-6.1-sol`                         | 2                 | 10                |
  | `claude-haiku-5-5`                    | 0.10              | 0.50              |
  | `gpt-6-luna`                          | 0.10              | 0.50              |
  | Bedrock `global.anthropic.*` profiles | first-party price | first-party price |

  The Bedrock global profiles cost the same as the first-party models, with no premium.

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

| Container variable                                                                        | Template parameter                                                            | Default                                                                                                         |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                                                                             | `AiProvider` (empty means the environment default)                            | `auto` in staging, `disabled` in production                                                                     |
| `AI_PROVIDER_ORDER`                                                                       | `AiProviderOrder`                                                             | `anthropic,openai,bedrock`                                                                                      |
| `ANTHROPIC_API_KEY_SECRET_ID`                                                             | `AnthropicApiKeySecretId` (name only; empty means the default)                | `devfathom/<EnvironmentName>/anthropic-api-key`                                                                 |
| `OPENAI_API_KEY_SECRET_ID`                                                                | `OpenAiApiKeySecretId` (name only; empty means the default)                   | `devfathom/<EnvironmentName>/openai-api-key`                                                                    |
| `AI_SECRETS_REGION`                                                                       | `AiSecretsRegion`                                                             | `ap-southeast-1`                                                                                                |
| `BEDROCK_REGION`                                                                          | `AiBedrockRegion`                                                             | `ap-southeast-1`                                                                                                |
| `AI_BEDROCK_MODEL_CHEAP`, `AI_BEDROCK_MODEL_STANDARD`, `AI_BEDROCK_MODEL_DEEP`            | `AiBedrockCheapModelId`, `AiBedrockStandardModelId`, `AiBedrockDeepModelId`   | `global.anthropic.claude-haiku-5-5`, `global.anthropic.claude-sonnet-5-5`, `global.anthropic.claude-sonnet-5-5` |
| `AF_HAIKU_LOOKUPS`                                                                        | `AiHaikuLookups`                                                              | `false`                                                                                                         |
| `AI_ANTHROPIC_MONTHLY_CAP_USD`, `AI_OPENAI_MONTHLY_CAP_USD`, `AI_BEDROCK_MONTHLY_CAP_USD` | `AiAnthropicMonthlyCapUsd`, `AiOpenAiMonthlyCapUsd`, `AiBedrockMonthlyCapUsd` | `190`, `190`, `300`                                                                                             |

- **No secrets created.** The template creates no AI secret: the two key secrets already
  exist, outside the stack.
- **No values injected.** It injects no key value: there is no `ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY` in the task definition.
- **Removed.** The `devfathom/<env>/anthropic-api-key` resource and its execution-role grant
  from `feat/ai-provider-5-infra` are removed, and so is the "stack only in ap-southeast-1"
  rule. The earlier `us-east-1` Bedrock pin and its US-profile policy are replaced by the
  `ap-southeast-1` global profiles and the policy below.
- **Production.** AI is off in production by default. Before turning it on, create the
  `devfathom/production/*` secrets, then update the stack with `AiProvider=auto`.

### Which role

The web service runs on **ECS Fargate**, which has no EC2 instance profile.

- **The workload role.** Inside the container, the AWS SDK default credential chain resolves
  the ECS container credentials of the **task role, `WebTaskRole`**. That is the role the app
  uses for AWS: the "instance role" of this deployment, and the one that holds the policy
  below.
- **The execution role.** `WebTaskExecutionRole` is used only by the ECS agent (image pull,
  logs, `Secrets:` injection). It gets no AI permission, and neither does the migration
  task's role.
- **Running on EC2.** When the app runs directly on an EC2 host, attach the same grants to
  that host's instance-profile role. Nothing in the app changes.
  - The develop host `devfathom-pharmacy` runs as `inky-ec2-ssm`. Its Bedrock calls still go
    to `ap-southeast-1`, whatever the host's own Region.
  - `inky-ec2-ssm` is shared with the `inky-codex` instance. A dedicated role keeps the grant
    to the develop host only.

### IAM policy for the ECS task role (staging)

This is the effective `WebTaskRole` policy for `EnvironmentName=staging` with default
parameters, on account `892667864163`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadAIProviderKeys",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:ap-southeast-1:892667864163:secret:devfathom/staging/anthropic-api-key-??????",
        "arn:aws:secretsmanager:ap-southeast-1:892667864163:secret:devfathom/staging/openai-api-key-??????"
      ]
    },
    {
      "Sid": "InvokeAnthropicInferenceProfiles",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:*:892667864163:inference-profile/*anthropic.claude-*"
    },
    {
      "Sid": "InvokeAnthropicRegionalModels",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
    },
    {
      "Sid": "InvokeAnthropicGlobalModels",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:::foundation-model/anthropic.claude-*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "unspecified" } }
    }
  ]
}
```

### IAM policy for the develop EC2 role (`inky-ec2-ssm`)

The develop host runs the app directly on EC2 as `inky-ec2-ssm`. It needs the same grants,
with the two existing secret ARNs written out in full:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadAIProviderKeys",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:ap-southeast-1:892667864163:secret:devfathom/staging/anthropic-api-key-s7n0T1",
        "arn:aws:secretsmanager:ap-southeast-1:892667864163:secret:devfathom/staging/openai-api-key-m9NFZr"
      ]
    },
    {
      "Sid": "InvokeAnthropicInferenceProfiles",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:*:892667864163:inference-profile/*anthropic.claude-*"
    },
    {
      "Sid": "InvokeAnthropicRegionalModels",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
    },
    {
      "Sid": "InvokeAnthropicGlobalModels",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:::foundation-model/anthropic.claude-*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "unspecified" } }
    }
  ]
}
```

- **Why three Bedrock statements.** A call to a global profile needs three grants: the
  profile ARN, the foundation model in the Region that serves the request, and the
  Region-less global foundation-model ARN (`arn:aws:bedrock:::foundation-model/...`). AWS
  evaluates that last ARN with `aws:RequestedRegion` set to `unspecified`, which is the
  condition on the third statement. The policy covers every Anthropic Claude model and
  profile (`global`, `us`, `eu`, `apac`, `au`, `jp`), and nothing else.
- **The `-??????` suffix.** In the task role, it matches the six random characters that
  Secrets Manager appends to a secret's ARN. It is narrower than `-*`, which would also match
  a secret such as `devfathom/staging/anthropic-api-key-old`. The EC2 role names the exact
  ARNs.
- **Converse.** The Converse API is authorized by `bedrock:InvokeModel`, and ConverseStream by
  `bedrock:InvokeModelWithResponseStream`. **There is no separate `bedrock:Converse` IAM
  action.**
- **KMS.** If either key secret is encrypted with a customer managed KMS key rather than
  `aws/secretsmanager`, also allow `kms:Decrypt` on that key. Condition it on
  `kms:ViaService = secretsmanager.ap-southeast-1.amazonaws.com`.
- **Network.** The app reaches Secrets Manager and Bedrock Runtime in `ap-southeast-1`,
  `api.anthropic.com` and `api.openai.com` over their public addresses. No VPC endpoint is
  needed.

### One-time account prerequisites (not in the template)

These are done once, by an administrator, not by the workload role.

- **Anthropic on Bedrock.** Submit the Anthropic first-time-use form (Bedrock console, or
  `PutUseCaseForModelAccess`) and wait for AWS to approve it.
- **First Bedrock call.** Make the first invocation of each model as a principal with
  `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe` and
  `aws-marketplace:ViewSubscriptions`. That call starts the Marketplace subscription. The
  workload roles deliberately have no Marketplace permission.
- **Check the profiles.** Confirm each global profile is active from the source Region:

  ```bash
  aws bedrock get-inference-profile --region ap-southeast-1 \
    --inference-profile-identifier global.anthropic.claude-sonnet-5-5
  ```

- **Check the secrets.** Confirm both secrets exist, without printing their values:

  ```bash
  aws secretsmanager describe-secret --region ap-southeast-1 \
    --secret-id devfathom/staging/anthropic-api-key
  ```

### Live status (account 892667864163, 2026-11-02)

- **Secrets.** Both staging secrets exist in `ap-southeast-1`, use the AWS-managed
  `aws/secretsmanager` key and hold `{"value": "<key>"}`. Neither is owned by a
  CloudFormation stack.
- **Anthropic and OpenAI.** These two are the providers to test live on develop:
  `claude-sonnet-5-5` first and `gpt-6.1-sol` (Responses API, `store: false`) as the
  fallback, with the keys from Secrets Manager.
- **Bedrock.** `global.anthropic.claude-sonnet-5-5` and `global.anthropic.claude-haiku-5-5`
  are ACTIVE in `ap-southeast-1`. Invocation is **pending AWS approval of the Anthropic
  use-case form**, which has been submitted. Bedrock stays wired and tested offline. **The
  live Bedrock test is pending that approval.**
- **Live check.** `bun run ai:smoke` (`scripts/ai-provider-smoke.ts`) calls each provider
  directly, the routed chain, and a forced Anthropic to OpenAI fallback. It uses the app's own
  key loader and prints no key. Run it from a checkout with credentials that carry the policy
  above. Until AWS approves the form, pass `--skip-bedrock`, or expect the Bedrock step to
  fail with an access error.
  - On a host without Node, such as the develop EC2 host, `bun run ai:smoke` stops at the
    `server-only` guard. Run it with Bun directly instead:
    `bun --conditions=react-server scripts/ai-provider-smoke.ts --skip-bedrock`.
  - **Develop result, 2 Nov at 21:40 UTC:** every check passed.
    - Anthropic and OpenAI answered directly.
    - The routed chain answered on the default model.
    - The cheap tier stayed on the default model.
    - The weekly summary used the deep model on Anthropic.
    - The forced fallback was answered by OpenAI.
    - Bedrock was skipped until AWS approves the form.

### Rolling it out (not done by this change)

For `devfathom-staging`:

1. **Check the old secret resource.** If the stack was ever updated from
   `feat/ai-provider-5-infra`, it holds an `AnthropicApiKeySecret` resource: the existing
   `devfathom/staging/anthropic-api-key` secret. The update removes it from the stack.
   Before executing, confirm that the deployed template set `DeletionPolicy: Retain` on it,
   so the secret and its value are kept:
   `aws cloudformation get-template --stack-name devfathom-staging`. **Do not execute the
   change set if it would delete that secret.**
2. **Create the change set.** Use the new template. Keep every other parameter's previous
   value. Leave `AiProvider` empty (staging then gets `auto`), or pass `auto` explicitly if
   the stack's previous value is `disabled`.
3. **Review the change set:**
   - no secret is created or deleted;
   - `WebTaskRole` gains the policies above;
   - neither execution role reads an AI secret;
   - the web task definition carries the variables in the table above.
4. **Execute.** ECS rolls the web service. Run the QA plan below.

For production, leave `AiProvider` empty until the production secrets exist.

**Rollback.** In the SuperAdmin settings, set mode `Disabled`: AI is off within 30 seconds,
with no deploy. For a hard off, update the stack with `AiProvider=disabled`.

## Local development

For a quick local run, set a plain key in `.env.local`, for example
`ANTHROPIC_API_KEY=<your key>`, and set `AI_PROVIDER=auto`. Unset means off.

- **Secrets Manager.** To test the deployed path locally, set the `*_SECRET_ID` variables and
  use an AWS profile (`AWS_PROFILE`) that can read them.
- **Bedrock.** To test Bedrock, set `BEDROCK_REGION=ap-southeast-1` with such a profile.
  Static AWS keys in env files are not supported for Bedrock.
- **Small model.** `AF_HAIKU_LOOKUPS=false` is the default. Set it to `true` only to try quick
  lookups on the small model.
- **Tests.** The tests need no network: `bunx vitest run src/lib/ai src/app/api/assistant`
  fakes each provider's wire format.

## QA plan

Run this on the develop (staging) environment after rollout. You need:

- a SuperAdmin account;
- a tenant with Ask Fathom enabled;
- the web logs;
- read access to `ai_provider_usage`.

1. **Baseline.** Ask Fathom answers, and a growth insight generates. A new ledger row shows
   `provider=anthropic` with `claude-sonnet-5-5`. The log shows no `[ai-router]` warning.
2. **Each provider through the SuperAdmin switch.** Turn fallback off, then set
   `ForceAnthropic` and `ForceOpenAI` in turn. Wait 30 seconds after each change. Send one Ask
   Fathom message and generate one growth insight. Each ledger row shows the forced provider
   and its model for the tier. Streaming works on both. Repeat with `ForceBedrock` only after
   AWS approves the Anthropic use-case form.
3. **Model per tier.** Change one provider's `standard` model in the SuperAdmin settings. The
   next row shows the new model. Restore it.
4. **Forced first-provider failure falls back.** Run `bun run ai:smoke` on the host (see
   "Live check"). Its fallback check gives Anthropic a model id that does not exist **in the
   script's own process**:
   - The routed answer comes from `openai` with `gpt-6.1-sol`.
   - The script's log shows `[ai-router] provider attempt failed` with
     `provider: 'anthropic'` and `next: 'next'`.

   Do not set a non-existent model in the SuperAdmin settings on a live server. A 404 is a
   configuration fault, so it opens Anthropic's circuit breaker for 10 minutes in that server
   process, and later QA steps would then pass for the wrong reason.

5. **No failover on a refusal or a bad request.** A request that the provider rejects as
   invalid (400), or refuses, surfaces as is. No other provider is tried.
6. **Turn limits.** A turn that needs more than 6 tool calls gets the limit message for the
   seventh, and no turn makes more than 4 model calls.
7. **Grounding and safety.** An answer never shows a figure that is not in a tool result. A
   dosing question gets the refer-to-pharmacist message.
8. **Caps.** Set the Anthropic cap below this month's recorded Anthropic spend, for example
   `0.0001` once step 2 has recorded a call. The next call skips Anthropic without an error,
   and the row shows `openai`. Restore the cap.
9. **Disabled.** Set SuperAdmin mode `Disabled`. Within 30 seconds Ask Fathom answers 503, and
   AI features show their unavailable state. Set it back to `Auto`.
10. **No Azure, no key leaks.**
    - The task definition, or the develop host's environment, shows only `*_SECRET_ID` names:
      no key values and no `AZURE_*` variables.
    - The ledger holds no `azure` row.
    - A log search for `sk-` finds nothing.

Automated coverage:

- `tests/infra/aws-environment.test.ts`: the template contract and the IAM policy.
- `src/lib/ai/router.routing.test.ts`: selection, failover, caps and the circuit breaker.
- `src/lib/ai/secrets.test.ts`: key loading.
- `src/app/api/assistant/route.providers.e2e.test.ts`: offline end to end, through the real
  SDK providers.
