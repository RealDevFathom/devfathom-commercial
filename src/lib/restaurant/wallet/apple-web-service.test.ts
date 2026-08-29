import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ pass: null as null | Record<string, unknown> }));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({
      walletPass: { findUnique: vi.fn(async () => state.pass) },
      platformSetting: {
        findUnique: vi.fn(async () => ({ value: 'pass.com.devfathom.loyalty' })),
      },
    }),
  withTenantDb: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '127.0.0.1',
  rateLimit: () => ({ ok: true, retryAfter: 0, remaining: 1 }),
}));

import { registerApplePass, sendUpdatedApplePass } from './apple-web-service';

const params = {
  deviceLibraryIdentifier: 'device-1',
  passTypeIdentifier: 'pass.com.devfathom.loyalty',
  serialNumber: 'wps_00000000000000000000000000',
};

function request(token: string) {
  return new Request('https://wallet.devfathom.com/api/wallet/apple', {
    method: 'POST',
    headers: { Authorization: `ApplePass ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pushToken: 'push-token' }),
  });
}

describe('Apple web-service authentication', () => {
  beforeEach(() => {
    state.pass = null;
  });

  it('makes unknown serial and bad token responses byte-identical', async () => {
    const unknown = await registerApplePass(request('wpa_unknown'), params);
    state.pass = {
      id: 'pass-1',
      organizationId: 'org-1',
      loyaltyAccountId: 'account-1',
      customerId: 'customer-1',
      appleAuthTokenHash: '0'.repeat(64),
      status: 'ACTIVE',
      contentRevision: 1,
      updatedAt: new Date(),
    };
    const bad = await registerApplePass(request('wpa_bad'), params);
    expect(unknown.status).toBe(401);
    expect(bad.status).toBe(401);
    expect(await unknown.arrayBuffer()).toEqual(await bad.arrayBuffer());
    expect([...unknown.headers]).toEqual([...bad.headers]);
  });

  it('rejects a revoked pass before tenant reads or package construction', async () => {
    state.pass = {
      id: 'pass-1',
      organizationId: 'org-1',
      loyaltyAccountId: 'account-1',
      customerId: 'customer-1',
      appleAuthTokenHash: '0'.repeat(64),
      status: 'REVOKED',
      contentRevision: 1,
      updatedAt: new Date(),
    };
    const response = await sendUpdatedApplePass(request('wpa_bad'), {
      passTypeIdentifier: params.passTypeIdentifier,
      serialNumber: params.serialNumber,
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
  });
});
