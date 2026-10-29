import { beforeEach, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type {
  PharmacyCampaignDispatchAttempt,
  PharmacyCampaignDeliveryEvent,
} from '@/generated/prisma/client';
import {
  dispatchSandboxCampaign,
  dispatchDueSandboxCampaigns,
  reconcileDelivery,
  recordMarketingCallback,
  type MarketingTransaction,
} from './marketing-delivery';

const scope = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  actorId: 'owner-a',
  timezone: 'UTC',
};
const now = new Date('2026-10-06T12:00:00Z');
it('bounds explicitly selected due campaigns and refuses missing/foreign selection before dispatch', async () => {
  const findMany = vi.fn().mockResolvedValue([]);
  const tx: MarketingTransaction = async (run) =>
    run({ pharmacyCampaign: { findMany } } as unknown as ScopedDb, scope);
  await expect(
    dispatchDueSandboxCampaigns(
      tx,
      { branchId: scope.branchId, campaignIds: ['foreign'], requestKey: 'batch-a' },
      now
    )
  ).rejects.toThrow('Choose up to five');
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        id: { in: ['foreign'] },
        status: 'CAPTURED',
        scheduledAt: { lte: now },
      }),
      take: 5,
    })
  );
});
const input = {
  branchId: scope.branchId,
  campaignId: 'campaign-a',
  requestKey: 'request-a',
  outcome: 'DELIVERED' as const,
};
let attempts: PharmacyCampaignDispatchAttempt[];
let events: PharmacyCampaignDeliveryEvent[];
let optedOut: boolean;
let failPersist: boolean;
let transaction: MarketingTransaction;
let db: ScopedDb;
let index: number;
beforeEach(() => {
  attempts = [];
  events = [];
  optedOut = false;
  failPersist = false;
  index = 0;
  const capture = { id: 'capture-a', customerId: 'customer-a', campaignId: 'campaign-a' };
  db = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'p', patientId: 'p' }]),
    pharmacyMarketingSafetyState: { findFirst: async () => null },
    pharmacyCampaignCapture: {
      findMany: async () => [capture],
      findFirst: async () => capture,
      count: async () => 0,
    },
    pharmacyCustomer: {
      findFirst: async () => ({ patientId: 'p', active: true, whatsappOptIn: !optedOut }),
    },
    patientConsent: {
      findFirst: async () => ({ granted: true, revokedAt: null, recordedAt: now }),
    },
    pharmacyCampaign: {
      findFirst: async () => ({
        id: 'campaign-a',
        status: 'CAPTURED',
        templateId: 't',
        segmentId: 's',
        ownerApprovedByUserId: 'owner-a',
        ownerApprovedAt: now,
        scheduledAt: now,
        promotesRegulatedItem: false,
        quietHours: { startHour: 22, endHour: 8 },
        frequencyCap: { max: 1, windowDays: 7 },
      }),
    },
    pharmacyMarketingTemplate: {
      findFirst: async () => ({
        body: 'Store update. Reply STOP.',
        approvedByUserId: 'owner-a',
        approvedAt: now,
      }),
    },
    pharmacyMarketingSegment: {
      findFirst: async () => ({
        definition: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
      }),
    },
    pharmacyCampaignDispatchAttempt: {
      findMany: async () =>
        [...attempts]
          .reverse()
          .map((a) => ({ ...a, events: events.filter((e) => e.attemptId === a.id) })),
      create: async ({ data }: { data: PharmacyCampaignDispatchAttempt }) => {
        const a = { ...data, id: `a-${++index}` };
        attempts.push(a);
        return { ...a, events: [] };
      },
    },
    pharmacyCampaignDeliveryEvent: {
      create: async ({ data }: { data: PharmacyCampaignDeliveryEvent }) => {
        if (failPersist) throw new Error('persistence failed');
        const e = { ...data, id: `e-${++index}` };
        events.push(e);
        return e;
      },
    },
  } as unknown as ScopedDb;
  // Serial transaction/rollback model tests orchestration only; PostgreSQL evidence is separate.
  let queue = Promise.resolve();
  transaction = <T>(run: (db: ScopedDb, resolved: typeof scope) => Promise<T>) => {
    const next = queue.then(async () => {
      const savedAttempts = [...attempts],
        savedEvents = [...events];
      try {
        return await run(db, scope);
      } catch (e) {
        attempts = savedAttempts;
        events = savedEvents;
        throw e;
      }
    });
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
});
it('persists one attempt under double dispatch and replay', async () => {
  await Promise.all([
    dispatchSandboxCampaign(transaction, input, now),
    dispatchSandboxCampaign(transaction, input, now),
  ]);
  const history = await dispatchSandboxCampaign(
    transaction,
    { ...input, requestKey: 'different' },
    now
  );
  expect(attempts).toHaveLength(1);
  expect(events.map((e) => e.state)).toEqual(['PROVIDER_ACCEPTED', 'DELIVERED']);
  expect(history).toMatchObject({ mode: 'SANDBOX', accepted: 1, delivered: 1 });
});
it('only a confirmed rejection allows a new request-key retry', async () => {
  await dispatchSandboxCampaign(transaction, { ...input, outcome: 'REJECTED' }, now);
  await dispatchSandboxCampaign(transaction, { ...input, retry: true }, now); // same key is replay
  expect(attempts).toHaveLength(1);
  await dispatchSandboxCampaign(transaction, { ...input, requestKey: 'retry-1', retry: true }, now);
  expect(attempts).toHaveLength(2);
  expect(reconcileDelivery(events)).toMatchObject({ contradictory: true, retryable: false });
});
it.each(['TIMEOUT', 'FAULT'] as const)('never retries %s', async (outcome) => {
  await dispatchSandboxCampaign(transaction, { ...input, outcome }, now);
  await dispatchSandboxCampaign(transaction, { ...input, requestKey: 'retry-1', retry: true }, now);
  expect(attempts).toHaveLength(1);
  expect(events[0].state).toBe('UNKNOWN');
});
it('leaves a committed reservation after persistence failure; retry cannot resend', async () => {
  failPersist = true;
  await expect(dispatchSandboxCampaign(transaction, input, now)).rejects.toThrow(
    'persistence failed'
  );
  expect(attempts).toHaveLength(1);
  expect(events).toHaveLength(0);
  failPersist = false;
  expect(
    await dispatchSandboxCampaign(
      transaction,
      { ...input, requestKey: 'retry-1', retry: true },
      now
    )
  ).toMatchObject({ unknown: 1 });
  expect(events).toHaveLength(0);
});
it('persists STOP suppression without calling the adapter', async () => {
  optedOut = true;
  const result = await dispatchSandboxCampaign(transaction, input, now);
  expect(result).toMatchObject({ attempted: 0, suppressed: 1, accepted: 0 });
  expect(events[0]).toMatchObject({ state: 'SUPPRESSED', reason: 'OPTED_OUT' });
});
it('retains contradictory evidence regardless of callback ordering', () => {
  const rows = [
    { state: 'DELIVERED', reason: null },
    { state: 'FAILED', reason: 'PROVIDER_FAILURE' },
    { state: 'PROVIDER_ACCEPTED', reason: null },
  ];
  expect(reconcileDelivery(rows)).toEqual(reconcileDelivery([...rows].reverse()));
  expect(reconcileDelivery(rows)).toMatchObject({
    delivered: true,
    contradictory: true,
    unknown: true,
    retryable: false,
  });
});
it('binds callbacks to acceptance and rejects sender mismatch, unbound identities and replay', async () => {
  const find = vi.fn().mockResolvedValue(null);
  const create = vi.fn().mockResolvedValue({ count: 1 });
  const callbackDb = {
    pharmacyCampaignDeliveryEvent: { findFirst: find, createMany: create },
  } as unknown as ScopedDb;
  const callback = {
    senderId: 'owned',
    messageId: 'message-a',
    state: 'DELIVERED' as const,
    occurredAt: now,
  };
  expect(await recordMarketingCallback(callbackDb, 'org-a', 'other', callback, now)).toBe(
    'REJECTED'
  );
  expect(find).not.toHaveBeenCalled();
  expect(await recordMarketingCallback(callbackDb, 'org-a', 'owned', callback, now)).toBe(
    'UNBOUND'
  );
  find.mockResolvedValue({ id: 'acceptance-a', attemptId: 'attempt-a' });
  expect(await recordMarketingCallback(callbackDb, 'org-a', 'owned', callback, now)).toBe(
    'RECORDED'
  );
  expect(create.mock.calls[0][0].data).toMatchObject({
    acceptanceId: 'acceptance-a',
    attemptId: 'attempt-a',
    provider: 'meta',
    senderId: 'owned',
    providerMessageId: 'message-a',
  });
  create.mockResolvedValue({ count: 0 });
  expect(await recordMarketingCallback(callbackDb, 'org-a', 'owned', callback, now)).toBe('REPLAY');
});

it('preserves distinct retry evidence without flagging a prior definite rejection as a terminal contradiction', async () => {
  const { reconcileCapture } = await import('./marketing-delivery');
  expect(
    reconcileCapture([
      { events: [{ state: 'FAILED', reason: 'DEFINITE_REJECTION' }] },
      {
        events: [
          { state: 'PROVIDER_ACCEPTED', reason: null },
          { state: 'DELIVERED', reason: null },
        ],
      },
    ])
  ).toMatchObject({
    accepted: true,
    delivered: true,
    failed: true,
    unknown: false,
    contradictory: false,
  });
});
