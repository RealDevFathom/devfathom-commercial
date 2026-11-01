import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  RESTAURANT_NOTIFICATION_CHANNELS,
  resolveNotificationMatrix,
} from '@/lib/restaurant/notifications';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { encryptSecret } from '@/lib/secret-crypto';
import {
  assertSafeWebhookUrl,
  NOTIFICATION_WEBHOOK_JOB_TYPE,
  NOTIFICATION_WEBHOOK_PAYLOAD_VERSION,
  notificationWebhookJobPayloadSchema,
} from '@/lib/restaurant/notification-webhook';
import { enqueue, type RestaurantJobStatus } from '@/lib/restaurant/scheduler';
import { assertInOrganization } from '../org-refs';
import { capabilityProcedure, protectedProcedure, router } from '../trpc';
import { annotateAudit } from '../audit';

const identifier = z.string().trim().min(1).max(200);
const category = z.string().trim().min(1).max(100);
const channel = z.enum(RESTAURANT_NOTIFICATION_CHANNELS);

async function requireSessionStaffProfile(db: ScopedDb, userId: string): Promise<string> {
  const profile = await db.restaurantStaffProfile.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!profile) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your account is not linked to a restaurant staff profile.',
    });
  }
  return profile.id;
}

const inAppDelivery = {
  some: { channel: 'IN_APP' as const, status: 'DELIVERED_IN_APP' as const },
};

const matrixProcedure = capabilityProcedure('staff:manage');
const webhookProcedure = capabilityProcedure('staff:manage');

