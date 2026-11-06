/**
 * DEV-576 live provider smoke check.
 *
 * Run on a server whose role can read the two key secrets and call Bedrock (the
 * develop instance), with the app's env loaded:
 *
 *   bun run ai:smoke                    # each provider directly, then the routed chain and its fallback
 *   bun run ai:smoke -- --no-db         # same, without the settings/spend database (in-memory ledger)
 *   bun run ai:smoke -- --skip-bedrock  # Anthropic and OpenAI only (Bedrock pending AWS approval)
 *
 * Every check uses the application's own code: the Secrets Manager key loader, the
 * provider SDK construction and the routed chain (with its one jittered retry,
 * failover and circuit breaker). The output names the provider, model, outcome,
 * latency and the first words of each answer. API keys are never printed: a key is
 * reported only as present or missing, and error text is scrubbed of anything that
 * looks like a key before it is shown.
 *
 * Without --no-db the routed calls are metered into ai_provider_usage under the
 * feature "ai-smoke" (a few hundred tokens), and SuperAdmin settings apply. A
 * SuperAdmin model override or force mode can stop the forced-fallback check from
 * exercising the fallback; the script says so when that happens.
 */
import 'dotenv/config';

import { generateText } from 'ai';

import {
  DEFAULT_MODELS,
  bedrockRegion,
  getDefaultModelId,
  haikuLookupsEnabled,
  modelEnvName,
  ROUTED_AI_PROVIDERS,
  type TieredAIProviderName,
} from '../src/lib/ai/model-defaults';
import { createTieredModel, readAIProviderReadiness } from '../src/lib/ai/provider';
import { createRoutedLanguageModel } from '../src/lib/ai/routed-model';
import { __setRouterDependenciesForTests } from '../src/lib/ai/router';
import { loadProviderAPIKey } from '../src/lib/ai/secrets';
import type { AITier } from '../src/lib/ai/tiers';

type Env = Record<string, string | undefined>;
type Outcome = { label: string; ok: boolean | 'skipped'; detail: string };

const PROMPT = 'Reply with exactly these four words: DevFathom provider check OK';
const MAX_OUTPUT_TOKENS = 256;
const MISSING_MODEL = 'devfathom-smoke-missing-model';

const noDb = process.argv.includes('--no-db');
const skipBedrock = process.argv.includes('--skip-bedrock');
const outcomes: Outcome[] = [];
/** Keys loaded in this run, so error text can be scrubbed of them. */
const loadedKeys: string[] = [];

function scrub(text: string): string {
  let safe = text;
  for (const key of loadedKeys) if (key) safe = safe.split(key).join('[key]');
  return safe
    .replace(/\b(?:sk|sk-ant|sk-proj|ant)-[A-Za-z0-9_*.-]{4,}/g, '[key]')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, '[key]')
    .replace(/(Bearer|x-api-key[:=]?)\s+\S+/gi, '$1 [key]');
}

function describeError(error: unknown): string {
  if (!error || typeof error !== 'object') return scrub(String(error));
  const e = error as { name?: string; statusCode?: number; reason?: string; message?: string };
  const parts = [e.name ?? 'Error'];
  if (typeof e.statusCode === 'number') parts.push(`HTTP ${e.statusCode}`);
  if (e.reason) parts.push(e.reason);
  if (e.message) parts.push(e.message.replace(/\s+/g, ' ').slice(0, 160));
  return scrub(parts.join(' · '));
}

function snippet(text: string) {
  return JSON.stringify(text.trim().slice(0, 60));
}

async function direct(provider: TieredAIProviderName, env: Env) {
  const modelId = getDefaultModelId(provider, 'standard', undefined, env);
  const label = `direct ${provider} (${modelId}${provider === 'bedrock' ? ` from ${bedrockRegion(env)}` : ''})`;
  if (provider === 'bedrock' && skipBedrock) {
    outcomes.push({
      label,
      ok: 'skipped',
      detail: 'skipped (--skip-bedrock): live test pending AWS approval',
    });
    return;
  }
  let apiKey: string | null = null;
  if (provider !== 'bedrock') {
    apiKey = await loadProviderAPIKey(provider, env);
    if (!apiKey) {
      outcomes.push({
        label,
        ok: false,
        detail: `no API key: check ${provider.toUpperCase()}_API_KEY_SECRET_ID, AI_SECRETS_REGION and secretsmanager:GetSecretValue`,
      });
      return;
    }
    loadedKeys.push(apiKey);
  }
  const started = Date.now();
  try {
    const result = await generateText({
      model: createTieredModel({ provider, modelId, apiKey, env }),
      prompt: PROMPT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      // No data retention at OpenAI.
      providerOptions: provider === 'openai' ? { openai: { store: false } } : undefined,
    });
    outcomes.push({
      label,
      ok: result.text.trim().length > 0,
      detail: `${Date.now() - started} ms · ${result.usage.inputTokens ?? '?'} in / ${result.usage.outputTokens ?? '?'} out · ${snippet(result.text)}`,
    });
  } catch (error) {
    outcomes.push({
      label,
      ok: false,
      detail: `${Date.now() - started} ms · ${describeError(error)}`,
    });
  }
}

