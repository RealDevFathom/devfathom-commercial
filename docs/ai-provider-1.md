# AI provider adapters — piece 1

## Design

- `anthropic` uses `@ai-sdk/anthropic` and only `ANTHROPIC_API_KEY`. Selecting it without that
  key returns the normal `NOT_CONFIGURED` availability result; provider construction never starts.
- `bedrock` uses `@ai-sdk/amazon-bedrock`. Its region is `AI_BEDROCK_REGION`, then `AWS_REGION`,
  then `ap-southeast-1`. Authentication is always `fromNodeProviderChain()`, supporting ECS task
  roles, instance roles, web identity, shared profiles and the rest of the AWS default chain. The
  adapter neither reads nor forwards static access keys.
- Existing `createAIModel` callers retain `AI_MODEL`. `getModelForTier` is the new tier-aware path;
  its optional per-tier override is the seam for database configuration in piece 2.
- Growth (including the current growth recommendation and pharmacy marketing identifiers),
  WhatsApp, retention and analytics are `standard`; periodic owner reports are `deep`; unknown
  identifiers default to `cheap`.

## Dependency and model decisions

The adapters use `@ai-sdk/anthropic` major 3 and `@ai-sdk/amazon-bedrock` major 4, matching AI SDK
6 and the repository's provider-utils 4 pin. `@aws-sdk/credential-providers` is direct because the
Bedrock adapter explicitly owns credential-chain selection.

Defaults are centralized in `src/lib/ai/model-defaults.ts`: Claude Haiku 4.5, Sonnet 4.6 and Opus
4.6. Bedrock uses the corresponding Bedrock IDs; Opus uses the APAC cross-region inference profile
appropriate for the default Singapore region. Deployments must confirm model access and regional
availability in their AWS account, and can override an ID without changing adapter code.

## Follow-ups

- Piece 2 can load tenant/database overrides and pass the resulting tier map to `getModelForTier`.
- Deployment owners must grant Bedrock invoke permissions and model access to the workload role.
- The lockfile is intentionally left for the CTO's dependency install/CI pass, per the handoff.
