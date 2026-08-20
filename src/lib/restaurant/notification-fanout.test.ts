/**
 * M7-L5 — fan-out driver unit tests. Covers the scheduler job handler, the outbox
 * consumer (payload validation + tenant-client binding), idempotent registration,
 * and the transactional producer helper.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));

import {
  NOTIFICATION_FANOUT_JOB,
  NOTIFICATION_REQUESTED_EVENT,
  NOTIFICATION_AGGREGATE_TYPE,
  notificationFanoutHandler,
  createNotificationOutboxConsumer,
  registerNotificationOutboxConsumer,
  appendNotificationRequest,
} from './notification-fanout';
import { OutboxConsumerRegistry } from './outbox-dispatcher';

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function makeFanOutDb() {
  const db = {
    restaurantNotificationChannelSetting: { findMany: vi.fn().mockResolvedValue([]) } as Delegate,
    restaurantNotification: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'notif_1' }),
    } as Delegate,
    restaurantNotificationDelivery: {
      create: vi.fn().mockResolvedValue({ id: 'del_1' }),
    } as Delegate,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return db;
}

const REQUEST = {
  recipientStaffProfileId: 'staff_1',
  category: 'sop.due',
  title: 'SOP due',
};

// ── Scheduler job handler ────────────────────────────────────────────────────

describe('notificationFanoutHandler', () => {
  it('validates the payload and fans out inside the job’s tenant scope', async () => {
    const db = makeFanOutDb();
    await notificationFanoutHandler({
      db: db as never,
      job: { id: 'job_1', type: NOTIFICATION_FANOUT_JOB, payload: REQUEST } as never,
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.restaurantNotification.create).toHaveBeenCalledTimes(1);
    // all channels default-enabled → 4 deliveries
    expect(db.restaurantNotificationDelivery.create).toHaveBeenCalledTimes(4);
  });

  it('rejects an unknown key in the job payload (strict zod)', async () => {
    const db = makeFanOutDb();
    await expect(
      notificationFanoutHandler({
        db: db as never,
        job: {
          id: 'job_1',
          type: NOTIFICATION_FANOUT_JOB,
          payload: { ...REQUEST, oops: 1 },
        } as never,
      })
    ).rejects.toThrow();
    expect(db.restaurantNotification.create).not.toHaveBeenCalled();
  });
});

// ── Outbox consumer ──────────────────────────────────────────────────────────

describe('outbox consumer', () => {
  it('binds a tenant client from the payload org and fans out', async () => {
    const db = makeFanOutDb();
    const resolveTenantDb = vi.fn(() => db as never);
    const consumer = createNotificationOutboxConsumer(resolveTenantDb);

    await consumer({
      id: 'ob_1',
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: null,
      eventType: NOTIFICATION_REQUESTED_EVENT,
      aggregateType: NOTIFICATION_AGGREGATE_TYPE,
      aggregateId: 'agg_1',
      payload: { organizationId: 'org_1', request: REQUEST },
    } as never);

    expect(resolveTenantDb).toHaveBeenCalledWith('org_1');
    expect(db.restaurantNotification.create).toHaveBeenCalledTimes(1);
  });

  it('throws on a payload missing the organizationId (strict)', async () => {
    const consumer = createNotificationOutboxConsumer(vi.fn(() => ({}) as never));
    await expect(
      consumer({
        id: 'ob_1',
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: null,
        eventType: NOTIFICATION_REQUESTED_EVENT,
        aggregateType: NOTIFICATION_AGGREGATE_TYPE,
        aggregateId: 'agg_1',
        payload: { request: REQUEST },
      } as never)
    ).rejects.toThrow();
  });
});

// ── Registration ─────────────────────────────────────────────────────────────

describe('registerNotificationOutboxConsumer', () => {
  it('registers the consumer and is idempotent', () => {
    const registry = new OutboxConsumerRegistry();
    registerNotificationOutboxConsumer(registry);
    expect(registry.has(NOTIFICATION_REQUESTED_EVENT)).toBe(true);
    // second call must not throw the registry's duplicate-registration error
    expect(() => registerNotificationOutboxConsumer(registry)).not.toThrow();
    expect(registry.eventTypes()).toEqual([NOTIFICATION_REQUESTED_EVENT]);
  });
});

// ── Producer helper ──────────────────────────────────────────────────────────

describe('appendNotificationRequest', () => {
  it('writes one outbox row with the notification event + org-in-payload', async () => {
    const tx = {
      restaurantEventOutbox: { create: vi.fn().mockResolvedValue({ id: 'ob_1' }) } as Delegate,
    };
    const result = await appendNotificationRequest(tx as never, {
      organizationId: 'org_1',
      request: { ...REQUEST, entityType: 'sop.occurrence', entityId: 'occ_1' },
    });

    expect(result).toEqual({ outboxId: 'ob_1' });
    const arg = tx.restaurantEventOutbox.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.eventType).toBe(NOTIFICATION_REQUESTED_EVENT);
    expect(arg.data.aggregateType).toBe(NOTIFICATION_AGGREGATE_TYPE);
    // deterministic aggregateId derived from the request
    expect(arg.data.aggregateId).toBe('staff_1:sop.due:sop.occurrence:occ_1');
    expect(arg.data.payload).toEqual({
      organizationId: 'org_1',
      request: { ...REQUEST, entityType: 'sop.occurrence', entityId: 'occ_1' },
    });
  });

  it('rejects an invalid request before writing (strict zod)', async () => {
    const tx = {
      restaurantEventOutbox: { create: vi.fn() } as Delegate,
    };
    await expect(
      appendNotificationRequest(tx as never, {
        organizationId: 'org_1',
        request: { ...REQUEST, bogus: true } as never,
      })
    ).rejects.toThrow();
    expect(tx.restaurantEventOutbox.create).not.toHaveBeenCalled();
  });
});
