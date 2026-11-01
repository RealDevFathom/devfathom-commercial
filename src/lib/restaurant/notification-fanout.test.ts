import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { Prisma } from '@/generated/prisma/client';
import {
  NOTIFICATION_AGGREGATE_TYPE,
  NOTIFICATION_FANOUT_JOB,
  NOTIFICATION_REQUEST_EVENT_TYPE,
  appendNotificationRequest,
  notificationFanoutHandler,
  notificationRequestOutboxConsumer,
  registerNotificationOutboxConsumer,
} from './notification-fanout';
import { notificationRequestSchema, type NotificationRequestInput } from './notifications';
import { OutboxConsumerRegistry, type OutboxDispatchRecord } from './outbox-dispatcher';

type Row = Record<string, unknown>;

const REQUEST: NotificationRequestInput = {
  requestId: 'request_1',
  recipientStaffProfileIds: ['staff_1'],
  branchId: null,
  category: 'sop.escalation',
  title: 'SOP overdue',
  body: null,
  entityType: 'RestaurantSopOccurrence',
  entityId: 'occ_1',
  channels: ['IN_APP'],
};
const REQUEST_PAYLOAD = notificationRequestSchema.parse(REQUEST) as Prisma.JsonValue;

function record(payload: Prisma.JsonValue = REQUEST_PAYLOAD): OutboxDispatchRecord {
  return {
    id: 'outbox_1',
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: null,
    eventType: NOTIFICATION_REQUEST_EVENT_TYPE,
    aggregateType: NOTIFICATION_AGGREGATE_TYPE,
    aggregateId: 'request_1',
    payload,
  };
}

describe('notification request outbox', () => {
  it('registers its durable event consumer', () => {
    const registry = new OutboxConsumerRegistry();
    registerNotificationOutboxConsumer(registry);
    expect(registry.resolve(NOTIFICATION_REQUEST_EVENT_TYPE)).toBe(
      notificationRequestOutboxConsumer
    );
  });

  it('appends a deterministic pending outbox row', async () => {
    const createMany = vi.fn(async (input: { data: Row[]; skipDuplicates: boolean }) => {
      void input;
      return { count: 1 };
    });
    const tx = { restaurantEventOutbox: { createMany } } as unknown as ScopedDb;
    const first = await appendNotificationRequest(tx, REQUEST);
    const second = await appendNotificationRequest(tx, REQUEST);
    expect(first).toBe(second);
    expect(createMany.mock.calls[0]?.[0]).toMatchObject({
      data: [
        {
          eventType: NOTIFICATION_REQUEST_EVENT_TYPE,
          aggregateType: NOTIFICATION_AGGREGATE_TYPE,
          aggregateId: 'request_1',
          status: 'PENDING',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('enqueues one idempotent scheduler job across outbox retries', async () => {
    const jobs = new Map<string, Row>();
    const createMany = vi.fn(async ({ data }: { data: Row[] }) => {
      for (const row of data) jobs.set(row.id as string, row);
      return { count: 1 };
    });
    const tx = { restaurantJob: { createMany } } as unknown as ScopedDb;

    await notificationRequestOutboxConsumer(record(), tx);
    await notificationRequestOutboxConsumer(record(), tx);

    expect(jobs.size).toBe(1);
    expect([...jobs.values()][0]).toMatchObject({
      type: NOTIFICATION_FANOUT_JOB,
      idempotencyKey: 'notification-fanout:request_1',
    });
    expect(createMany).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown scheduler payload fields', async () => {
    const invalidPayload: Prisma.JsonValue = {
      requestId: 'request_1',
      recipientStaffProfileIds: ['staff_1'],
      branchId: null,
      category: 'sop.escalation',
      title: 'SOP overdue',
      body: null,
      entityType: 'RestaurantSopOccurrence',
      entityId: 'occ_1',
      channels: ['IN_APP'],
      unknown: true,
    };
    await expect(
      notificationFanoutHandler({
        db: {} as ScopedDb,
        job: {
          id: 'job_1',
          organizationId: 'org_1',
          type: NOTIFICATION_FANOUT_JOB,
          payload: invalidPayload,
          attempts: 1,
          maxAttempts: 5,
          claimedBy: 'worker_1',
          claimToken: 'notification-fanout-test-claim',
          startedAt: new Date(),
        },
      })
    ).rejects.toThrow();
  });
});
