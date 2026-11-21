import { oversizedRequest } from '../../../../../../tests/fixtures/bounded-request';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ClaimedJob } from '@/lib/restaurant/scheduler';

vi.mock('server-only', () => ({}));

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  inbox: new Map<string, Record<string, unknown>>(),
  jobs: [] as Array<{ inboxId: string }>,
  seq: 0,
  configured: true,
}));

const mocks = vi.hoisted(() => ({
  processTerminalEvent: vi.fn(),
}));

vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '203.0.113.10',
  rateLimit: () => ({ ok: true, remaining: 1, retryAfter: 0 }),
}));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'acme.devfathom.test',
  resolveExplicitOrganizationByHost: async () => ({ id: 'org_acme', isDemo: false }),
}));
vi.mock('@/lib/restaurant/scheduler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/scheduler')>()),
  enqueue: async (_tx: unknown, input: { payload: { inboxId: string } }) => {
    state.jobs.push(input.payload);
    return { job: { id: `job_${state.jobs.length}`, status: 'QUEUED' }, deduplicated: false };
  },
}));
vi.mock('@/lib/restaurant/terminal-payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/terminal-payments')>()),
  processTerminalEvent: mocks.processTerminalEvent,
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const pick = (row: Row) => ({ ...row });
  const restaurantWebhookInbox = {
    findFirst: async ({ where }: { where: { source: string; externalEventId: string } }) => {
      for (const row of state.inbox.values()) {
        if (row.source === where.source && row.externalEventId === where.externalEventId) {
          return pick(row);
        }
      }
      return null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = state.inbox.get(where.id);
      return row ? pick(row) : null;
    },
    create: async ({ data }: { data: Row }) => {
      for (const row of state.inbox.values()) {
        if (row.source === data.source && row.externalEventId === data.externalEventId) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
      }
      const id = `inbox_${(state.seq += 1)}`;
      const row = { id, receivedAt: new Date(), attempts: 0, ...data };
      state.inbox.set(id, row);
      return pick(row);
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = state.inbox.get(where.id);
      if (!row) throw new Error('missing row');
      Object.assign(row, { status: data.status, processedAt: data.processedAt });
      return pick(row);
    },
    deleteMany: async ({ where }: { where: { id: string } }) => ({
      count: state.inbox.delete(where.id) ? 1 : 0,
    }),
  };
  const db: Record<string, unknown> = {
    restaurantWebhookInbox,
    $queryRaw: async (_query: TemplateStringsArray, source?: string) =>
      state.configured && source === 'card-provider' ? [{ id: 'cfg_1' }] : [],
    restaurantJob: { count: async () => state.jobs.length },
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return { createTenantDb: () => db };
});

import { processInboundWebhookHandler } from '@/lib/restaurant/webhook-inbox';
import { createTenantDb } from '@/lib/tenancy/scoped-db';

import { POST } from './route';

const SECRET = 'test-terminal-secret';
const SOURCE = 'card-provider';
const EVENT_ID = 'evt_upcoming_1';
const TERMINAL_PAYLOAD = {
  status: 'approved',
  terminalId: 'counter-1',
  reference: 'bill-1',
  amount: '12.50',
  staffProfileId: 'staff-1',
  providerReference: 'provider-ref-1',
};

