import { expect, it, vi } from 'vitest';
import {
  createNotificationWebhookConsumer,
  createNotificationWebhookJobHandler,
} from '@/lib/restaurant/notification-webhook';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { OutboxDispatchRecord } from '@/lib/restaurant/outbox-dispatcher';
import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';

const enqueue = vi.hoisted(() => vi.fn());
vi.mock('@/lib/restaurant/scheduler', () => ({ enqueue }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: () => {
    throw new Error('unexpected database creation');
  },
}));
vi.mock('@/lib/secret-crypto', () => ({
  decryptSecret: () => {
    throw new Error('unexpected secret access');
  },
}));
vi.mock('@/lib/restaurant/outbox-dispatcher', () => ({
  restaurantOutboxConsumers: { has: () => false, register: vi.fn() },
}));
function scoped(isDemo: boolean) {
  return {
    organization: { findFirst: vi.fn().mockResolvedValue({ isDemo }) },
    restaurantNotificationWebhook: {
      findFirst: vi.fn(() => {
        throw new Error('configuration must not be read');
      }),
    },
  };
}
const payload = { notificationId: 'notification', version: '1.0' };
const record: OutboxDispatchRecord = {
  id: 'event',
  eventType: 'restaurant.notification.webhook.v1',
  aggregateType: 'restaurant.notification',
  aggregateId: 'notification',
  payload,
  status: 'PENDING',
  attempts: 0,
  nextAttemptAt: new Date(0),
};
it('denies demo webhook before enqueue, while ordinary tenant still enqueues', async () => {
  enqueue.mockClear();
  const consumer = createNotificationWebhookConsumer();
  await consumer(record, scoped(true) as unknown as ScopedDb);
  expect(enqueue).not.toHaveBeenCalled();
  await consumer(record, scoped(false) as unknown as ScopedDb);
  expect(enqueue).toHaveBeenCalledOnce();
});
it('denies demo webhook again at delivery before config, DNS, secret, transport or failure writes', async () => {
  const db = scoped(true);
  const lookup = vi.fn();
  const transport = vi.fn();
  const failureDb = vi.fn();
  const handler = createNotificationWebhookJobHandler({ lookup, transport, failureDb });
  await handler({
    db,
    job: { payload: { ...payload, eventId: 'event' }, attempts: 1 },
  } as unknown as RestaurantJobContext);
  expect(db.organization.findFirst).toHaveBeenCalledExactlyOnceWith({ select: { isDemo: true } });
  expect(db.restaurantNotificationWebhook.findFirst).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  expect(failureDb).not.toHaveBeenCalled();
});
