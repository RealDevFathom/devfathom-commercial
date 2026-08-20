import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  RESTAURANT_NOTIFICATION_CHANNELS,
  resolveNotificationMatrix,
} from '@/lib/restaurant/notifications';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { capabilityProcedure, protectedProcedure, router } from '../trpc';

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
});
