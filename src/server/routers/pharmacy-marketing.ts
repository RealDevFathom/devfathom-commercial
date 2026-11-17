import { Prisma } from '@/generated/prisma/client';
import {
  basketGenerateInput,
  basketReviewInput,
  generateBasketInsights,
  listBasketInsights,
  reviewBasketInsight,
} from '@/lib/pharmacy/basket-workflow';
import { generateGrowthRecommendations } from '@/lib/ai/growth-recommendations';
import { can, subjectFromSession } from '@/lib/abac';
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
  WhatsAppComplianceError,
  type MarketingScope,
} from '@/lib/pharmacy/marketing-service';
import { recordWhatsAppComplianceBlock } from '@/lib/pharmacy/whatsapp/compliance-log';
import { afterTenantTransaction } from '@/lib/side-effects/scope';
import {
  marketingSendPolicyInput,
  readMarketingSendPolicy,
  resumeMarketingSending,
  updateMarketingSendPolicy,
} from '@/lib/pharmacy/marketing-send-policy';
import { draftMarketingCopy, marketingAssistanceInput } from '@/lib/pharmacy/marketing-assistance';
import {
  evaluateProfileHealth,
  profileHealthInput,
  reviewReplyInput,
} from '@/lib/pharmacy/business-profile-health';
import { draftReviewReply } from '@/lib/pharmacy/review-reply-drafts';
import {
  authorizeVoucherIssue,
  issueVoucher,
  listVouchers,
  revokeVoucher,
  voucherIssueInput,
  voucherRevokeInput,
} from '@/lib/pharmacy/vouchers';
import { protectedProcedure, router, type TRPCContext } from '../trpc';

type MarketingAccessContext = Pick<TRPCContext, 'session' | 'entitlements' | 'audit'> & {
  db: Pick<ScopedDb, 'organization' | 'pharmacyBranch'>;
};

async function owner(ctx: MarketingAccessContext) {
  if (ctx.session?.user.role !== 'ADMIN')
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'An owner account is required. Ask a workspace owner to open Marketing.',
    });
  if (!hasModule(ctx.entitlements, 'pharmacy-crm'))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'The Pharmacy CRM license is not active. Ask your workspace administrator to enable it.',
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
      message: 'An active pharmacy workspace is required. Contact your workspace administrator.',
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
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'An active pharmacy branch is required. Activate a branch or ask for access to one.',
    });
  return {
    organizationId: organization.id,
    branchId,
    actorId: ctx.session!.user.id,
    // Quiet hours are read in this zone and the page names it: a stored value
    // Intl refuses is UTC for both, never a RangeError.
    timezone: workspaceTimezone(organization.timezone),
  };
}

/**
 * The blocked work rolls back with the request transaction, and a nested `$transaction`
 * reuses it, so the block log is written in a fresh tenant transaction once it ends.
 */
function logComplianceBlock(ctx: TRPCContext, branchId: string, error: WhatsAppComplianceError) {
  const organizationId = ctx.entitlements.organizationId;
  const actorId = ctx.session?.user.id ?? null;
  afterTenantTransaction(() => {
    void withTenantDb(
      organizationId,
      (db) =>
        recordWhatsAppComplianceBlock(db, {
          organizationId,
          branchId,
          actorId,
          subject: error.subject,
          subjectId: error.subjectId,
          result: error.result,
        }),
      { maxWait: 1_000, timeout: 5_000, skipDrain: true }
    ).catch(() => {
      // The refusal still stands; never surface log persistence errors to the caller.
      console.error('PHARMACY_WHATSAPP_COMPLIANCE_LOG_FAILED', { subject: error.subject });
    });
  });
}

