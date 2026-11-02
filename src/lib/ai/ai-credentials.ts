import { DEFAULT_AI_SECRETS_REGION, type TieredAIProviderName } from './model-defaults';

type Env = Record<string, string | undefined>;
export type KeyedAIProvider = Extract<TieredAIProviderName, 'anthropic' | 'openai'>;

export const API_KEY_SECRET_ID_ENV: Readonly<Record<KeyedAIProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY_SECRET_ID',
  openai: 'OPENAI_API_KEY_SECRET_ID',
};

/** Plain keys are a local-development convenience only; never read in production. */
export const LOCAL_API_KEY_ENV: Readonly<Record<KeyedAIProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export type APIKeySource =
  | { kind: 'secret'; secretId: string; region: string }
  | { kind: 'local-env'; envName: string };

/**
 * Where a provider's API key comes from, without reading it. Deployed
 * environments name an AWS Secrets Manager secret (read at runtime through the
 * instance role); a plain key variable counts only outside production.
 */
export function apiKeySource(provider: KeyedAIProvider, env: Env = process.env): APIKeySource | null {
  const secretId = env[API_KEY_SECRET_ID_ENV[provider]]?.trim();
  if (secretId) {
    return {
      kind: 'secret',
      secretId,
      region: env.AI_SECRETS_REGION?.trim() || DEFAULT_AI_SECRETS_REGION,
    };
  }
  const envName = LOCAL_API_KEY_ENV[provider];
  if (env.NODE_ENV !== 'production' && env[envName]?.trim()) return { kind: 'local-env', envName };
  return null;
}

/**
 * A secret may hold the key as plain text or as JSON. JSON is read from a known
 * field name, or from its only string value. Anything else is treated as no key.
 */
export function extractAPIKey(secretString: string, provider: KeyedAIProvider): string | null {
  const text = secretString.trim();
  if (!text) return null;
  if (!text.startsWith('{')) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  for (const field of ['apiKey', 'api_key', 'key', LOCAL_API_KEY_ENV[provider]]) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const strings = Object.values(record).filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  return strings.length === 1 ? strings[0].trim() : null;
}
