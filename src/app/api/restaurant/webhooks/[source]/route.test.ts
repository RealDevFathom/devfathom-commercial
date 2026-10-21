import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/lib/restaurant/webhook-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/webhook-inbox')>()),
  recordInboundWebhook: mocks.recordInboundWebhook,
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('restaurant inbound webhook demo isolation', () => {
  it('returns the same flat 404 as an unknown tenant before reading or persisting input', async () => {
    mocks.resolveOrganization.mockResolvedValue({
      id: 'org_demo_restaurant_seat_1',
      isDemo: true,
    });
    const request = new Request('https://demo.devfathom.test/api/restaurant/webhooks/terminal', {
      method: 'POST',
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

describe('restaurant terminal webhook authentication', () => {
  const now = 1_800_000_000;
  const source = 'provider-neutral';
  const envelope = {
    externalEventId: 'provider-event-1',
    eventType: 'terminal.approved',
    payload: {
      status: 'approved',
      terminalId: 'counter-1',
      reference: 'bill-1',
      amount: '12.50',
      staffProfileId: 'staff-1',
      providerReference: 'provider-ref-1',
    },
  };
  const rawBody = JSON.stringify(envelope);

  function request(timestamp: string | null, body = rawBody, signature?: string) {
    const headers = new Headers({
      'x-webhook-signature':
        signature ??
        createHmac('sha256', 'test-terminal-secret')
          .update(`${timestamp}.${source}.${rawBody}`)
          .digest('hex'),
    });
    if (timestamp !== null) headers.set('x-webhook-timestamp', timestamp);
    return new Request(`https://tenant.devfathom.test/api/restaurant/webhooks/${source}`, {
      method: 'POST',
      headers,
      body,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    vi.stubEnv('RESTAURANT_TERMINAL_WEBHOOK_SECRET', 'test-terminal-secret');
    mocks.resolveOrganization.mockResolvedValue({ id: 'org-1', isDemo: false });
    mocks.createTenantDb.mockReturnValue({ tenant: 'org-1' });
    mocks.recordInboundWebhook.mockResolvedValue({
      inbox: {
        id: 'inbox-1',
        ...envelope,
        source,
        verificationStatus: 'VERIFIED',
        status: 'PENDING',
      },
      deduplicated: false,
      enqueuedJobId: 'job-1',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('verifies the timestamp header and preserves the provider event id for deduplication', async () => {
    const response = await POST(request(String(now)), { params: Promise.resolve({ source }) });

    expect(response.status).toBe(202);
    expect(mocks.recordInboundWebhook).toHaveBeenCalledWith(
      { tenant: 'org-1' },
      expect.objectContaining({
        source,
        externalEventId: envelope.externalEventId,
        payload: envelope.payload,
        verificationStatus: 'VERIFIED',
      })
    );
  });

  it('acknowledges a duplicate with 200 and no new processing job', async () => {
    mocks.recordInboundWebhook.mockResolvedValueOnce({
      inbox: {
        id: 'inbox-1',
        source,
        externalEventId: envelope.externalEventId,
        verificationStatus: 'VERIFIED',
        status: 'PROCESSED',
      },
      deduplicated: true,
      enqueuedJobId: null,
    });

    const response = await POST(request(String(now)), { params: Promise.resolve({ source }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deduplicated: true, jobId: null });
  });

  it.each([
    ['missing timestamp', null, rawBody, undefined],
    ['non-numeric timestamp', 'invalid', rawBody, undefined],
    ['stale timestamp', String(now - 301), rawBody, undefined],
    ['future timestamp', String(now + 301), rawBody, undefined],
    ['tampered body', String(now), `${rawBody} `, undefined],
    ['wrong-length signature', String(now), rawBody, 'ab'.repeat(31)],
  ] as const)('rejects a %s', async (_, timestamp, body, signature) => {
    const response = await POST(request(timestamp, body, signature), {
      params: Promise.resolve({ source }),
    });

    expect(response.status).toBe(401);
    expect(mocks.recordInboundWebhook).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ verificationStatus: 'FAILED' })
    );
  });
});
