import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ClaimedJob } from '@/lib/restaurant/scheduler';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  processTerminalEvent: vi.fn(),
}));

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
