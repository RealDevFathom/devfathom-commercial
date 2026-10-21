import { afterEach, describe, expect, it, vi } from 'vitest';

import { encryptSecret } from '@/lib/secret-crypto';

import { isPublicHttpsUrl, resolveEvolutionConfig, type HostLookup } from './evolution';
import type { GrowthSettings } from './types';

const lookup: HostLookup = async (hostname) => {
  if (hostname === 'evolution.example') return ['8.8.8.8'];
  if (hostname === 'rebinding.example') return ['8.8.8.8', '10.1.0.5'];
  if (hostname === 'metadata.example') return ['169.254.169.254'];
  throw new Error(`unexpected lookup ${hostname}`);
};

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function settings(overrides: Partial<GrowthSettings> = {}): GrowthSettings {
  return {
    organizationId: 'org_1',
    monthlyBudgetMinor: 0,
    autoApproveUnderMinor: 0,
    quietHoursStart: 21,
    quietHoursEnd: 9,
    maxMsgsPerDay: 200,
    minSecondsBetweenMsgs: 4,
    waInstanceName: 'shop',
    waApiUrl: null,
    waApiKeyEnc: null,
    churnThreshold: 60,
    createdAt: new Date('2020-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Evolution base URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the configured base URL and the global key', async () => {
    const config = await resolveEvolutionConfig(
      settings(),
      env({ EVOLUTION_API_URL: 'http://localhost:8080', EVOLUTION_API_KEY: 'env-key' }),
      lookup
    );
    expect(config).toEqual({
      baseUrl: 'http://localhost:8080',
      apiKey: 'env-key',
      instance: 'shop',
    });
  });

  it('keeps the global key only when the tenant URL is that same origin', async () => {
    const config = await resolveEvolutionConfig(
      settings({ waApiUrl: 'http://localhost:8080/evolution' }),
      env({ EVOLUTION_API_URL: 'http://localhost:8080', EVOLUTION_API_KEY: 'env-key' }),
      lookup
    );
    expect(config).toMatchObject({ baseUrl: 'http://localhost:8080/evolution', apiKey: 'env-key' });
  });

  it('does not attach the global key to a different tenant URL', async () => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'growth-test-key');
    const configured = env({
      EVOLUTION_API_URL: 'http://localhost:8080',
      EVOLUTION_API_KEY: 'env-key',
    });
    expect(
      await resolveEvolutionConfig(
        settings({ waApiUrl: 'https://evolution.example' }),
        configured,
        lookup
      )
    ).toBeNull();
    const config = await resolveEvolutionConfig(
      settings({
        waApiUrl: 'https://evolution.example',
        waApiKeyEnc: encryptSecret('tenant-key'),
      }),
      configured,
      lookup
    );
    expect(config).toEqual({
      baseUrl: 'https://evolution.example',
      apiKey: 'tenant-key',
      instance: 'shop',
    });
  });

  it.each([
    'http://127.0.0.1:8080',
    'http://169.254.169.254/latest/meta-data',
    'https://169.254.169.254',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'http://evolution.example',
    'https://user:secret@evolution.example',
    'https://2130706433',
    'https://metadata.example',
    'https://rebinding.example',
  ])('rejects %s', async (waApiUrl) => {
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'growth-test-key');
    const config = await resolveEvolutionConfig(
      settings({ waApiUrl, waApiKeyEnc: encryptSecret('tenant-key') }),
      env({}),
      lookup
    );
    expect(config).toBeNull();
  });

  it('accepts a public https origin', async () => {
    await expect(isPublicHttpsUrl('https://evolution.example/path', lookup)).resolves.toBe(true);
    await expect(isPublicHttpsUrl('https://10.0.0.8', lookup)).resolves.toBe(false);
  });
});
