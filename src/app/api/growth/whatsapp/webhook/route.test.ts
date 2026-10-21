// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withPlatformDb: vi.fn(),
  withTenantDb: vi.fn(),
  isGrowthEnabled: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb,
  withTenantDb: mocks.withTenantDb,
}));
vi.mock('@/lib/growth', () => ({ isGrowthEnabled: mocks.isGrowthEnabled }));

import { handleGrowthWebhook } from '@/lib/growth/whatsapp/inbound';
import { createMemoryStore } from '@/lib/growth/whatsapp/memory-store';

import { POST } from './route';

const secret = 'growth-webhook-secret';

function request(url: string, body: unknown, headers?: Record<string, string>) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('growth WhatsApp webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('GROWTH_WEBHOOK_SECRET', secret);
    mocks.withPlatformDb.mockImplementation(async (run) =>
      run({
        growthSettings: {
          findMany: async () => [{ organizationId: 'org_1', waInstanceName: 'shop' }],
        },
      })
    );
    mocks.isGrowthEnabled.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    request('http://localhost/api/growth/whatsapp/webhook?secret=wrong', {
      event: 'messages.update',
    }),
    request(
      'http://localhost/api/growth/whatsapp/webhook',
      { event: 'messages.update' },
      {
        'x-growth-webhook-secret': 'wrong',
      }
    ),
    request('http://localhost/api/growth/whatsapp/webhook', { event: 'messages.update' }),
  ])('rejects a wrong secret with 401 before any database read', async (incoming) => {
    const response = await POST(incoming);
    expect(response.status).toBe(401);
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.isGrowthEnabled).not.toHaveBeenCalled();
  });

  it('rejects the secret from the query string and from the apikey header', async () => {
    const query = await POST(
      request(`http://localhost/api/growth/whatsapp/webhook?secret=${secret}`, {
        event: 'messages.update',
      })
    );
    const apikey = await POST(
      request(
        'http://localhost/api/growth/whatsapp/webhook',
        { event: 'messages.update' },
        { apikey: secret }
      )
    );
    expect(query.status).toBe(401);
    expect(apikey.status).toBe(401);
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
  });

  it('rejects every request when the webhook secret is unset', async () => {
    vi.stubEnv('GROWTH_WEBHOOK_SECRET', '');
    const response = await POST(
      request(
        'http://localhost/api/growth/whatsapp/webhook',
        { event: 'messages.update' },
        { 'x-growth-webhook-secret': secret }
      )
    );
    expect(response.status).toBe(401);
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
  });

  it('rate-limits by IP before parsing the body', async () => {
    const headers = {
      'x-forwarded-for': '203.0.113.44',
      'x-growth-webhook-secret': secret,
    };
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await POST(
        request('http://localhost/api/growth/whatsapp/webhook', { event: 'nope' }, headers)
      );
      expect(response.status).toBe(200);
    }
    const blocked = await POST(
      new Request('http://localhost/api/growth/whatsapp/webhook', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{',
      })
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
  });

  it('returns 204 when growth is off and does not open a tenant transaction', async () => {
    mocks.isGrowthEnabled.mockResolvedValue(false);
    const response = await POST(
      request(
        'http://localhost/api/growth/whatsapp/webhook',
        {
          event: 'messages.update',
          instance: 'shop',
          data: { keyId: 'wamid.1', status: 'DELIVERY_ACK' },
        },
        { 'x-growth-webhook-secret': secret }
      )
    );
    expect(response.status).toBe(204);
    expect(mocks.withPlatformDb).toHaveBeenCalledOnce();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('ignores an unknown event with 200', async () => {
    const response = await POST(
      request(
        'http://localhost/api/growth/whatsapp/webhook',
        {
          event: 'qrcode.updated',
          instance: 'shop',
        },
        { 'x-growth-webhook-secret': secret }
      )
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: true });
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
  });

  it('flips a sent row to delivered', async () => {
    const store = createMemoryStore();
    await store.insertMessage({
      organizationId: 'org_1',
      customerId: 'c1',
      direction: 'out',
      waMessageId: 'wamid.1',
      body: 'Offer. Reply STOP to opt out.',
      status: 'sent',
      campaignId: null,
      recipientId: null,
      error: null,
    });
    await handleGrowthWebhook({
      store,
      provider: { sendText: vi.fn(), getStatus: async () => 'connected' },
      organizationId: 'org_1',
      businessName: 'Sehat Pharmacy',
      payload: {
        event: 'messages.update',
        instance: 'shop',
        data: { key: { id: 'wamid.1' }, update: { status: 'DELIVERY_ACK' } },
      },
    });
    expect(store.messages[0]?.status).toBe('delivered');
  });
});
