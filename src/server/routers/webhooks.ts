import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure, entitlementIndependentAdminProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import { WEBHOOK_EVENTS } from '@/lib/webhooks';
import { assertWebhookUrl, assertWebhookUrlAllowed } from '@/lib/webhooks/safe-url';

// Syntax only. DNS is checked in the mutation so a licensed request fails
// closed on a private answer, without a lookup during input parsing.
const urlSchema = z.string().refine(
  (value) => {
    try {
      assertWebhookUrl(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Webhook URL is not allowed.' }
);

async function assertDeliverableUrl(url: string) {
  try {
    await assertWebhookUrlAllowed(url);
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Webhook URL is not allowed.' });
  }
}

const eventsSchema = z.array(z.enum(WEBHOOK_EVENTS)).min(1);

// The secret is write-once (shown to the admin at creation, signs every
// delivery) — never echo it back in list/update payloads.
const PUBLIC_SELECT = {
  id: true,
  url: true,
  events: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const webhooksRouter = router({
  list: entitlementIndependentAdminProcedure.query(async ({ ctx }) => {
    return ctx.db.webhook.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        ...PUBLIC_SELECT,
        createdBy: { select: { id: true, name: true, avatar: true } },
        deliveries: {
          orderBy: { attemptedAt: 'desc' },
          take: 5,
          select: {
            id: true,
            event: true,
            statusCode: true,
            success: true,
            error: true,
            attemptedAt: true,
          },
        },
        _count: { select: { deliveries: true } },
      },
    });
  }),

  recentDeliveries: entitlementIndependentAdminProcedure
    .input(z.object({ webhookId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.webhookDelivery.findMany({
        where: { webhookId: input.webhookId },
        orderBy: { attemptedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          event: true,
          statusCode: true,
          success: true,
          error: true,
          attemptedAt: true,
        },
      });
    }),

  create: adminProcedure
    .input(
      z.object({
        url: urlSchema,
        events: eventsSchema,
        active: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertDeliverableUrl(input.url);
      // High-entropy signing secret — returned ONCE so the admin can copy it.
      const secret = randomBytes(32).toString('hex');

      const created = await ctx.db.webhook.create({
        data: {
          url: input.url,
          secret,
          events: input.events,
          active: input.active ?? true,
          createdById: ctx.session.user.id,
        },
        select: PUBLIC_SELECT,
      });

      annotateAudit(ctx, {
        targetType: 'Webhook',
        targetId: created.id,
        targetLabel: created.url,
        description: `Created webhook → ${created.url}`,
        metadata: { events: created.events, active: created.active },
      });

      // The signing secret is surfaced exactly here, never again.
      return { ...created, secret };
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string(),
        url: urlSchema.optional(),
        events: eventsSchema.optional(),
        active: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.url) await assertDeliverableUrl(input.url);
      const { id, ...data } = input;
      return ctx.db.webhook.update({
        where: { id },
        data,
        select: PUBLIC_SELECT,
      });
    }),

  delete: entitlementIndependentAdminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await ctx.db.webhook.delete({
        where: { id: input.id },
        select: PUBLIC_SELECT,
      });
      annotateAudit(ctx, {
        targetType: 'Webhook',
        targetId: deleted.id,
        targetLabel: deleted.url,
        description: `Deleted webhook → ${deleted.url}`,
        metadata: { events: deleted.events },
      });
      return deleted;
    }),
});
