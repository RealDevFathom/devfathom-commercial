> Superseded by [AI providers](./ai-providers.md) (DEV-576). Kept for history; do not follow it.

# AI provider infrastructure (piece 5 of 5)

This branch contains only the AWS CloudFormation changes for the AI-provider work. It is
independent of pieces 2–4 and **must be rebased onto the routing sibling branch after that
branch lands**. During that rebase, confirm the three model defaults below still match the
model IDs selected by piece 1/piece 2; the environment-variable contract is already fixed.

No Azure/Bicep files are changed, and this work does not deploy anything.

## Design

`infra/aws/environment.yaml` now:

- creates `devfathom/<environment>/anthropic-api-key` without `SecretString` or
  `GenerateSecretString`. Consequently the template, stack parameters and stack events never
  contain the key;
- injects that secret into the web container as `ANTHROPIC_API_KEY`. ECS resolves task-definition
  secrets before container startup, so only the **task execution role** receives
  `secretsmanager:GetSecretValue`. The application task role does not need or receive that
  permission;
- passes `AI_BEDROCK_REGION=ap-southeast-1` and the routing contract's
  `AI_BEDROCK_HAIKU_MODEL_ID`, `AI_BEDROCK_SONNET_MODEL_ID`, and
  `AI_BEDROCK_OPUS_MODEL_ID` variables. Their values are the APAC inference-profile IDs derived
  from the three CloudFormation foundation-model parameters;
- grants the web task role only `bedrock:InvokeModel` and
  `bedrock:InvokeModelWithResponseStream`, on the three named foundation models and their three
  named APAC inference profiles. Every ARN is pinned to `ap-southeast-1`; there is no wildcard
  model resource; and
- rejects deployment of this environment template outside `ap-southeast-1` so the policy and
  workload region cannot silently diverge.

The defaults are:

| Route | Foundation model parameter default | Container model ID |
| --- | --- | --- |
| Haiku | `anthropic.claude-3-5-haiku-20241022-v1:0` | `apac.anthropic.claude-3-5-haiku-20241022-v1:0` |
| Sonnet | `anthropic.claude-3-5-sonnet-20241022-v2:0` | `apac.anthropic.claude-3-5-sonnet-20241022-v2:0` |
| Opus | `anthropic.claude-3-opus-20240229-v1:0` | `apac.anthropic.claude-3-opus-20240229-v1:0` |

`AI_PROVIDER` retains its existing `disabled` staging default. The change adds no compute,
schedule, endpoint, database, or other always-on workload.

## Supplying the Anthropic key

Create or update the stack once while the service remains scaled to zero, then supply the value
out of band. Do not place the value in shell history; read it silently and pass it on standard
input:

```bash
read -rsp 'Anthropic API key: ' ANTHROPIC_API_KEY && echo
aws secretsmanager put-secret-value \
  --region ap-southeast-1 \
  --secret-id "devfathom/${ENVIRONMENT_NAME}/anthropic-api-key" \
  --secret-string file:///dev/stdin <<<"${ANTHROPIC_API_KEY}"
unset ANTHROPIC_API_KEY
```

The secret initially has no `AWSCURRENT` version. A web task must not be started (and an existing
service must not be rolled to this task definition) until the command succeeds, because ECS
cannot inject a versionless secret. For an existing environment, the safe rollout is two stack
updates: first set `DesiredCount=0` and create the empty secret, populate it, then restore the
desired count with the AI settings.

## Validation and follow-ups

The CTO should run, after rebasing onto the routing sibling:

```bash
cfn-lint infra/aws/environment.yaml infra/aws/shared.yaml
```

Also create a CloudFormation change set (do not execute it initially) in `ap-southeast-1` and
confirm:

1. `AnthropicApiKeySecret` has neither secret-value property.
2. The execution-role secret statement contains that secret's exact ARN.
3. The task-role Bedrock statement expands to exactly six model/profile ARNs and no `*` resource.
4. The rendered web container has all four AI environment variables and the one ECS secret.
5. The migration task receives neither the Anthropic key nor Bedrock permissions.

Before merging the rebased result, compare the three parameter defaults with piece 1/piece 2.
If those pieces selected different IDs, update the defaults here while retaining the exact
environment-variable names above. Bedrock model access must also be enabled for the selected
models in the target account and region; this template deliberately does not automate account
model-access enrollment.
