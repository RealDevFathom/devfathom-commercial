import { oversizedRequest } from '../../../../tests/fixtures/bounded-request';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  pass: null as null | Record<string, unknown>,
  registrations: [] as { pass: { serialNumber: string; contentRevision: number } }[],
  existingRegistration: false,
  rateLimit: vi.fn(() => ({ ok: true, retryAfter: 0, remaining: 1 })),
}));

const tenantDb = vi.hoisted(() => ({
  walletPassRegistration: {
    findUnique: vi.fn(async () => (state.existingRegistration ? { id: 'registration-1' } : null)),
    upsert: vi.fn(async () => ({})),
  },
}));

const registrationFindMany = vi.hoisted(() => vi.fn(async () => state.registrations));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({
      walletPass: { findUnique: vi.fn(async () => state.pass) },
      walletPassRegistration: { findMany: registrationFindMany },
      platformSetting: {
        findUnique: vi.fn(async () => ({ value: 'pass.com.devfathom.loyalty' })),
      },
    }),
  withTenantDb: (_organizationId: string, run: (db: typeof tenantDb) => unknown) => run(tenantDb),
}));

vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '127.0.0.1',
  rateLimit: state.rateLimit,
}));

import {
  acceptAppleLogs,
  listUpdatedApplePasses,
  registerApplePass,
  sendUpdatedApplePass,
} from './apple-web-service';

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
    state.registrations = [];
    state.existingRegistration = false;
    vi.clearAllMocks();
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

  it('returns 201 for a new registration and 200 for an idempotent registration', async () => {
    const token = 'wpa_00000000000000000000000000';
    state.pass = {
      id: 'pass-1',
      organizationId: 'org-1',
      loyaltyAccountId: 'account-1',
      customerId: 'customer-1',
      appleAuthTokenHash: createHash('sha256').update(token).digest('hex'),
      status: 'ACTIVE',
      contentRevision: 1,
      updatedAt: new Date(),
    };

    expect((await registerApplePass(request(token), params)).status).toBe(201);
    state.existingRegistration = true;
    expect((await registerApplePass(request(token), params)).status).toBe(200);
    expect(tenantDb.walletPassRegistration.upsert).toHaveBeenCalledTimes(2);
  });

  it('lists only revisions newer than passesUpdatedSince and returns 204 when none remain', async () => {
    state.registrations = [
      { pass: { serialNumber: params.serialNumber, contentRevision: 4 } },
      { pass: { serialNumber: 'wps_11111111111111111111111111', contentRevision: 7 } },
    ];
    const updated = await listUpdatedApplePasses(
      new Request('https://wallet.devfathom.com/api/wallet/apple?passesUpdatedSince=3'),
      params
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      serialNumbers: [params.serialNumber, 'wps_11111111111111111111111111'],
      lastUpdated: '7',
    });
    expect(registrationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          pass: expect.objectContaining({ contentRevision: { gt: 3 } }),
        }),
      })
    );

    state.registrations = [];
    const none = await listUpdatedApplePasses(
      new Request('https://wallet.devfathom.com/api/wallet/apple?passesUpdatedSince=7'),
      params
    );
    expect(none.status).toBe(204);
    expect(await none.text()).toBe('');
  });

  it('always accepts Apple log payloads without reflecting them', async () => {
    const malformed = await acceptAppleLogs(
      new Request('https://wallet.devfathom.com/api/wallet/apple/v1/log', {
        method: 'POST',
        body: '{not-json',
      })
    );
    expect(malformed.status).toBe(200);
    expect(await malformed.text()).toBe('');
  });
});

it('stops reading a chunked body at the limit', async () => {
  const limit = 64_000;
  const { request, cancelled, bytesRead } = oversizedRequest(limit);
  expect((await acceptAppleLogs(request)).status).toBe(413);
  expect(cancelled()).toBe(true);
  expect(bytesRead()).toBeLessThanOrEqual(limit + 16_384);
});

it('keeps the empty acknowledgement for an interrupted Apple log', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('stream interrupted'));
    },
  });
  const request = new Request('https://wallet.example.test', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
  const response = await acceptAppleLogs(request);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('');
});

it('uses the Apple IP limit before consuming a log', async () => {
  state.rateLimit.mockReturnValueOnce({ ok: false, retryAfter: 19, remaining: 0 });
  const { request, bytesRead } = oversizedRequest(64_000);
  const response = await acceptAppleLogs(request);
  expect(state.rateLimit).toHaveBeenCalledWith('wallet-apple:ip:127.0.0.1', 120, 60_000);
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('19');
  expect(bytesRead()).toBe(0);
  expect(await response.text()).toBe('');
});
