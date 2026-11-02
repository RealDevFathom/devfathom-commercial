import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiKeySource, extractAPIKey } from './ai-credentials';
import { __setSecretsReaderForTests, loadProviderAPIKey } from './secrets';

const SECRET_ENV = {
  NODE_ENV: 'production',
  ANTHROPIC_API_KEY_SECRET_ID: 'devfathom/staging/anthropic-api-key',
  OPENAI_API_KEY_SECRET_ID: 'devfathom/staging/openai-api-key',
  AI_SECRETS_REGION: 'ap-southeast-1',
};

afterEach(() => {
  __setSecretsReaderForTests(null);
  vi.restoreAllMocks();
});

describe('API key source', () => {
  it('prefers the Secrets Manager id and defaults the region to ap-southeast-1', () => {
    expect(
      apiKeySource('anthropic', { ANTHROPIC_API_KEY_SECRET_ID: 'id', ANTHROPIC_API_KEY: 'k' })
    ).toEqual({
      kind: 'secret',
      secretId: 'id',
      region: 'ap-southeast-1',
    });
  });

  it('accepts a plain key only outside production', () => {
    expect(apiKeySource('openai', { NODE_ENV: 'development', OPENAI_API_KEY: 'k' })).toEqual({
      kind: 'local-env',
      envName: 'OPENAI_API_KEY',
    });
    expect(apiKeySource('openai', { NODE_ENV: 'production', OPENAI_API_KEY: 'k' })).toBeNull();
    expect(apiKeySource('openai', {})).toBeNull();
  });

  it.each([
    ['plain-key', 'plain-key'],
    ['  padded-key \n', 'padded-key'],
    ['{"apiKey":"json-key"}', 'json-key'],
    ['{"ANTHROPIC_API_KEY":"named-key","other":1}', 'named-key'],
    ['{"only":"single-string"}', 'single-string'],
    ['{"a":"one","b":"two"}', null],
    ['{not json', null],
    ['', null],
  ])('extracts %j as %j', (secret, expected) => {
    expect(extractAPIKey(secret, 'anthropic')).toBe(expected);
  });
});

describe('loadProviderAPIKey', () => {
  it('reads each secret once through the instance-role client and caches it', async () => {
    const reader = vi.fn(async (secretId: string) => ({ SecretString: `key-for-${secretId}` }));
    __setSecretsReaderForTests(reader);
    await expect(loadProviderAPIKey('anthropic', SECRET_ENV, 1_000)).resolves.toBe(
      'key-for-devfathom/staging/anthropic-api-key'
    );
    await expect(loadProviderAPIKey('anthropic', SECRET_ENV, 2_000)).resolves.toBe(
      'key-for-devfathom/staging/anthropic-api-key'
    );
    await expect(loadProviderAPIKey('openai', SECRET_ENV, 2_000)).resolves.toBe(
      'key-for-devfathom/staging/openai-api-key'
    );
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenCalledWith('devfathom/staging/anthropic-api-key', 'ap-southeast-1');
  });

  it('refreshes after the cache window', async () => {
    const reader = vi.fn(async () => ({ SecretString: 'k' }));
    __setSecretsReaderForTests(reader);
    await loadProviderAPIKey('anthropic', SECRET_ENV, 0);
    await loadProviderAPIKey('anthropic', SECRET_ENV, 16 * 60_000);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    let release!: (value: { SecretString: string }) => void;
    const reader = vi.fn(
      () => new Promise<{ SecretString: string }>((resolve) => (release = resolve))
    );
    __setSecretsReaderForTests(reader);
    const first = loadProviderAPIKey('openai', SECRET_ENV, 0);
    const second = loadProviderAPIKey('openai', SECRET_ENV, 0);
    release({ SecretString: 'shared' });
    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared']);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('returns null on a read failure without logging the key, and retries after a minute', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reader = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }))
      .mockResolvedValue({ SecretString: 'sk-live-should-never-be-logged' });
    __setSecretsReaderForTests(reader);
    await expect(loadProviderAPIKey('anthropic', SECRET_ENV, 0)).resolves.toBeNull();
    await expect(loadProviderAPIKey('anthropic', SECRET_ENV, 30_000)).resolves.toBeNull();
    await expect(loadProviderAPIKey('anthropic', SECRET_ENV, 61_000)).resolves.toBe(
      'sk-live-should-never-be-logged'
    );
    expect(error).toHaveBeenCalledWith('[ai-secrets] could not read API key secret', {
      provider: 'anthropic',
      secretId: 'devfathom/staging/anthropic-api-key',
      region: 'ap-southeast-1',
      error: 'AccessDeniedException',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('sk-live');
  });

  it('uses the local key outside production and never calls AWS', async () => {
    const reader = vi.fn();
    __setSecretsReaderForTests(reader);
    await expect(
      loadProviderAPIKey('openai', { NODE_ENV: 'development', OPENAI_API_KEY: ' local ' })
    ).resolves.toBe('local');
    await expect(
      loadProviderAPIKey('openai', { NODE_ENV: 'production', OPENAI_API_KEY: 'x' })
    ).resolves.toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });
});
