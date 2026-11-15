import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ClaimedJob } from '@/lib/restaurant/scheduler';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  enqueue: vi.fn(),
  processTerminalEvent: vi.fn(),
}));

vi.mock('@/server/audit', () => ({ recordAudit: mocks.recordAudit }));

vi.mock('@/lib/restaurant/scheduler', () => ({
  enqueue: mocks.enqueue,
}));

vi.mock('@/lib/restaurant/terminal-payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/terminal-payments')>()),
  processTerminalEvent: mocks.processTerminalEvent,
}));

import {
  WEBHOOK_PROCESS_JOB_TYPE,
  processInboundWebhookHandler,
  recordInboundWebhook,
  verifyWebhookSignatureStub,
  webhookProcessJobKey,
} from '@/lib/restaurant/webhook-inbox';

type Row = Record<string, unknown>;

function applyData(target: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) {
      target[key] = ((target[key] as number) ?? 0) + (value as { increment: number }).increment;
    } else {
      target[key] = value;
    }
  }
}

function createFakeDb() {
  const inbox = new Map<string, Row>();
  let seq = 0;

  const restaurantWebhookInbox = {
    findFirst: async ({ where }: { where: { source?: string; externalEventId?: string } }) => {
      for (const row of inbox.values()) {
        if (where.source !== undefined && row.source !== where.source) continue;
        if (where.externalEventId !== undefined && row.externalEventId !== where.externalEventId)
          continue;
        return { ...row };
      }
      return null;
    },
    create: async ({ data }: { data: Row }) => {
      for (const row of inbox.values()) {
        if (row.source === data.source && row.externalEventId === data.externalEventId) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
      }
      const id = `inbox_${(seq += 1)}`;
      const row: Row = {
        id,
        status: 'PENDING',
        verificationStatus: 'PENDING',
        attempts: 0,
        processedAt: null,
        eventType: null,
        payload: {},
        receivedAt: new Date(),
        ...data,
      };
      inbox.set(id, row);
      return { ...row };
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = inbox.get(where.id);
      return row ? { ...row } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = inbox.get(where.id);
      if (!row) throw new Error(`fake update: inbox ${where.id} not found`);
      applyData(row, data);
      return { ...row };
    },
    deleteMany: async ({ where }: { where: { id: string } }) => ({
      count: inbox.delete(where.id) ? 1 : 0,
    }),
  };

  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    restaurantWebhookInbox,
  };

  return { db: db as unknown as ScopedDb, inbox };
}

function claimedJob(payload: unknown): ClaimedJob {
  return {
    id: 'job_1',
    organizationId: 'org_test',
    type: WEBHOOK_PROCESS_JOB_TYPE,
    payload: payload as Prisma.JsonValue,
    attempts: 1,
    maxAttempts: 5,
    claimedBy: 'worker-a',
    claimToken: 'webhook-test-claim',
    startedAt: new Date(),
  };
}

const T0 = new Date('2026-08-20T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enqueue.mockResolvedValue({
    job: { id: 'job_new', status: 'QUEUED' },
    deduplicated: false,
  });
});

describe('verifyWebhookSignatureStub', () => {
  it('records VERIFIED for a signed envelope and PENDING for an unsigned one', () => {
    expect(verifyWebhookSignatureStub({ source: 'stripe', signature: 'sig_abc' })).toBe('VERIFIED');
    expect(verifyWebhookSignatureStub({ source: 'stripe', signature: null })).toBe('PENDING');
    expect(verifyWebhookSignatureStub({ source: 'stripe', signature: '   ' })).toBe('PENDING');
  });
});

