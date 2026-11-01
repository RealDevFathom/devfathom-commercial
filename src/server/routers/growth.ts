import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule } from '@/lib/entitlements';
import { campaignInput, createCampaign, transitionCampaign } from '@/lib/growth/campaigns';
import { capabilityProcedure, router } from '@/server/trpc';

const growthProcedure = capabilityProcedure('growth.manage').use(async ({ ctx, next }) => {
  const organizationId = ctx.session!.user.organizationId;
  if (
    !organizationId ||
    organizationId !== ctx.entitlements.organizationId ||
    !hasModule(ctx.entitlements, 'growth_ai')
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
  ctx.audit.detail = { action: 'growth_campaign', skipInput: true };
  return next({ ctx: { ...ctx, growthOrganizationId: organizationId } });
});
const idInput = z.object({ id: z.string().min(1) }).strict();
export const growthRouter = router({
  campaigns: router({
    list: growthProcedure.query(({ ctx }) =>
      ctx.db.campaign.findMany({
        where: { organizationId: ctx.growthOrganizationId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
    ),
    get: growthProcedure
      .input(idInput)
      .query(({ ctx, input }) =>
        ctx.db.campaign.findFirst({
          where: { organizationId: ctx.growthOrganizationId, id: input.id },
          include: { recipients: { take: 100, orderBy: { id: 'asc' } } },
        })
      ),
    create: growthProcedure
      .input(campaignInput)
      .mutation(({ ctx, input }) =>
        ctx.db.$transaction((db) =>
          createCampaign(db as ScopedDb, ctx.growthOrganizationId, ctx.session!.user.id, input)
        )
      ),
    approve: growthProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        ctx.db.$transaction((db) =>
          transitionCampaign(
            db as ScopedDb,
            ctx.growthOrganizationId,
            ctx.session!.user.id,
            input.id,
            'approve'
          )
        )
      ),
    cancel: growthProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        ctx.db.$transaction((db) =>
          transitionCampaign(
            db as ScopedDb,
            ctx.growthOrganizationId,
            ctx.session!.user.id,
            input.id,
            'cancel'
          )
        )
      ),
  }),
});
