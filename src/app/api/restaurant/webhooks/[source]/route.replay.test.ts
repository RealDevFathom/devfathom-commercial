import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  resolveOrganization: vi.fn(),
  createTenantDb: vi.fn(() => ({})),
  recordInboundWebhook: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '203.0.113.10',
  rateLimit: () => ({ ok: true, remaining: 1, retryAfter: 0 }),
}));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'acme.devfathom.test',
  resolveExplicitOrganizationByHost: mocks.resolveOrganization,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: mocks.createTenantDb }));
vi.mock('@/lib/restaurant/webhook-inbox', async () => {
  const { z } = await import('zod');
  return {
    recordInboundWebhook: mocks.recordInboundWebhook,
    webhookEnvelopeSchema: z
      .object({
        externalEventId: z.string().min(1).max(200),
        eventType: z.string().min(1).max(200).optional(),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict(),
  };
});

import { POST } from './route';

const SECRET = 'test-terminal-secret';
const SOURCE = 'card-provider';

function rawEnvelope() {
  return JSON.stringify({
    externalEventId: 'evt_replay_1',
    eventType: 'terminal.approved',
    payload: {
      status: 'approved',
      terminalId: 'counter-1',
      reference: 'bill-1',
      amount: '12.50',
      staffProfileId: 'staff-1',
      providerReference: 'provider-ref-1',
    },
  });
}

function signedRequest(timestamp: string, rawBody = rawEnvelope()) {
  const signature = createHmac('sha256', SECRET)
    .update(`${timestamp}.${SOURCE}.${rawBody}`)
    .digest('hex');
  return new Request(`https://acme.devfathom.test/api/restaurant/webhooks/${SOURCE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': signature,
      'x-webhook-timestamp': timestamp,
    },
    body: rawBody,
  });
}

function call(request: Request) {
  return POST(request, { params: Promise.resolve({ source: SOURCE }) });
}

describe('terminal webhook replay', () => {
  beforeEach(() => {
    process.env.RESTAURANT_TERMINAL_WEBHOOK_SECRET = SECRET;
    mocks.resolveOrganization.mockResolvedValue({ id: 'org_acme', isDemo: false });
    mocks.recordInboundWebhook.mockReset();
    mocks.createTenantDb.mockClear();
  });

  afterEach(() => {
    delete process.env.RESTAURANT_TERMINAL_WEBHOOK_SECRET;
  });

  it('accepts a fresh signed terminal event', async () => {
    mocks.recordInboundWebhook.mockResolvedValue({
      inbox: {
        id: 'inbox_1',
        source: SOURCE,
        externalEventId: 'evt_replay_1',
        status: 'PENDING',
        verificationStatus: 'VERIFIED',
        receivedAt: new Date(),
      },
      deduplicated: false,
      enqueuedJobId: 'job_1',
    });

    const response = await call(signedRequest(String(Math.floor(Date.now() / 1000))));

    expect(response.status).toBe(202);
    expect(mocks.recordInboundWebhook).toHaveBeenCalledOnce();
    expect(mocks.recordInboundWebhook.mock.calls[0]?.[1]).toMatchObject({
      source: SOURCE,
      externalEventId: 'evt_replay_1',
      verificationStatus: 'VERIFIED',
    });
  });

  it('returns 200 and enqueues nothing when the event id is already stored', async () => {
    mocks.recordInboundWebhook.mockResolvedValue({
      inbox: {
        id: 'inbox_1',
        source: SOURCE,
        externalEventId: 'evt_replay_1',
        status: 'PROCESSED',
        verificationStatus: 'VERIFIED',
        receivedAt: new Date(),
      },
      deduplicated: true,
      enqueuedJobId: null,
    });

    const response = await call(signedRequest(String(Math.floor(Date.now() / 1000))));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      deduplicated: true,
      jobId: null,
      externalEventId: 'evt_replay_1',
    });
    expect(mocks.recordInboundWebhook).toHaveBeenCalledOnce();
  });

  it('rejects a timestamp outside five minutes before writing the inbox', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 5 * 60 - 30);
    const response = await call(signedRequest(timestamp));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid webhook signature.' });
    expect(mocks.recordInboundWebhook).not.toHaveBeenCalled();
    expect(mocks.createTenantDb).not.toHaveBeenCalled();
  });
});