async function execute<T>(
  ctx: TRPCContext,
  branchId: string,
  fn: (db: ScopedDb, scope: MarketingScope) => Promise<T>,
  /** Runs after the owner and branch checks, before the transaction opens (PIN checks). */
  prepare?: (scope: MarketingScope) => Promise<void>
) {
  const resolved = await scope(ctx, branchId);
  try {
    await prepare?.(resolved);
    return await ctx.db.$transaction((db) => fn(db as ScopedDb, resolved));
  } catch (error) {
    if (error instanceof WhatsAppComplianceError) logComplianceBlock(ctx, branchId, error);
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
  try {
    return await growthTransaction(ctx, branchId, fn);
  } catch (error) {
    if (!(error instanceof WhatsAppComplianceError)) throw error;
    logComplianceBlock(ctx, branchId, error);
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
}

function growthTransaction<T>(
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
    // Snapshots contain Finance evidence. Match the ledger report gates for reads,
    // generation and review, and recheck them after provider latency before saving.
    for (const action of ['reports:operational', 'reports:financial'] as const) {
      if (
        !(await can(subjectFromSession(ctx.session!.user), action, undefined, {
          db,
          source: 'TRPC',
          ip: ctx.requestMeta.ip,
        }))
      )
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Financial report permission is required.',
        });
    }
    try {
      return await fn(db as ScopedDb, resolved);
    } catch (error) {
      if (error instanceof WhatsAppComplianceError) throw error;
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
  basketHistory: protectedProcedure
    .input(marketingScopeInput)
    .query(({ ctx, input }) => growthExecute(ctx, input.branchId, listBasketInsights)),
  generateBaskets: protectedProcedure
    .input(basketGenerateInput)
    .mutation(({ ctx, input }) =>
      growthExecute(ctx, input.branchId, (db, resolved) =>
        generateBasketInsights(db, resolved, input)
      )
    ),
  reviewBasket: protectedProcedure
    .use(({ ctx, next }) => {
      ctx.audit.detail = { action: 'pharmacy_bundle_review', skipInput: true };
      return next();
    })
    .input(basketReviewInput)
    .mutation(({ ctx, input }) =>
      growthExecute(ctx, input.branchId, (db, resolved) => reviewBasketInsight(db, resolved, input))
    ),
  growthHistory: protectedProcedure
    .input(marketingScopeInput)
    .query(({ ctx, input }) => growthExecute(ctx, input.branchId, listGrowthInsights)),
  generateGrowth: protectedProcedure.input(growthPeriodInput).mutation(async ({ ctx, input }) => {
    const facts = await growthExecute(ctx, input.branchId, async (db, resolved) => {
      const settings = await readAskFathomSettings(db, resolved.organizationId);
      if (!settings?.askFathomEnabled)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'AI insights are turned off for this company. Turn on Ask Fathom in Organization settings, then try again. Manual campaigns remain available.',
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
  sendPolicy: protectedProcedure
    .input(marketingScopeInput)
    .query(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, scope) => readMarketingSendPolicy(db, scope.organizationId))
    ),
  updateSendPolicy: protectedProcedure
    .input(marketingSendPolicyInput)
    .mutation(({ ctx, input }) => {
      const { branchId, ...settings } = input;
      return execute(ctx, branchId, (db, scope) =>
        updateMarketingSendPolicy(db, scope.organizationId, scope.actorId, settings)
      );
    }),
  resumeSending: protectedProcedure
    .input(marketingScopeInput)
    .mutation(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, scope) =>
        resumeMarketingSending(db, scope.organizationId, scope.actorId)
      )
    ),
  approveTemplate: protectedProcedure
    .input(marketingTemplateInput)
    .mutation(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, scope) => approveMarketingTemplate(db, scope, input))
    ),
  // DEV-27: owner-issued vouchers, scoped to non-drug categories.
  vouchers: protectedProcedure
    .input(marketingScopeInput)
    .query(({ ctx, input }) => execute(ctx, input.branchId, listVouchers)),
  // DEV-819: above the value cap a second approver's PIN (or the solo owner's own fresh PIN)
  // is verified before the issue transaction; `issueVoucher` re-checks it inside.
  issueVoucher: protectedProcedure.input(voucherIssueInput).mutation(({ ctx, input }) => {
    let approval: Awaited<ReturnType<typeof authorizeVoucherIssue>> = null;
    return execute(
      ctx,
      input.branchId,
      (db, scope) => issueVoucher(db, scope, input, approval),
      async (scope) => {
        approval = await authorizeVoucherIssue(ctx.db as unknown as ScopedDb, scope, input);
      }
    );
  }),
  // DEV-819: a revoked voucher never redeems again.
  revokeVoucher: protectedProcedure
    .input(voucherRevokeInput)
    .mutation(({ ctx, input }) =>
      execute(ctx, input.branchId, (db, scope) => revokeVoucher(db, scope, input))
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
      // The language is the workspace's stored preference, never free text from the client.
      const org = await ctx.db.organization.findUnique({
        where: { id: resolved.organizationId },
        select: { locale: true },
      });
      return draftMarketingCopy(
        { occasion: input.occasion, tone: input.tone },
        {
          organizationId: resolved.organizationId,
          branchId: resolved.branchId,
          // Stored locales can be regional (ur-PK, en-PK): compare the language subtag.
          locale: org?.locale?.toLowerCase().split(/[-_]/)[0] === 'ur' ? 'ur' : 'en',
        }
      );
    }),
  /** Owner-entered profile facts only; nothing is read from or written to Google. */
  profileHealth: protectedProcedure
    .input(marketingScopeInput.extend(profileHealthInput.shape).strict())
    .mutation(async ({ ctx, input }) => {
      await scope(ctx, input.branchId);
      return evaluateProfileHealth({ facts: input.facts, config: input.config });
    }),
  /** Returns an unposted draft; there is deliberately no procedure that posts a reply. */
  reviewReply: protectedProcedure
    .input(marketingScopeInput.extend(reviewReplyInput.shape).strict())
    .mutation(async ({ ctx, input }) => {
      const resolved = await scope(ctx, input.branchId);
      const settings = await readAskFathomSettings(ctx.db, resolved.organizationId);
      return draftReviewReply(
        {
          rating: input.rating,
          tone: input.tone,
          ...(input.reviewerFirstName ? { reviewerFirstName: input.reviewerFirstName } : {}),
        },
        {
          organizationId: resolved.organizationId,
          branchId: resolved.branchId,
          aiEnabled: Boolean(settings?.askFathomEnabled),
        }
      );
    }),
});