describe('recordInboundWebhook', () => {
  it('records a new envelope and enqueues one processing job', async () => {
    const { db, inbox } = createFakeDb();
    const result = await recordInboundWebhook(
      db,
      {
        source: 'stripe',
        externalEventId: 'evt_1',
        eventType: 'charge.succeeded',
        payload: { amount: 100 },
        signature: 'sig_abc',
      },
      T0
    );

    expect(result.deduplicated).toBe(false);
    expect(result.inbox.verificationStatus).toBe('VERIFIED');
    expect(result.inbox.status).toBe('PENDING');
    expect(inbox.size).toBe(1);
    expect(result.enqueuedJobId).toBe('job_new');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const [, enqueueInput] = mocks.enqueue.mock.calls[0]!;
    expect(enqueueInput).toMatchObject({
      type: WEBHOOK_PROCESS_JOB_TYPE,
      payload: { inboxId: 'inbox_1' },
      idempotencyKey: webhookProcessJobKey('inbox_1'),
    });
  });

  it('deduplicates a repeat receipt and enqueues nothing new', async () => {
    const { db, inbox } = createFakeDb();
    const first = await recordInboundWebhook(
      db,
      { source: 'twilio', externalEventId: 'evt_9', payload: {} },
      T0
    );
    mocks.enqueue.mockClear();

    const second = await recordInboundWebhook(
      db,
      { source: 'twilio', externalEventId: 'evt_9', payload: {} },
      T0
    );

    expect(second.deduplicated).toBe(true);
    expect(second.inbox.id).toBe(first.inbox.id);
    expect(second.enqueuedJobId).toBeNull();
    expect(inbox.size).toBe(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('resolves a lost create race (unique violation) to the existing row', async () => {
    const { db } = createFakeDb();
    const existing = {
      id: 'inbox_raced',
      source: 'stripe',
      externalEventId: 'evt_race',
      status: 'PENDING',
      verificationStatus: 'VERIFIED',
      receivedAt: T0,
    };
    let findCalls = 0;
    // A concurrent insert lands between our dedup check and our create: the first
    // find sees nothing, our create loses the unique-index race, the re-read finds
    // the winner.
    (db.restaurantWebhookInbox as unknown as { findFirst: unknown }).findFirst = async () => {
      findCalls += 1;
      return findCalls === 1 ? null : { ...existing };
    };
    (db.restaurantWebhookInbox as unknown as { create: unknown }).create = async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    };

    const result = await recordInboundWebhook(
      db,
      { source: 'stripe', externalEventId: 'evt_race', payload: {} },
      T0
    );

    expect(result.deduplicated).toBe(true);
    expect(result.inbox.id).toBe('inbox_raced');
    expect(result.enqueuedJobId).toBeNull();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('recordInboundWebhook — unauthenticated envelopes cannot reserve a signed event id', () => {
  const terminalPayload = {
    status: 'approved',
    terminalId: 'counter-1',
    reference: 'bill-1',
    amount: '12.50',
    staffProfileId: 'staff-1',
    providerReference: 'provider-ref-1',
  };
  // What the route passes after `verifyTerminalSignature` returned VERIFIED.
  const signedTerminal = {
    source: 'card-provider',
    externalEventId: 'evt_target',
    eventType: 'terminal.approved',
    payload: terminalPayload,
    signature: 'hmac-hex',
    verificationStatus: 'VERIFIED' as const,
  };

  beforeEach(() => {
    let jobs = 0;
    mocks.enqueue.mockImplementation(async () => ({
      job: { id: `job_${(jobs += 1)}`, status: 'QUEUED' },
      deduplicated: false,
    }));
  });

  it.each([
    ['unsigned, no event type', { signature: null }],
    ['unsigned, non-terminal type', { eventType: 'order.created', signature: null }],
    // The stub records VERIFIED for any non-empty header: still unauthenticated.
    ['stub-signed, non-terminal type', { eventType: 'order.created', signature: 'forged' }],
  ])(
    'processes the signed terminal event exactly once after a %s envelope',
    async (_label, spoof) => {
      const { db, inbox } = createFakeDb();
      const squatter = await recordInboundWebhook(
        db,
        { source: 'card-provider', externalEventId: 'evt_target', payload: { x: 1 }, ...spoof },
        T0
      );
      expect(squatter.deduplicated).toBe(false);
      mocks.recordAudit.mockClear();

      const signed = await recordInboundWebhook(db, signedTerminal, T0);

      expect(mocks.recordAudit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          action: 'restaurant.webhook.unauthenticated_row_replaced',
          targetType: 'RestaurantWebhookInbox',
          targetId: squatter.inbox.id,
          metadata: expect.objectContaining({
            source: 'card-provider',
            externalEventId: 'evt_target',
          }),
        }),
        expect.anything()
      );
      expect(signed.deduplicated).toBe(false);
      expect(signed.enqueuedJobId).toBe('job_2');
      expect(signed.inbox.id).not.toBe(squatter.inbox.id);
      expect(signed.inbox).toMatchObject({ verificationStatus: 'VERIFIED', status: 'PENDING' });
      expect(inbox.size).toBe(1);
      expect(inbox.get(signed.inbox.id)).toMatchObject({
        eventType: 'terminal.approved',
        payload: terminalPayload,
      });

      // Drain both queued jobs: the squatter's job finds its row gone and no-ops.
      await processInboundWebhookHandler({ db, job: claimedJob({ inboxId: squatter.inbox.id }) });
      await processInboundWebhookHandler({ db, job: claimedJob({ inboxId: signed.inbox.id }) });
      await processInboundWebhookHandler({ db, job: claimedJob({ inboxId: signed.inbox.id }) });

      expect(mocks.processTerminalEvent).toHaveBeenCalledExactlyOnceWith(db, {
        source: 'card-provider',
        externalEventId: 'evt_target',
        event: terminalPayload,
        requiredMode: 'WEBHOOK',
      });
      expect(inbox.get(signed.inbox.id)).toMatchObject({ status: 'PROCESSED' });
    }
  );

  it('keeps a signed event when an unsigned envelope reuses its id later', async () => {
    const { db, inbox } = createFakeDb();
    const signed = await recordInboundWebhook(db, signedTerminal, T0);
    mocks.enqueue.mockClear();

    const spoof = await recordInboundWebhook(
      db,
      {
        source: 'card-provider',
        externalEventId: 'evt_target',
        eventType: 'order.created',
        payload: { x: 1 },
        signature: 'forged',
      },
      T0
    );

    expect(spoof).toMatchObject({ deduplicated: true, enqueuedJobId: null });
    expect(spoof.inbox.id).toBe(signed.inbox.id);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(inbox.size).toBe(1);
    expect(inbox.get(signed.inbox.id)).toMatchObject({
      eventType: 'terminal.approved',
      payload: terminalPayload,
      verificationStatus: 'VERIFIED',
    });
  });

  it('still deduplicates a repeat of the same signed event', async () => {
    const { db, inbox } = createFakeDb();
    const first = await recordInboundWebhook(db, signedTerminal, T0);
    mocks.enqueue.mockClear();

    const second = await recordInboundWebhook(db, signedTerminal, T0);

    expect(second).toMatchObject({ deduplicated: true, enqueuedJobId: null });
    expect(second.inbox.id).toBe(first.inbox.id);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(inbox.size).toBe(1);
  });

  it('retries when an unsigned envelope wins the create race against a signed event', async () => {
    const { db, inbox } = createFakeDb();
    const realCreate = db.restaurantWebhookInbox.create.bind(db.restaurantWebhookInbox);
    let raced = false;
    (db.restaurantWebhookInbox as unknown as { create: unknown }).create = async (
      args: Parameters<typeof realCreate>[0]
    ) => {
      if (!raced) {
        raced = true;
        // A concurrent unsigned insert commits between our lookup and our create.
        await realCreate({
          data: {
            source: 'card-provider',
            externalEventId: 'evt_target',
            payload: {},
            verificationStatus: 'PENDING',
            status: 'PENDING',
          },
        } as Parameters<typeof realCreate>[0]);
      }
      return realCreate(args);
    };

    const signed = await recordInboundWebhook(db, signedTerminal, T0);

    expect(signed.deduplicated).toBe(false);
    expect(signed.enqueuedJobId).not.toBeNull();
    expect(inbox.size).toBe(1);
    expect(inbox.get(signed.inbox.id)).toMatchObject({
      eventType: 'terminal.approved',
      verificationStatus: 'VERIFIED',
    });
  });
});

describe('processInboundWebhookHandler', () => {
  it.each(['PENDING', 'FAILED', 'UNKNOWN', null, undefined])(
    'discards non-VERIFIED terminal events (%s) without processing payments',
    async (verificationStatus) => {
      const { db, inbox } = createFakeDb();
      inbox.set('inbox_1', {
        id: 'inbox_1',
        source: 'provider-neutral',
        externalEventId: 'event-1',
        eventType: 'terminal.approved',
        payload: {}, // Must not even parse an unverified terminal payload.
        status: 'PENDING',
        verificationStatus,
        attempts: 0,
      });

      await processInboundWebhookHandler({ db, job: claimedJob({ inboxId: 'inbox_1' }) });

      expect(mocks.processTerminalEvent).not.toHaveBeenCalled();
      expect(inbox.get('inbox_1')).toMatchObject({ status: 'DISCARDED', attempts: 1 });
    }
  );

  it('processes a VERIFIED terminal event exactly once across a job retry', async () => {
    const { db, inbox } = createFakeDb();
    const payload = {
      status: 'approved',
      terminalId: 'counter-1',
      reference: 'bill-1',
      amount: '12.50',
      staffProfileId: 'staff-1',
      providerReference: 'provider-ref-1',
    };
    inbox.set('inbox_1', {
      id: 'inbox_1',
      source: 'provider-neutral',
      externalEventId: 'event-1',
      eventType: 'terminal.approved',
      payload,
      status: 'PENDING',
      verificationStatus: 'VERIFIED',
      attempts: 0,
    });

    const context = { db, job: claimedJob({ inboxId: 'inbox_1' }) };
    await processInboundWebhookHandler(context);
    await processInboundWebhookHandler(context);

    expect(mocks.processTerminalEvent).toHaveBeenCalledExactlyOnceWith(db, {
      source: 'provider-neutral',
      externalEventId: 'event-1',
      event: payload,
      requiredMode: 'WEBHOOK',
    });
    expect(inbox.get('inbox_1')).toMatchObject({ status: 'PROCESSED', attempts: 1 });
  });

  it('marks a verified PENDING envelope PROCESSED', async () => {
    const { db, inbox } = createFakeDb();
    inbox.set('inbox_1', {
      id: 'inbox_1',
      status: 'PENDING',
      verificationStatus: 'VERIFIED',
      attempts: 0,
      processedAt: null,
    });

    await processInboundWebhookHandler({ db, job: claimedJob({ inboxId: 'inbox_1' }) });

    const row = inbox.get('inbox_1')!;
    expect(row.status).toBe('PROCESSED');
    expect(row.attempts).toBe(1);
    expect(row.processedAt).toBeInstanceOf(Date);
  });

  it('discards an envelope whose signature verification FAILED (never processed)', async () => {
    const { db, inbox } = createFakeDb();
    inbox.set('inbox_1', {
      id: 'inbox_1',
      status: 'PENDING',
      verificationStatus: 'FAILED',
      attempts: 0,
      processedAt: null,
    });

    await processInboundWebhookHandler({ db, job: claimedJob({ inboxId: 'inbox_1' }) });

    expect(inbox.get('inbox_1')!.status).toBe('DISCARDED');
  });

  it('is idempotent: a re-run on an already-terminal row is a no-op', async () => {
    const { db, inbox } = createFakeDb();
    inbox.set('inbox_1', {
      id: 'inbox_1',
      status: 'PROCESSED',
      verificationStatus: 'VERIFIED',
      attempts: 1,
    });

    await processInboundWebhookHandler({ db, job: claimedJob({ inboxId: 'inbox_1' }) });

    expect(inbox.get('inbox_1')!.status).toBe('PROCESSED');
    expect(inbox.get('inbox_1')!.attempts).toBe(1);
  });

  it('no-ops when the inbox row is gone', async () => {
    const { db } = createFakeDb();
    await expect(
      processInboundWebhookHandler({ db, job: claimedJob({ inboxId: 'missing' }) })
    ).resolves.toBeUndefined();
  });

  it('rejects a malformed job payload (strict zod at the handler boundary)', async () => {
    const { db } = createFakeDb();
    await expect(
      processInboundWebhookHandler({ db, job: claimedJob({ wrong: 'shape' }) })
    ).rejects.toThrow();
  });
});
