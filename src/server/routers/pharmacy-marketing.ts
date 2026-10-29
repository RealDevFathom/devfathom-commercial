import { Prisma } from '@/generated/prisma/client';
import { generateGrowthRecommendations } from '@/lib/ai/growth-recommendations';
import {
  buildPharmacyGrowthInput,
  growthPeriodInput,
  growthReviewInput,
  listGrowthInsights,
  reviewGrowthInsight,
  saveGrowthInsight,
} from '@/lib/pharmacy/growth-insights';
import { generateMarketingAttribution } from '@/lib/pharmacy/marketing-attribution';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { readAskFathomSettings } from '@/lib/ai/ask-fathom-settings';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import {
  dispatchSandboxCampaign,
  dispatchDueSandboxCampaigns,
  dueSandboxInput,
  type MarketingTransaction,
  sandboxDispatchInput,
  campaignDeliveryHistory,
} from '@/lib/pharmacy/marketing-delivery';
import {
  approveMarketingCampaign,
  approveMarketingTemplate,
  captureMarketingCampaign,
  createMarketingDraft,
  marketingCampaignInput,
  marketingDraftInput,
  marketingHistory,
  marketingScopeInput,
  marketingTemplateInput,
  MarketingWorkflowError,
  previewMarketingCampaign,
  reviewMarketingCampaign,
  type MarketingScope,
} from '@/lib/pharmacy/marketing-service';
import { draftMarketingCopy, marketingAssistanceInput } from '@/lib/pharmacy/marketing-assistance';
import { draftBusinessReviewReply } from '@/lib/pharmacy/business-profile';
import { protectedProcedure, router, type TRPCContext } from '../trpc';

type MarketingAccessContext = Pick<TRPCContext, 'session' | 'entitlements' | 'audit'> & {
  db: Pick<ScopedDb, 'organization' | 'pharmacyBranch'>;
};

async function owner(ctx: MarketingAccessContext) {
  if (ctx.session?.user.role !== 'ADMIN' || !hasModule(ctx.entitlements, 'pharmacy-crm'))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Owner access and Pharmacy CRM are required.',
    });
  const organization = await ctx.db.organization.findUnique({
    where: { id: ctx.entitlements.organizationId },
    select: { id: true, vertical: true, status: true, timezone: true },
  });
  if (
    !organization ||
    organization.vertical !== 'PHARMACY' ||
    !isTenantLifecycleAccessible(organization.status)
  )
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'An active pharmacy workspace is required.',
    });
  ctx.audit.detail = { action: 'pharmacy_marketing', skipInput: true };
  return organization;
}

async function scope(ctx: MarketingAccessContext, branchId: string): Promise<MarketingScope> {
  const organization = await owner(ctx);
  const branch = await ctx.db.pharmacyBranch.findFirst({
    where: { organizationId: organization.id, id: branchId, active: true },
    select: { id: true },
  });
  if (!branch)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'An authorized active branch is required.' });
  return {
    organizationId: organization.id,
    branchId,
    actorId: ctx.session!.user.id,
    // Quiet hours are read in this zone and the page names it: a stored value
    // Intl refuses is UTC for both, never a RangeError.
    timezone: workspaceTimezone(organization.timezone),
  };
}

async function execute<T>(
  ctx: TRPCContext,
  branchId: string,
  fn: (db: ScopedDb, scope: MarketingScope) => Promise<T>
) {
  const resolved = await scope(ctx, branchId);
  try {
    return await ctx.db.$transaction((db) => fn(db as ScopedDb, resolved));
  } catch (error) {
    if (error instanceof MarketingWorkflowError || error instanceof z.ZodError)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          error instanceof MarketingWorkflowError ? error.message : 'Invalid campaign settings.',
      });
    throw error;
  }
}

function sandboxTransaction(ctx: TRPCContext, branchId: string): MarketingTransaction {
  const userId = ctx.session?.user.id;
  if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return (run) =>
    withTenantDb(
      ctx.entitlements.organizationId,
      async (db) => {
        const actor = await db.user.findFirst({
          where: {
            organizationId: ctx.entitlements.organizationId,
            id: userId,
            role: 'ADMIN',
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (!actor)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Active owner access is required.',
          });
        const entitlements = await resolveOrganizationEntitlements(
          ctx.entitlements.organizationId,
          db
        );
        const resolved = await scope({ ...ctx, db, entitlements }, branchId);
        return run(db, resolved);
      },
      { userId: userId }
    );
}

// Growth mutations re-resolve current entitlements and actor, including after provider latency.
async function growthExecute<T>(
  ctx: TRPCContext,
  branchId: string,
  fn: (db: ScopedDb, resolved: MarketingScope) => Promise<T>
) {
  return ctx.db.$transaction(async (db) => {
    const entitlements = await resolveOrganizationEntitlements(ctx.entitlements.organizationId, db);
    const resolved = await scope({ ...ctx, db, entitlements }, branchId);
    const actor = await db.user.findFirst({
      where: {
        id: resolved.actorId,
        organizationId: resolved.organizationId,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const branchMatch = await db.$queryRaw<Array<{ allowed: boolean }>>(
      Prisma.sql`SELECT (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR current_setting('app.current_branch_id',true)=${branchId}) AS allowed`
    );
    if (!actor || !branchMatch[0]?.allowed)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Current owner and branch access are required.',
      });
    try {
      return await fn(db as ScopedDb, resolved);
    } catch (error) {
      if (error instanceof MarketingWorkflowError || error instanceof z.ZodError)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            error instanceof MarketingWorkflowError ? error.message : 'Invalid growth review.',
        });
      throw error;
    }
  });
}

