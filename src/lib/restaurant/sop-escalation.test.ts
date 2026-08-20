/**
 * M7-L4 — SOP escalation unit tests.
 * Covers: step firing, STOP conditions (stopOnVerified via occurrence status,
 * stopOnAcknowledged, chain exhausted), quiet-hour deferral, delay enforcement,
 * notification + delivery row creation, acknowledgeEscalation idempotency.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { sopEscalationHandler, acknowledgeEscalation } from './sop-escalation';
import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type MockFn = ReturnType<typeof vi.fn>;

function model(overrides: Record<string, unknown> = {}): Record<string, MockFn> {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'new_id',
      createdAt: new Date(),
      ...data,
    })),
    ...overrides,
  };
}

const NOW_ISO = '2026-08-20T14:00:00.000Z'; // 14:00 UTC = not in most quiet windows
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
    { id: 'step_a', stepOrder: 1, delayMinutes: 0, target: 'staff_mgr', channel: 'IN_APP', maxAttempts: 1 },
    { id: 'step_b', stepOrder: 2, delayMinutes: 30, target: 'staff_gm', channel: 'IN_APP', maxAttempts: 1 },
  ],
};

function makeDb(opts: {
  occ?: Record<string, unknown> | null;
  policy?: Record<string, unknown> | null;
  events?: Record<string, unknown>[];
  existingAckEvent?: Record<string, unknown> | null;
}): ScopedDb {
  const db = {
    restaurantSopOccurrence: model({
      findUnique: vi.fn().mockResolvedValue(opts.occ ?? BASE_OCCURRENCE),
    }),
    restaurantSopEscalationPolicy: model({
      findUnique: vi.fn().mockResolvedValue(opts.policy ?? BASE_POLICY),
    }),
    restaurantSopEscalationEvent: model({
      findMany: vi.fn().mockResolvedValue(opts.events ?? []),
      findFirst: vi.fn().mockResolvedValue(opts.existingAckEvent ?? null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'evt_new',
        createdAt: NOW,
        ...data,
      })),
    }),
    restaurantNotification: model({
      create: vi.fn().mockResolvedValue({ id: 'notif_1' }),
    }),
    restaurantNotificationDelivery: model(),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  } as unknown as ScopedDb;
  return db;
}

function makeCtx(db: ScopedDb, payloadOverride: Record<string, unknown> = {}): RestaurantJobContext {
  return {
    db,
    job: {
      id: 'job_1',
      type: 'sop.runEscalation',
      payload: { occurrenceId: 'occ_1', policyId: 'policy_1', now: NOW_ISO, ...payloadOverride },
      organizationId: 'org_1',
      status: 'RUNNING',
      attempts: 1,
      maxAttempts: 5,
      scheduledAt: NOW,
      nextAttemptAt: NOW,
      claimedAt: NOW,
      claimedBy: 'worker_1',
      lastError: null,
      idempotencyKey: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

describe('sopEscalationHandler', () => {
  it('fires step 1 on first run (no prior events)', async () => {
    const db = makeDb({});
    const ctx = makeCtx(db);
    await sopEscalationHandler(ctx);

    const createCalls = (db.restaurantSopEscalationEvent as { create: MockFn }).create.mock.calls;
    expect(createCalls.length).toBe(1);
    expect(createCalls[0][0].data).toMatchObject({ kind: 'FIRED', escalationStepId: 'step_a' });

    const notifCalls = (db.restaurantNotification as { create: MockFn }).create.mock.calls;
    expect(notifCalls.length).toBe(1);
  });

  it('does nothing when occurrence is already VERIFIED (stopOnVerified)', async () => {
    const db = makeDb({ occ: { ...BASE_OCCURRENCE, status: 'VERIFIED' } });
    const ctx = makeCtx(db);
    await sopEscalationHandler(ctx);

    // Should write a STOPPED event
    const createCalls = (db.restaurantSopEscalationEvent as { create: MockFn }).create.mock.calls;
    expect(createCalls.length).toBe(1);
    expect(createCalls[0][0].data.kind).toBe('STOPPED');
    expect((db.restaurantNotification as { create: MockFn }).create).not.toHaveBeenCalled();
  });

  it('stops when an ACKNOWLEDGED event exists (stopOnAcknowledged)', async () => {
    const db = makeDb({
      events: [{ id: 'evt_ack', escalationStepId: null, kind: 'ACKNOWLEDGED' }],
    });
    const ctx = makeCtx(db);
    await sopEscalationHandler(ctx);

    // Should write a STOPPED event
    const createCalls = (db.restaurantSopEscalationEvent as { create: MockFn }).create.mock.calls;
    expect(createCalls[createCalls.length - 1][0].data.kind).toBe('STOPPED');
    expect((db.restaurantNotification as { create: MockFn }).create).not.toHaveBeenCalled();
  });

  it('stops when all steps are exhausted', async () => {
    const db = makeDb({
      events: [
        { id: 'evt_a', escalationStepId: 'step_a', kind: 'FIRED' },
        { id: 'evt_b', escalationStepId: 'step_b', kind: 'FIRED' },
      ],
    });
    const ctx = makeCtx(db);
    await sopEscalationHandler(ctx);

    const createCalls = (db.restaurantSopEscalationEvent as { create: MockFn }).create.mock.calls;
    expect(createCalls[0][0].data.kind).toBe('STOPPED');
    expect((db.restaurantNotification as { create: MockFn }).create).not.toHaveBeenCalled();
  });

  it('does nothing during quiet hours', async () => {
    // 14:00 UTC → 840 minutes. Set quiet hours 13:00–15:00 (780–900).
    const db = makeDb({
      policy: { ...BASE_POLICY, quietHoursStartMinutes: 780, quietHoursEndMinutes: 900 },
    });
    const ctx = makeCtx(db);
    await sopEscalationHandler(ctx);

    // No notification, no escalation event written
    expect((db.restaurantNotification as { create: MockFn }).create).not.toHaveBeenCalled();
    expect((db.restaurantSopEscalationEvent as { create: MockFn }).create).not.toHaveBeenCalled();
  });

  it('defers step 2 when delay has not elapsed', async () => {
    // step_b requires 30 min delay. Last FIRED was at NOW, so step_b should not fire yet.
    const db = makeDb({
      events: [{ id: 'evt_a', escalationStepId: 'step_a', kind: 'FIRED' }],
    });
    // Return createdAt = NOW for the last FIRED event
    (db.restaurantSopEscalationEvent as { findUnique: MockFn }).findUnique = vi
      .fn()
      .mockResolvedValue({ createdAt: NOW });
    const ctx = makeCtx(db);
    await sopEscalationHandler(ctx);

    // step_b delay (30 min) not elapsed → no notification
    expect((db.restaurantNotification as { create: MockFn }).create).not.toHaveBeenCalled();
  });

  it('rejects unknown payload key (strict zod)', async () => {
    const db = makeDb({});
    const ctx = makeCtx(db, { unknownKey: true });
    await expect(sopEscalationHandler(ctx)).rejects.toThrow();
  });
});

// ── acknowledgeEscalation ──────────────────────────────────────────────────────

describe('acknowledgeEscalation', () => {
  it('creates an ACKNOWLEDGED event on first call', async () => {
    const db = makeDb({ existingAckEvent: null });
    const result = await acknowledgeEscalation(db, { occurrenceId: 'occ_1' });
    expect(result.occurrenceId).toBe('occ_1');
    expect((db.restaurantSopEscalationEvent as { create: MockFn }).create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'ACKNOWLEDGED' }) })
    );
  });

  it('is idempotent — returns existing event without creating a second', async () => {
    const existingEvent = { id: 'evt_existing' };
    const db = makeDb({ existingAckEvent: existingEvent });
    const result = await acknowledgeEscalation(db, { occurrenceId: 'occ_1' });
    expect(result.eventId).toBe('evt_existing');
    expect((db.restaurantSopEscalationEvent as { create: MockFn }).create).not.toHaveBeenCalled();
  });
});
