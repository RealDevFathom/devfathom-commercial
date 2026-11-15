import 'server-only';

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { apiKeySource, extractAPIKey, type KeyedAIProvider } from './ai-credentials';

type Env = Record<string, string | undefined>;
type SecretValue = { SecretString?: string; SecretBinary?: Uint8Array };
export type SecretsReader = (
  secretId: string,
  region: string,
  signal: AbortSignal
) => Promise<SecretValue>;

const SUCCESS_TTL_MS = 15 * 60_000;
const FAILURE_TTL_MS = 60_000;
/**
 * A stalled read counts as a failed one. Ask Fathom's launcher availability waits on
 * this read, and the SDK's HTTP handler has no timeout by default.
 */
export const SECRET_READ_TIMEOUT_MS = 5_000;

const clients = new Map<string, SecretsManagerClient>();
/** Credentials come from the default AWS chain: the EC2 instance / task role. */
const defaultReader: SecretsReader = async (secretId, region, signal) => {
  let client = clients.get(region);
  if (!client) {
    client = new SecretsManagerClient({
      region,
      requestHandler: {
        connectionTimeout: SECRET_READ_TIMEOUT_MS,
        requestTimeout: SECRET_READ_TIMEOUT_MS,
      },
    });
    clients.set(region, client);
  }
  return client.send(new GetSecretValueCommand({ SecretId: secretId }), { abortSignal: signal });
};

/** The reader's answer, or a TimeoutError once the deadline passes (the read is aborted). */
async function readWithDeadline(secretId: string, region: string): Promise<SecretValue> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error('Secret read timed out.'), { name: 'TimeoutError' });
      controller.abort(error);
      reject(error);
    }, SECRET_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([reader(secretId, region, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

let reader: SecretsReader = defaultReader;
const cache = new Map<string, { value: string | null; expiresAt: number }>();
const inflight = new Map<string, Promise<string | null>>();

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) return String(error.name);
  return 'Error';
}

/**
 * The provider's API key, or null when none is configured or the secret cannot
 * be read. Keys are cached in memory (15 minutes; a failure is retried after one
 * minute) and are never logged: diagnostics carry only the provider, the secret
 * id, the region and the error name.
 */
export async function loadProviderAPIKey(
  provider: KeyedAIProvider,
  env: Env = process.env,
  now: number = Date.now()
): Promise<string | null> {
  const source = apiKeySource(provider, env);
  if (!source) return null;
  if (source.kind === 'local-env') return env[source.envName]?.trim() || null;

  // The extracted key depends on the provider (one secret may hold both keys).
  const cacheKey = `${provider}|${source.region}|${source.secretId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const load = (async () => {
    try {
      const secret = await readWithDeadline(source.secretId, source.region);
      const raw =
        secret.SecretString ??
        (secret.SecretBinary ? Buffer.from(secret.SecretBinary).toString('utf8') : '');
      const key = extractAPIKey(raw, provider);
      if (!key) {
        console.error('[ai-secrets] secret holds no usable API key', {
          provider,
          secretId: source.secretId,
          region: source.region,
        });
      }
      cache.set(cacheKey, { value: key, expiresAt: now + (key ? SUCCESS_TTL_MS : FAILURE_TTL_MS) });
      return key;
    } catch (error) {
      console.error('[ai-secrets] could not read API key secret', {
        provider,
        secretId: source.secretId,
        region: source.region,
        error: errorName(error),
      });
      cache.set(cacheKey, { value: null, expiresAt: now + FAILURE_TTL_MS });
      return null;
    } finally {
      inflight.delete(cacheKey);
    }
  })();
  inflight.set(cacheKey, load);
  return load;
}

export function __setSecretsReaderForTests(next: SecretsReader | null) {
  reader = next ?? defaultReader;
  cache.clear();
  inflight.clear();
}