// Integration export for WHA-1618; root.ts is outside this issue's ownership.
export const pharmacyMarketingRouter = router({
  draftReviewReply: protectedProcedure
    .input(
      marketingScopeInput
        .extend({
          rating: z.number().int().min(1).max(5),
          review: z.string().trim().min(1).max(2_000),
          tone: z.enum(['WARM', 'FORMAL']),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const resolved = await scope(ctx, input.branchId);
      const settings = await readAskFathomSettings(ctx.db, resolved.organizationId);
      if (!settings?.askFathomEnabled)
        return {
          available: false as const,
          draft: null,
          posted: false as const,
          approved: false as const,
        };
      return draftBusinessReviewReply({
        rating: input.rating,
        review: input.review,
        tone: input.tone,
      });
    }),
  growthHistory: protectedProcedure
    .input(marketingScopeInput)
    .query(({ ctx, input }) => growthExecute(ctx, input.branchId, listGrowthInsights)),
  generateGrowth: protectedProcedure.input(growthPeriodInput).mutation(async ({ ctx, input }) => {
    const facts = await growthExecute(ctx, input.branchId, async (db, resolved) => {
      const settings = await readAskFathomSettings(db, resolved.organizationId);
      if (!settings?.askFathomEnabled)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'AI insights are disabled. Manual campaigns remain available.',
        });
      return buildPharmacyGrowthInput(db, resolved, input.from, input.cutoff);
    });
    const result = await generateGrowthRecommendations(facts);
    return growthExecute(ctx, input.branchId, (db, resolved) =>
      saveGrowthInsight(db, resolved, result)
    );
  }),
  reviewGrowth: protectedProcedure
    .input(growthReviewInput)
    .mutation(({ ctx, input }) =>
      growthExecute(ctx, input.branchId, (db, resolved) => reviewGrowthInsight(db, resolved, input))
    ),
  branches: protectedProcedure.query(async ({ ctx }) => {
    const organization = await owner(ctx);
    return ctx.db.pharmacyBranch.findMany({
      where: { organizationId: organization.id, active: true },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }),
  history: protectedProcedure
    .input(marketingScopeInput)
    .query(({ ctx, input }) => execute(ctx, input.branchId, marketingHistory)),
  approveTemplate: protectedProcedure
    .input(marketingTemplateInput)
    .mutation(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, scope) => approveMarketingTemplate(db, scope, input))
    ),
  createDraft: protectedProcedure
    .input(marketingDraftInput)
    .mutation(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, scope) => createMarketingDraft(db, scope, input))
    ),
  review: protectedProcedure
    .input(marketingCampaignInput)
    .query(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, scope) =>
        reviewMarketingCampaign(db, scope, input.campaignId)
      )
    ),
  approve: protectedProcedure
    .input(marketingCampaignInput)
    .mutation(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, scope) =>
        approveMarketingCampaign(db, scope, input.campaignId)
      )
    ),
  preview: protectedProcedure
    .input(marketingCampaignInput)
    .query(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, scope) =>
        previewMarketingCampaign(db, scope, input.campaignId)
      )
    ),
  capture: protectedProcedure
    .input(marketingCampaignInput)
    .mutation(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, scope) =>
        captureMarketingCampaign(db, scope, input.campaignId)
      )
    ),
  deliveryHistory: protectedProcedure
    .input(marketingCampaignInput)
    .query(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, resolved) =>
        campaignDeliveryHistory(db, resolved, input.campaignId)
      )
    ),
  sandboxDue: protectedProcedure.input(dueSandboxInput).mutation(async ({ ctx, input }) => {
    await scope(ctx, input.branchId);
    return dispatchDueSandboxCampaigns(sandboxTransaction(ctx, input.branchId), input);
  }),
  sandbox: protectedProcedure.input(sandboxDispatchInput).mutation(async ({ ctx, input }) => {
    await scope(ctx, input.branchId);
    return dispatchSandboxCampaign(sandboxTransaction(ctx, input.branchId), input);
  }),
  attributeReceipts: protectedProcedure
    .input(marketingScopeInput.extend({ from: z.date(), cutoff: z.date() }).strict())
    .mutation(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, resolved) => {
        if (input.cutoff > new Date())
          throw new MarketingWorkflowError('Attribution cutoff cannot be in the future.');
        return generateMarketingAttribution(db, resolved, input.from, input.cutoff);
      })
    ),
  assist: protectedProcedure
    .input(marketingScopeInput.extend(marketingAssistanceInput.shape).strict())
    .mutation(async ({ ctx, input }) => {
      const resolved = await scope(ctx, input.branchId);
      const settings = await readAskFathomSettings(ctx.db, resolved.organizationId);
      if (!settings?.askFathomEnabled)
        return { available: false as const, body: null, approved: false as const };
      return draftMarketingCopy({ occasion: input.occasion, tone: input.tone });
    }),
});
