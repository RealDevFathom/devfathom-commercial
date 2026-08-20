import 'server-only';

import { createHash } from 'node:crypto';

import type { Prisma } from '@/generated/prisma/client';
import type { RestaurantJobHandler } from '@/lib/restaurant/job-handlers';
import { OUTBOX_STATUS } from '@/lib/restaurant/outbox';
import {
  OutboxConsumerRegistry,
  restaurantOutboxConsumers,
  type OutboxConsumer,
} from '@/lib/restaurant/outbox-dispatcher';
import {
  deliverNotificationRequest,
  notificationRequestSchema,
  type NotificationRequestInput,
} from '@/lib/restaurant/notifications';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const NOTIFICATION_FANOUT_JOB = 'notification.fanout';
export const NOTIFICATION_REQUEST_EVENT_TYPE = 'notification.requested';
export const NOTIFICATION_AGGREGATE_TYPE = 'restaurant.notification-request';

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex')}`;
}

type NotificationOutboxClient = Pick<ScopedDb, 'restaurantEventOutbox'>;

export async function appendNotificationRequest(
  tx: NotificationOutboxClient,
  input: NotificationRequestInput
): Promise<string> {
  const request = notificationRequestSchema.parse(input);
  const id = deterministicId('reob', request.requestId);
  await tx.restaurantEventOutbox.createMany({
    data: [
      {
        id,
        eventType: NOTIFICATION_REQUEST_EVENT_TYPE,
        aggregateType: NOTIFICATION_AGGREGATE_TYPE,
        aggregateId: request.requestId,
        payload: request as Prisma.InputJsonValue,
        status: OUTBOX_STATUS.PENDING,
      },
    ],
    skipDuplicates: true,
  });
  return id;
}

export const notificationRequestOutboxConsumer: OutboxConsumer = async (record, tx) => {
  const request = notificationRequestSchema.parse(record.payload);
  if (
    record.aggregateType !== NOTIFICATION_AGGREGATE_TYPE ||
    record.aggregateId !== request.requestId
  ) {
    throw new Error('Notification request outbox identity does not match its payload.');
  }

  await tx.restaurantJob.createMany({
    data: [
      {
        id: deterministicId('rnjob', request.requestId),
        type: NOTIFICATION_FANOUT_JOB,
        payload: request as Prisma.InputJsonValue,
        idempotencyKey: `notification-fanout:${request.requestId}`,
      },
    ],
    skipDuplicates: true,
  });
};

export const notificationFanoutHandler: RestaurantJobHandler = async ({ db, job }) => {
  const request = notificationRequestSchema.parse(job.payload);
  await deliverNotificationRequest(db, request);
};

export function registerNotificationOutboxConsumer(registry: OutboxConsumerRegistry): void {
  registry.register(NOTIFICATION_REQUEST_EVENT_TYPE, notificationRequestOutboxConsumer);
}

registerNotificationOutboxConsumer(restaurantOutboxConsumers);