async function routed(
  label: string,
  env: Env,
  options: {
    tier?: AITier;
    feature?: string;
    expectProviderNot?: TieredAIProviderName;
    expectModel?: string;
  } = {}
) {
  const started = Date.now();
  try {
    const result = await generateText({
      model: createRoutedLanguageModel({
        tier: options.tier ?? 'standard',
        feature: options.feature ?? 'ai-smoke',
        organizationId: null,
        env,
      }),
      prompt: PROMPT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
    });
    const routing = result.providerMetadata?.devfathomRouting as
      { provider?: string; modelId?: string } | undefined;
    const answeredBy = `${routing?.provider ?? '?'} (${routing?.modelId ?? '?'})`;
    const fellBack = options.expectProviderNot
      ? routing?.provider !== options.expectProviderNot
      : true;
    const rightModel = options.expectModel ? routing?.modelId === options.expectModel : true;
    outcomes.push({
      label,
      ok: result.text.trim().length > 0 && fellBack && rightModel,
      detail:
        `${Date.now() - started} ms · answered by ${answeredBy} · ${snippet(result.text)}` +
        (fellBack
          ? ''
          : ` · fallback NOT exercised: ${options.expectProviderNot} still answered (a SuperAdmin model override or force mode wins over the env override)`) +
        (rightModel ? '' : ` · expected model ${options.expectModel}`),
    });
  } catch (error) {
    outcomes.push({
      label,
      ok: false,
      detail: `${Date.now() - started} ms · ${describeError(error)}`,
    });
  }
}

async function main() {
  const env: Env = { ...process.env };
  if (skipBedrock) {
    // Keep Bedrock out of the routed chain too, so a failure cannot land there.
    delete env.BEDROCK_REGION;
    delete env.AI_BEDROCK_REGION;
  }
  if (noDb) {
    __setRouterDependenciesForTests({
      storedSettings: async () => null,
      spend: async () => 0,
      record: async () => 0,
      alert: async () => undefined,
      authAlert: async () => undefined,
      deepStrategyEnabled: async () => false,
    });
  }

  const readiness = readAIProviderReadiness(env);
  console.log(
    `AI_PROVIDER=${env.AI_PROVIDER ?? '(unset → off)'} · readiness: ${JSON.stringify(readiness)}`
  );
  console.log(
    `database settings and ledger: ${noDb ? 'skipped (--no-db)' : 'live'} · Bedrock: ${skipBedrock ? 'skipped' : bedrockRegion(env)} · AF_HAIKU_LOOKUPS: ${haikuLookupsEnabled(env)}\n`
  );

  for (const provider of ROUTED_AI_PROVIDERS) await direct(provider, env);

  await routed('routed chain (configured order)', env);

  // The cheap tier stays on the standard model unless AF_HAIKU_LOOKUPS=true.
  await routed('routed cheap tier', env, {
    tier: 'cheap',
    expectModel: haikuLookupsEnabled(env)
      ? undefined
      : getDefaultModelId(ROUTED_AI_PROVIDERS[0], 'standard', undefined, env),
  });

  // The weekly owner summary: the deep model on Anthropic only, never failed over.
  await routed('routed weekly owner summary (Anthropic deep, no failover)', env, {
    feature: 'weekly-owner-summary',
    tier: 'deep',
    expectModel: getDefaultModelId('anthropic', 'deep', undefined, env),
  });

  // Force the first provider of the default order to fail with a model that does not
  // exist (a 404), so the chain must hand over to the next provider.
  const first = ROUTED_AI_PROVIDERS[0];
  await routed(
    `routed fallback (${first} given ${MISSING_MODEL})`,
    { ...env, AI_PROVIDER: 'auto', [modelEnvName(first, 'standard')]: MISSING_MODEL },
    { expectProviderNot: first }
  );

  for (const outcome of outcomes) {
    const status = outcome.ok === 'skipped' ? 'SKIP' : outcome.ok ? 'PASS' : 'FAIL';
    console.log(`${status}  ${outcome.label}\n      ${outcome.detail}`);
  }
  console.log(
    `\nDefault standard-tier models: ${ROUTED_AI_PROVIDERS.map((p) => `${p}=${DEFAULT_MODELS[p].standard}`).join(', ')}`
  );
  const failed = outcomes.filter((outcome) => outcome.ok === false).length;
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(`smoke check crashed: ${describeError(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!noDb) {
      const { db } = await import('../src/lib/db');
      await db.$disconnect().catch(() => undefined);
    }
  });
