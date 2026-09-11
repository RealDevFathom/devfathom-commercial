import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const RESTAURANT_NOTIFICATION_CHANNELS = [
  'IN_APP',
  'WEBHOOK',
  'EMAIL',
  'SMS',
  'PUSH',
  'WHATSAPP',
] as const;

export type RestaurantNotificationChannel = (typeof RESTAURANT_NOTIFICATION_CHANNELS)[number];

const notificationChannelSchema = z.enum(RESTAURANT_NOTIFICATION_CHANNELS);

export const notificationRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(200),
    recipientStaffProfileIds: z.array(z.string().trim().min(1)).min(1).max(500),
    branchId: z.string().trim().min(1).nullable().default(null),
    category: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(4_000).nullable().default(null),
    entityType: z.string().trim().min(1).max(100).nullable().default(null),
    entityId: z.string().trim().min(1).max(200).nullable().default(null),
    channels: z
      .array(notificationChannelSchema)
      .min(1)
      .max(RESTAURANT_NOTIFICATION_CHANNELS.length),
  })
  .strict();

export type NotificationRequest = z.output<typeof notificationRequestSchema>;
export type NotificationRequestInput = z.input<typeof notificationRequestSchema>;

export type NotificationMatrix = Record<RestaurantNotificationChannel, boolean>;

export type NotificationDeliveryResult = {
  notificationCount: number;
  deliveryCount: number;
};

function deterministicId(prefix: string, ...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part.length.toString()).update(':').update(part);
  return `${prefix}_${hash.digest('hex')}`;
}

export function notificationRequestId(...parts: string[]): string {
  return deterministicId('nreq', ...parts);
}

function runNotificationTransaction<T>(
  db: ScopedDb,
  work: (tx: ScopedDb) => Promise<T>
): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

export async function resolveNotificationMatrix(
  db: ScopedDb,
  category: string,
  branchId: string | null
): Promise<NotificationMatrix> {
  const settings = await db.restaurantNotificationChannelSetting.findMany({
    where: {
      category,
      ...(branchId ? { OR: [{ branchId: null }, { branchId }] } : { branchId: null }),
    },
    select: { branchId: true, channel: true, enabled: true },
  });

  const matrix = Object.fromEntries(
    RESTAURANT_NOTIFICATION_CHANNELS.map((channel) => [channel, true])
  ) as NotificationMatrix;

  for (const channel of RESTAURANT_NOTIFICATION_CHANNELS) {
    const org = settings.find(
      (setting) => setting.branchId === null && setting.channel === channel
    );
    const branch = branchId
      ? settings.find((setting) => setting.branchId === branchId && setting.channel === channel)
      : undefined;
    matrix[channel] = branch?.enabled ?? org?.enabled ?? true;
  }

  return matrix;
}

/** Persist one recipient row plus enabled channel attempts. Deterministic primary
 * keys and insert-only conflict handling make retries safe without another table. */
export async function deliverNotificationRequest(
  db: ScopedDb,
  input: NotificationRequestInput
): Promise<NotificationDeliveryResult> {
  const request = notificationRequestSchema.parse(input);
  const recipients = [...new Set(request.recipientStaffProfileIds)];
  const channels = [...new Set(request.channels)];

  return runNotificationTransaction(db, async (tx) => {
    const organization = await tx.organization.findFirst({ select: { isDemo: true } });
    const matrix = await resolveNotificationMatrix(tx, request.category, request.branchId);
    const enabledChannels = channels.filter(
      (channel) => matrix[channel] && (!organization?.isDemo || channel === 'IN_APP')
    );

    const notifications = recipients.map((recipientStaffProfileId) => ({
      id: deterministicId('rnot', request.requestId, recipientStaffProfileId),
      recipientStaffProfileId,
      branchId: request.branchId,
      category: request.category,
      title: request.title,
      body: request.body,
      entityType: request.entityType,
      entityId: request.entityId,
      isRead: false,
      readAt: null,
    }));
    const deliveries = recipients.flatMap((recipientStaffProfileId) => {
      const notificationId = deterministicId('rnot', request.requestId, recipientStaffProfileId);
      return enabledChannels
        .filter((channel) => channel !== 'WEBHOOK')
        .map((channel) => ({
          id: deterministicId('rndl', request.requestId, recipientStaffProfileId, channel),
          notificationId,
          channel,
          status: channel === 'IN_APP' ? ('DELIVERED_IN_APP' as const) : ('STUBBED' as const),
        }));
    });

    await tx.restaurantNotification.createMany({ data: notifications, skipDuplicates: true });
    if (deliveries.length > 0) {
      await tx.restaurantNotificationDelivery.createMany({
        data: deliveries,
        skipDuplicates: true,
      });
    }
    if (enabledChannels.includes('WEBHOOK')) {
      await tx.restaurantEventOutbox.createMany({
        data: recipients.map((recipientStaffProfileId) => {
          const notificationId = deterministicId(
            'rnot',
            request.requestId,
            recipientStaffProfileId
          );
          return {
            id: deterministicId('rnow', request.requestId, recipientStaffProfileId),
            eventType: 'restaurant.notification.webhook.v1',
            aggregateType: 'restaurant.notification',
            aggregateId: notificationId,
            payload: { notificationId, version: '1.0' },
            status: 'PENDING' as const,
          };
        }),
        skipDuplicates: true,
      });
    }

    return { notificationCount: notifications.length, deliveryCount: deliveries.length };
  });
}