export const restaurantNotificationsRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          cursor: identifier.optional(),
          limit: z.number().int().min(1).max(100).default(50),
          unreadOnly: z.boolean().default(false),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const recipientStaffProfileId = await requireSessionStaffProfile(ctx.db, ctx.session.user.id);
      const rows = await ctx.db.restaurantNotification.findMany({
        where: {
          recipientStaffProfileId,
          deliveries: inAppDelivery,
          ...(input.unreadOnly ? { isRead: false } : {}),
        },
        select: {
          id: true,
          branchId: true,
          category: true,
          title: true,
          body: true,
          entityType: true,
          entityId: true,
          isRead: true,
          readAt: true,
          createdAt: true,
          deliveries: {
            select: { channel: true, status: true, attempt: true, error: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const nextCursor = rows.length > input.limit ? rows[input.limit - 1]?.id : undefined;
      return { items: rows.slice(0, input.limit), nextCursor };
    }),

  unreadCount: protectedProcedure.input(z.object({}).strict()).query(async ({ ctx }) => {
    const recipientStaffProfileId = await requireSessionStaffProfile(ctx.db, ctx.session.user.id);
    const count = await ctx.db.restaurantNotification.count({
      where: { recipientStaffProfileId, isRead: false, deliveries: inAppDelivery },
    });
    return { count };
  }),

  markRead: protectedProcedure
    .input(z.object({ id: identifier }).strict())
    .mutation(async ({ ctx, input }) => {
      const recipientStaffProfileId = await requireSessionStaffProfile(ctx.db, ctx.session.user.id);
      const existing = await ctx.db.restaurantNotification.findFirst({
        where: { id: input.id, recipientStaffProfileId, deliveries: inAppDelivery },
        select: { id: true, isRead: true, readAt: true },
      });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification not found.' });
      if (existing.isRead) return existing;

      const readAt = new Date();
      await ctx.db.restaurantNotification.updateMany({
        where: { id: input.id, recipientStaffProfileId },
        data: { isRead: true, readAt },
      });
      return { id: existing.id, isRead: true, readAt };
    }),

  markAllRead: protectedProcedure.input(z.object({}).strict()).mutation(async ({ ctx }) => {
    const recipientStaffProfileId = await requireSessionStaffProfile(ctx.db, ctx.session.user.id);
    const readAt = new Date();
    const result = await ctx.db.restaurantNotification.updateMany({
      where: { recipientStaffProfileId, isRead: false, deliveries: inAppDelivery },
      data: { isRead: true, readAt },
    });
    return { count: result.count, readAt };
  }),

  getMatrix: matrixProcedure
    .input(z.object({ category, branchId: identifier.nullable().default(null) }).strict())
    .query(async ({ ctx, input }) => {
      const matrix = await resolveNotificationMatrix(ctx.db, input.category, input.branchId);
      return {
        category: input.category,
        branchId: input.branchId,
        channels: RESTAURANT_NOTIFICATION_CHANNELS.map((name) => ({
          channel: name,
          enabled: matrix[name],
        })),
      };
    }),

  updateMatrix: matrixProcedure
    .input(
      z
        .object({
          category,
          branchId: identifier.nullable().default(null),
          channel,
          enabled: z.boolean(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      if (input.branchId) {
        const organizationId = ctx.entitlements.organizationId ?? ctx.session?.user.organizationId;
        if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
        await assertInOrganization(ctx.db.restaurantBranch, organizationId, [input.branchId], {
          active: true,
        });
      }
      const existing = await ctx.db.restaurantNotificationChannelSetting.findFirst({
        where: {
          branchId: input.branchId,
          category: input.category,
          channel: input.channel,
        },
        select: { id: true },
      });
      if (existing) {
        return ctx.db.restaurantNotificationChannelSetting.update({
          where: { id: existing.id },
          data: { enabled: input.enabled },
        });
      }
      return ctx.db.restaurantNotificationChannelSetting.create({ data: input });
    }),

  webhookStatus: webhookProcedure.input(z.object({}).strict()).query(async ({ ctx }) => {
    const [config, deliveries] = await Promise.all([
      ctx.db.restaurantNotificationWebhook.findFirst({
        select: {
          id: true,
          endpointUrl: true,
          enabled: true,
          lastSuccessAt: true,
          lastFailureAt: true,
          lastFailure: true,
          updatedAt: true,
        },
      }),
      ctx.db.restaurantJob.findMany({
        where: { type: NOTIFICATION_WEBHOOK_JOB_TYPE },
        select: {
          id: true,
          status: true,
          attempts: true,
          nextAttemptAt: true,
          lastError: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    return { config: config ? { ...config, signingSecretConfigured: true } : null, deliveries };
  }),

  configureWebhook: webhookProcedure
    .input(
      z
        .object({
          endpointUrl: z.string().trim().min(1).max(2048),
          enabled: z.boolean(),
          signingSecret: z.string().min(32).max(256).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        action: 'CONFIGURE_RESTAURANT_NOTIFICATION_WEBHOOK',
        targetType: 'RestaurantNotificationWebhook',
        skipInput: true,
      });
      // `assertSafeWebhookUrl` throws a plain Error with an operator-facing
      // message (non-HTTPS, credentials, private network, ...). Reaching the
      // client unwrapped it becomes a 500 INTERNAL_SERVER_ERROR; these are
      // validation failures the operator can act on, so surface them as 400.
      let endpointUrl: string;
      try {
        endpointUrl = (await assertSafeWebhookUrl(input.endpointUrl)).toString();
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Webhook endpoint is not valid.',
          cause: error,
        });
      }
      const existing = await ctx.db.restaurantNotificationWebhook.findFirst({
        select: { id: true },
      });
      if (!existing && !input.signingSecret) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A signing secret is required when creating the webhook.',
        });
      }
      const secret = input.signingSecret ? encryptSecret(input.signingSecret) : undefined;
      const saved = existing
        ? await ctx.db.restaurantNotificationWebhook.update({
            where: { id: existing.id },
            data: {
              endpointUrl,
              enabled: input.enabled,
              ...(secret ? { encryptedSigningSecret: secret } : {}),
            },
            select: { id: true, endpointUrl: true, enabled: true, updatedAt: true },
          })
        : await ctx.db.restaurantNotificationWebhook.create({
            data: { endpointUrl, enabled: input.enabled, encryptedSigningSecret: secret! },
            select: { id: true, endpointUrl: true, enabled: true, updatedAt: true },
          });
      return { ...saved, signingSecretConfigured: true };
    }),

  testWebhook: webhookProcedure.input(z.object({}).strict()).mutation(async ({ ctx }) => {
    const config = await ctx.db.restaurantNotificationWebhook.findFirst({
      select: { enabled: true },
    });
    if (!config?.enabled)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Enable the webhook before sending a test.',
      });
    const id = `rnow_test_${randomUUID()}`;
    const { job } = await enqueue(ctx.db, {
      type: NOTIFICATION_WEBHOOK_JOB_TYPE,
      idempotencyKey: `notification-webhook:${id}:test`,
      payload: {
        eventId: id,
        synthetic: true,
        attemptOffset: 0,
        version: NOTIFICATION_WEBHOOK_PAYLOAD_VERSION,
      },
    });
    return { eventId: job.id };
  }),

  retryWebhook: webhookProcedure
    .input(z.object({ eventId: identifier }).strict())
    .mutation(async ({ ctx, input }) => {
      const dead = await ctx.db.restaurantJob.findFirst({
        where: { id: input.eventId, type: NOTIFICATION_WEBHOOK_JOB_TYPE, status: 'DEAD' },
        select: { id: true, organizationId: true, attempts: true, payload: true },
      });
      if (!dead)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Dead-letter webhook event not found.' });
      const payload = notificationWebhookJobPayloadSchema.parse(dead.payload);
      const idempotencyKey = `notification-webhook:${payload.eventId}:retry:${dead.id}`;
      const successorPayload = JSON.stringify({
        ...payload,
        attemptOffset: payload.attemptOffset + dead.attempts,
      });
      const [job] = await ctx.db.$queryRaw<{ id: string; status: RestaurantJobStatus }[]>`
        INSERT INTO "restaurant_jobs"
          ("id", "organizationId", "type", "idempotencyKey", "payload", "status", "updatedAt")
        VALUES
          (${randomUUID()}, ${dead.organizationId}, ${NOTIFICATION_WEBHOOK_JOB_TYPE},
           ${idempotencyKey}, ${successorPayload}::jsonb, 'QUEUED', now())
        ON CONFLICT ("organizationId", "idempotencyKey") DO UPDATE
          SET "idempotencyKey" = EXCLUDED."idempotencyKey"
        RETURNING "id", "status"::text
      `;
      if (!job) throw new Error('Webhook retry successor was not returned.');
      annotateAudit(ctx, {
        action: 'RETRY_RESTAURANT_NOTIFICATION_WEBHOOK',
        targetType: 'RestaurantJob',
        targetId: dead.id,
      });
      return { eventId: job.id, status: job.status };
    }),
});
