/**
 * M7-L4 — SOP escalation unit tests.
 * Covers: step firing, STOP conditions (stopOnVerified via occurrence status,
 * stopOnAcknowledged, chain exhausted), quiet-hour deferral, delay enforcement,
 * notification + delivery row creation, acknowledgeEscalation idempotency.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { sopEscalationHandler, acknowledgeEscalation } from './sop-escalation';
import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const NOW_ISO = '2026-08-20T14:00:00.000Z'; // 14:00 UTC = 840 min — not in most quiet windows
const NOW = new Date(NOW_ISO);

const BASE_OCCURRENCE = {
  id: 'occ_1',
  status: 'LATE',
  branchId: 'branch_1',
  branch: { timezone: 'UTC' },
  assignment: { template: { name: 'Open Check' } },
};

const BASE_POLICY = {
  id: 'policy_1',
  active: true,
  stopOnAcknowledged: true,
  stopOnVerified: true,
  quietHoursStartMinutes: null,
  quietHoursEndMinutes: null,
  steps: [
    {
      id: 'step_a',
      stepOrder: 1,
      delayMinutes: 0,
      target: 'staff_mgr',
      channel: 'IN_APP',
      maxAttempts: 1,
    },
    {
      id: 'step_b',
      stepOrder: 2,
      delayMinutes: 30,
      target: 'staff_gm',
      channel: 'IN_APP',
      maxAttempts: 1,
    },
  ],
};

interface DbMocks {
  occFindUnique: ReturnType<typeof vi.fn>;
  policyFindUnique: ReturnType<typeof vi.fn>;
  eventFindMany: ReturnType<typeof vi.fn>;
  eventFindFirst: ReturnType<typeof vi.fn>;
  eventFindUnique: ReturnType<typeof vi.fn>;
  eventCreate: ReturnType<typeof vi.fn>;
  notifCreate: ReturnType<typeof vi.fn>;
  notifDeliveryCreate: ReturnType<typeof vi.fn>;
}

function makeDb(opts: {
  occ?: Record<string, unknown> | null;
  policy?: Record<string, unknown> | null;
  events?: Record<string, unknown>[];
  existingAckEvent?: Record<string, unknown> | null;
  lastFiredCreatedAt?: Date;
}): { db: ScopedDb; mocks: DbMocks } {
  const occFindUnique = vi
    .fn()
    .mockResolvedValue(opts.occ !== undefined ? opts.occ : BASE_OCCURRENCE);
  const policyFindUnique = vi
    .fn()
    .mockResolvedValue(opts.policy !== undefined ? opts.policy : BASE_POLICY);
  const eventFindMany = vi.fn().mockResolvedValue(opts.events ?? []);
  const existingAckEvent = opts.existingAckEvent !== undefined ? opts.existingAckEvent : null;
  const eventFindFirst = vi.fn().mockResolvedValue(existingAckEvent);
  const eventFindUnique = vi
    .fn()
    .mockResolvedValue(
      opts.lastFiredCreatedAt ? { createdAt: opts.lastFiredCreatedAt } : { createdAt: NOW }
    );
  const eventCreate = vi
    .fn()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'evt_new',
      createdAt: NOW,
      ...data,
    }));
  const notifCreate = vi.fn().mockResolvedValue({ id: 'notif_1' });
  const notifDeliveryCreate = vi.fn().mockResolvedValue({ id: 'deliv_1' });

  const dbObj = {
    restaurantSopOccurrence: {
      findUnique: occFindUnique,
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    restaurantSopEscalationPolicy: {
      findUnique: policyFindUnique,
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    restaurantSopEscalationEvent: {
      findMany: eventFindMany,
      findFirst: eventFindFirst,
      findUnique: eventFindUnique,
      create: eventCreate,
    },
    restaurantNotification: {
      create: notifCreate,
    },
    restaurantNotificationDelivery: {
      create: notifDeliveryCreate,
    },
  };
  (dbObj as Record<string, unknown>).$transaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn(dbObj)
  );
  const db = dbObj as unknown as ScopedDb;
  return {
    db,
    mocks: {
      occFindUnique,
      policyFindUnique,
      eventFindMany,
      eventFindFirst,
      eventFindUnique,
      eventCreate,
      notifCreate,
      notifDeliveryCreate,
    },
  };
}

function makeCtx(
  db: ScopedDb,
  payloadOverride: Record<string, unknown> = {}
): RestaurantJobContext {
  return {
    db,
    job: {
      id: 'job_1',
      type: 'sop.runEscalation',
      payload: { occurrenceId: 'occ_1', policyId: 'policy_1', now: NOW_ISO, ...payloadOverride },
      attempts: 1,
      maxAttempts: 5,
      claimedBy: 'worker_1',
      startedAt: NOW,
    },
  };
}

describe('sopEscalationHandler', () => {
  it('fires step 1 on first run (no prior events)', async () => {
    const { db, mocks } = makeDb({});
    await sopEscalationHandler(makeCtx(db));

    expect(mocks.eventCreate).toHaveBeenCalledOnce();
    expect(mocks.eventCreate.mock.calls[0][0].data).toMatchObject({
      kind: 'FIRED',
      escalationStepId: 'step_a',
    });
    expect(mocks.notifCreate).toHaveBeenCalledOnce();
  });

  it('does nothing when occurrence is already VERIFIED (stopOnVerified)', async () => {
    const { db, mocks } = makeDb({ occ: { ...BASE_OCCURRENCE, status: 'VERIFIED' } });
    await sopEscalationHandler(makeCtx(db));

    // Should write a STOPPED event, no notification
    expect(mocks.eventCreate).toHaveBeenCalledOnce();
    expect(mocks.eventCreate.mock.calls[0][0].data.kind).toBe('STOPPED');
    expect(mocks.notifCreate).not.toHaveBeenCalled();
  });

  it('stops when an ACKNOWLEDGED event exists (stopOnAcknowledged)', async () => {
    const { db, mocks } = makeDb({
      events: [{ id: 'evt_ack', escalationStepId: null, kind: 'ACKNOWLEDGED' }],
    });
    await sopEscalationHandler(makeCtx(db));

    const lastCall = mocks.eventCreate.mock.calls.at(-1)?.[0];
    expect(lastCall?.data?.kind).toBe('STOPPED');
    expect(mocks.notifCreate).not.toHaveBeenCalled();
  });

  it('stops when all steps are exhausted', async () => {
    const { db, mocks } = makeDb({
      events: [
        { id: 'evt_a', escalationStepId: 'step_a', kind: 'FIRED' },
        { id: 'evt_b', escalationStepId: 'step_b', kind: 'FIRED' },
      ],
    });
    await sopEscalationHandler(makeCtx(db));

    expect(mocks.eventCreate.mock.calls[0][0].data.kind).toBe('STOPPED');
    expect(mocks.notifCreate).not.toHaveBeenCalled();
  });

  it('does nothing during quiet hours', async () => {
    // 14:00 UTC = 840 min. Quiet window 13:00–15:00 (780–900).
    const { db, mocks } = makeDb({
      policy: { ...BASE_POLICY, quietHoursStartMinutes: 780, quietHoursEndMinutes: 900 },
    });
    await sopEscalationHandler(makeCtx(db));

    expect(mocks.notifCreate).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it('defers step 2 when 30-min delay has not elapsed since last FIRED', async () => {
    // step_b has delayMinutes=30. Last FIRED at NOW, running at NOW → delay not elapsed.
    const { db, mocks } = makeDb({
      events: [{ id: 'evt_a', escalationStepId: 'step_a', kind: 'FIRED' }],
      lastFiredCreatedAt: NOW, // last fired = now → 0ms elapsed
    });
    await sopEscalationHandler(makeCtx(db));

    expect(mocks.notifCreate).not.toHaveBeenCalled();
  });

  it('rejects unknown payload key (strict zod)', async () => {
    const { db } = makeDb({});
    await expect(sopEscalationHandler(makeCtx(db, { unknownKey: true }))).rejects.toThrow();
  });
});

// ── acknowledgeEscalation ──────────────────────────────────────────────────────

describe('acknowledgeEscalation', () => {
  it('creates an ACKNOWLEDGED event on first call', async () => {
    const { db, mocks } = makeDb({ existingAckEvent: null });
    const result = await acknowledgeEscalation(db, { occurrenceId: 'occ_1' });
    expect(result.occurrenceId).toBe('occ_1');
    expect(mocks.eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'ACKNOWLEDGED' }) })
    );
  });

  it('is idempotent — returns existing event without creating a second', async () => {
    const existingEvent = { id: 'evt_existing' };
    const { db, mocks } = makeDb({ existingAckEvent: existingEvent });
    const result = await acknowledgeEscalation(db, { occurrenceId: 'occ_1' });
    expect(result.eventId).toBe('evt_existing');
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });
});
