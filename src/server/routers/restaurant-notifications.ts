import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, capabilityProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import {
  NOTIFICATION_CHANNELS,
  listInAppNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  resolveChannelMatrix,
  listChannelSettings,
  upsertChannelSetting,
} from '@/lib/restaurant/notifications';

/**
 * M7-L5 — the restaurant notifications router.
 *
 * Two capability gates, both on the `restaurant-sop` module (via module-catalog):
 *   `notification:read`   — a recipient's own inbox: list + unread count + read
 *                           state. Coarse (any active member) because a personal
 *                           inbox is not an org-role privilege; the recipient is
 *                           an input and every write is scoped to it.
 *   `notification:manage` — the channel-matrix admin surface (read + toggle),
 *                           org-role-driven like `sop:manage`.
 *
 * All input schemas are `.strict()` — an unknown key is REJECTED. Tenant scoping
 * is the RLS-forced `organizationId` on every row.
 */

const readProcedure = capabilityProcedure('notification:read');
const manageProcedure = capabilityProcedure('notification:manage');

const STAFF_ID = z.string().min(1);
const CHANNEL = z.enum(NOTIFICATION_CHANNELS);

export const restaurantNotificationsRouter = router({
  // ── Recipient inbox ─────────────────────────────────────────────────────────

  /** List a recipient's in-app notifications (newest first) with the unread count. */
  list: readProcedure
    .input(
      z
        .object({
          recipientStaffProfileId: STAFF_ID,
          unreadOnly: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      return listInAppNotifications(ctx.db, {
        recipientStaffProfileId: input.recipientStaffProfileId,
        unreadOnly: input.unreadOnly,
        limit: input.limit,
        cursor: input.cursor ?? null,
      });
    }),

  /** The recipient's unread in-app count (a lightweight badge read). */
  unreadCount: readProcedure
    .input(z.object({ recipientStaffProfileId: STAFF_ID }).strict())
    .query(async ({ ctx, input }) => {
      const { unreadCount } = await listInAppNotifications(ctx.db, {
        recipientStaffProfileId: input.recipientStaffProfileId,
        limit: 1,
      });
      return { unreadCount };
    }),

  /** Mark ONE notification read for its recipient. NOT_FOUND when it isn't theirs. */
  markRead: readProcedure
    .input(
      z.object({ notificationId: z.string().min(1), recipientStaffProfileId: STAFF_ID }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      const result = await markNotificationRead(ctx.db, {
        notificationId: input.notificationId,
        recipientStaffProfileId: input.recipientStaffProfileId,
      });
      if (!result.found) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification not found.' });
      }
      annotateAudit(ctx, {
        targetType: 'RestaurantNotification',
        targetId: input.notificationId,
        description: 'Marked notification read',
      });
      return result;
    }),

  /** Mark every unread notification read for a recipient. Returns the count flipped. */
  markAllRead: readProcedure
    .input(z.object({ recipientStaffProfileId: STAFF_ID }).strict())
    .mutation(async ({ ctx, input }) => {
      const result = await markAllNotificationsRead(ctx.db, {
        recipientStaffProfileId: input.recipientStaffProfileId,
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantStaffProfile',
        targetId: input.recipientStaffProfileId,
        description: `Marked all notifications read (${result.updated})`,
      });
      return result;
    }),

  // ── Channel-matrix admin ─────────────────────────────────────────────────────

  /** List the raw channel-setting rows (org defaults + branch overrides). */
  listChannelSettings: manageProcedure
    .input(
      z
        .object({
          branchId: z.string().min(1).nullable().optional(),
          category: z.string().min(1).max(255).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const items = await listChannelSettings(ctx.db, {
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
      });
      return { items };
    }),

  /** Resolve the effective matrix for a `(branchId, category)` (branch-then-org). */
  resolveChannelMatrix: manageProcedure
    .input(
      z
        .object({
          branchId: z.string().min(1).nullable().optional(),
          category: z.string().min(1).max(255),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const matrix = await resolveChannelMatrix(ctx.db, {
        branchId: input.branchId ?? null,
        category: input.category,
      });
      return { matrix };
    }),

  /** Enable/disable one `(branchId, category, channel)` cell of the matrix. */
  setChannelSetting: manageProcedure
    .input(
      z
        .object({
          branchId: z.string().min(1).nullable().optional(),
          category: z.string().min(1).max(255),
          channel: CHANNEL,
          enabled: z.boolean(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const setting = await upsertChannelSetting(ctx.db, {
        branchId: input.branchId ?? null,
        category: input.category,
        channel: input.channel,
        enabled: input.enabled,
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantNotificationChannelSetting',
        targetId: setting.id,
        description: `Set ${input.category}/${input.channel} = ${input.enabled ? 'on' : 'off'}`,
      });
      return setting;
    }),
});
