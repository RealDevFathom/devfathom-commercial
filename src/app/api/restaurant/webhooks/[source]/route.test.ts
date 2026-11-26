import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveOrganization: vi.fn(),
  createTenantDb: vi.fn(),
  recordInboundWebhook: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '203.0.113.10',
  rateLimit: () => ({ ok: true, remaining: 1, retryAfter: 0 }),
}));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'demo.devfathom.test',
  resolveExplicitOrganizationByHost: mocks.resolveOrganization,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: mocks.createTenantDb }));
vi.mock('@/lib/restaurant/webhook-inbox', () => ({
  recordInboundWebhook: mocks.recordInboundWebhook,
  webhookEnvelopeSchema: { safeParse: vi.fn() },
}));
vi.mock('@/lib/restaurant/terminal-payments', () => ({
  terminalEventSchema: { safeParse: vi.fn() },
}));

import { POST } from './route';

describe('restaurant inbound webhook demo isolation', () => {
  it('returns the same flat 404 as an unknown tenant before reading or persisting input', async () => {
    mocks.resolveOrganization.mockResolvedValue({
      id: 'org_demo_restaurant_seat_1',
      isDemo: true,
    });
    const request = new Request('https://demo.devfathom.test/api/restaurant/webhooks/terminal', {
      method: 'POST',
      headers: {
        'x-webhook-signature': '0'.repeat(64),
        'x-webhook-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body: '{not-json',
    });

    const response = await POST(request, { params: Promise.resolve({ source: 'terminal' }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Unknown tenant.' });
    expect(mocks.createTenantDb).not.toHaveBeenCalled();
    expect(mocks.recordInboundWebhook).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });
});