function post(rawBody: string, headers: Record<string, string> = {}) {
  return POST(
    new Request(`https://acme.devfathom.test/api/restaurant/webhooks/${SOURCE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: rawBody,
    }),
    { params: Promise.resolve({ source: SOURCE }) }
  );
}

function postSignedTerminal() {
  const rawBody = JSON.stringify({
    externalEventId: EVENT_ID,
    eventType: 'terminal.approved',
    payload: TERMINAL_PAYLOAD,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', SECRET)
    .update(`${timestamp}.${SOURCE}.${rawBody}`)
    .digest('hex');
  return post(rawBody, { 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp });
}

async function drainJobs() {
  const db = createTenantDb('org_acme');
  for (const [index, payload] of state.jobs.entries()) {
    const job: ClaimedJob = {
      id: `job_${index + 1}`,
      organizationId: 'org_acme',
      type: 'webhook.process',
      payload,
      attempts: 1,
      maxAttempts: 5,
      claimedBy: 'worker-a',
      claimToken: 'claim',
      startedAt: new Date(),
    };
    await processInboundWebhookHandler({ db, job });
  }
}

describe('terminal webhook: unsigned envelopes cannot suppress a signed event', () => {
  beforeEach(() => {
    process.env.RESTAURANT_TERMINAL_WEBHOOK_SECRET = SECRET;
    state.inbox.clear();
    state.jobs.length = 0;
    state.seq = 0;
    state.configured = true;
    mocks.processTerminalEvent.mockReset();
  });

  afterEach(() => {
    delete process.env.RESTAURANT_TERMINAL_WEBHOOK_SECRET;
  });

  it.each([
    ['without an event type', { 'x-webhook-signature': 'forged' }, undefined],
    ['with a non-terminal event type', {}, 'order.created'],
  ])(
    'queues and processes the signed terminal event once after an unsigned envelope %s',
    async (_label, headers, eventType) => {
      const spoof = await post(
        JSON.stringify({ externalEventId: EVENT_ID, eventType, payload: { probe: true } }),
        headers
      );
      expect(spoof.status).toBe(401);
      expect(state.inbox.size).toBe(0);
      expect(state.jobs).toHaveLength(0);

      const signed = await postSignedTerminal();
      const body = await signed.json();

      expect(signed.status).toBe(202);
      expect(body).toMatchObject({ deduplicated: false, verificationStatus: 'VERIFIED' });
      expect(body.jobId).not.toBeNull();

      await drainJobs();

      expect(mocks.processTerminalEvent).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        source: SOURCE,
        externalEventId: EVENT_ID,
        event: TERMINAL_PAYLOAD,
        requiredMode: 'WEBHOOK',
      });
      expect([...state.inbox.values()]).toEqual([
        expect.objectContaining({
          externalEventId: EVENT_ID,
          eventType: 'terminal.approved',
          verificationStatus: 'VERIFIED',
          status: 'PROCESSED',
        }),
      ]);
    }
  );

  it('ignores an unsigned envelope that reuses an already-signed event id', async () => {
    expect((await postSignedTerminal()).status).toBe(202);

    const spoof = await post(
      JSON.stringify({ externalEventId: EVENT_ID, eventType: 'order.created', payload: {} })
    );

    expect(spoof.status).toBe(401);
    const replay = await postSignedTerminal();
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ deduplicated: true, jobId: null });
    expect(state.jobs).toHaveLength(1);
    await drainJobs();
    expect(mocks.processTerminalEvent).toHaveBeenCalledOnce();
    expect([...state.inbox.values()]).toEqual([
      expect.objectContaining({ eventType: 'terminal.approved', payload: TERMINAL_PAYLOAD }),
    ]);
  });

  it('refuses even a correctly signed terminal envelope for an unconfigured provider', async () => {
    state.configured = false;
    expect((await postSignedTerminal()).status).toBe(404);
    expect(state.inbox.size).toBe(0);
    expect(state.jobs).toHaveLength(0);
  });

  it('stops reading a chunked body at the limit', async () => {
    const limit = 256 * 1024;
    const { request, cancelled, bytesRead } = oversizedRequest(limit);
    expect((await POST(request, { params: Promise.resolve({ source: SOURCE }) })).status).toBe(413);
    expect(cancelled()).toBe(true);
    expect(bytesRead()).toBeLessThanOrEqual(limit + 16_384);
    expect(state.jobs).toHaveLength(0);
    expect(state.inbox.size).toBe(0);
  });

  it('still rejects an unsigned terminal event before touching the inbox', async () => {
    const response = await post(
      JSON.stringify({
        externalEventId: EVENT_ID,
        eventType: 'terminal.approved',
        payload: TERMINAL_PAYLOAD,
      })
    );

    expect(response.status).toBe(401);
    expect(state.inbox.size).toBe(0);
    expect(state.jobs).toHaveLength(0);
  });

  it.each([
    ['no signature headers', {}],
    ['a forged signature', { 'x-webhook-signature': 'forged' }],
  ])(
    'rejects a non-terminal envelope with %s for a configured payment source',
    async (_l, headers) => {
      state.configured = true;
      const response = await post(
        JSON.stringify({ externalEventId: EVENT_ID, eventType: 'order.created', payload: {} }),
        headers
      );

      expect(response.status).toBe(401);
      expect(state.inbox.size).toBe(0);
      expect(state.jobs).toHaveLength(0);
    }
  );

  it('checks the HMAC over all received bytes, including a UTF-8 BOM', async () => {
    const text = JSON.stringify({
      externalEventId: EVENT_ID,
      eventType: 'order.created',
      payload: { label: 'café' },
    });
    const raw = '\uFEFF' + text;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headersFor = (body: string) => ({
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': createHmac('sha256', SECRET)
        .update(`${timestamp}.${SOURCE}.`)
        .update(body)
        .digest('hex'),
    });
    expect((await post(raw, headersFor(text))).status).toBe(401);
    expect(state.jobs).toHaveLength(0);
    expect(state.inbox.size).toBe(0);
    expect((await post(raw, headersFor(raw))).status).toBe(202);
    expect(state.jobs).toHaveLength(1);
  });

  it('accepts a correctly signed non-terminal envelope for a configured payment source', async () => {
    state.configured = true;
    const rawBody = JSON.stringify({
      externalEventId: EVENT_ID,
      eventType: 'order.created',
      payload: {},
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET)
      .update(`${timestamp}.${SOURCE}.${rawBody}`)
      .digest('hex');

    const response = await post(rawBody, {
      'x-webhook-signature': signature,
      'x-webhook-timestamp': timestamp,
    });

    expect(response.status).toBe(202);
    expect(state.inbox.size).toBe(1);
  });
});
