import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import {
  exportInsightReports,
  exportLabourCosts,
  importLabourCost,
  InsightError,
  listInsightReports,
  listLabourCosts,
  readInsightReport,
  readLabourCost,
} from '@/lib/restaurant/insights';
import { enqueueInsightBackfill, RollupError } from '@/lib/restaurant/insight-rollups';
import { capabilityProcedure, router, type TRPCContext } from '../trpc';

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      businessDateToUtcDate(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid calendar date.');
const ID = z.string().min(1).max(200);
const DECIMAL = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const RANGE = z
  .object({
    branchId: ID.optional(),
    from: DATE.optional(),
    to: DATE.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const EXPORT_RANGE = RANGE.omit({ limit: true }).strict();
const READ = z.object({ branchId: ID, businessDate: DATE }).strict();

const operationalProcedure = capabilityProcedure('reports:operational');
const financialProcedure = capabilityProcedure('reports:financial');
const configureProcedure = capabilityProcedure('restaurant:configure');

async function requireAction(ctx: TRPCContext, action: Action): Promise<void> {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const allowed = await can(subjectFromSession(user), action, undefined, {
    db: ctx.db as Prisma.TransactionClient,
    source: 'TRPC',
    ip: ctx.requestMeta.ip,
  });
  if (!allowed) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }
}

/** Branch proof is an ACTIVE linked operator pinned to the requested branch. */
async function requireBranchScope(ctx: TRPCContext, branchId?: string): Promise<void> {
  if (branchId) {
    const branch = await ctx.db.restaurantBranch.findFirst({
      where: { id: branchId },
      select: { id: true },
    });
    if (!branch) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have permission for this branch.',
      });
    }
    const staff = await ctx.db.restaurantStaffProfile.findFirst({
      where: { userId: ctx.session!.user.id, status: 'ACTIVE' },
      select: { primaryBranchId: true },
    });
    if (staff?.primaryBranchId === branchId) return;
  }
  await requireAction(ctx, 'restaurant:configure');
}

async function requireLabourScope(ctx: TRPCContext, branchId?: string): Promise<void> {
  await requireAction(ctx, 'workforce:rates');
  await requireBranchScope(ctx, branchId);
}

function mapInsightError(error: unknown): never {
  if (error instanceof InsightError) {
    throw new TRPCError({
      code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
      message: error.message,
    });
  }
  if (error instanceof RollupError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  throw error;
}

export const restaurantInsightsRouter = router({
  listOperationalReports: operationalProcedure.input(RANGE).query(async ({ ctx, input }) => {
    await requireBranchScope(ctx, input.branchId);
    try {
      return await listInsightReports(ctx.db, 'operational', input);
    } catch (error) {
      mapInsightError(error);
    }
  }),

  readOperationalReport: operationalProcedure.input(READ).query(async ({ ctx, input }) => {
    await requireBranchScope(ctx, input.branchId);
    try {
      return await readInsightReport(ctx.db, 'operational', input);
    } catch (error) {
      mapInsightError(error);
    }
  }),

  exportOperationalReports: operationalProcedure
    .input(EXPORT_RANGE)
    .query(async ({ ctx, input }) => {
      await requireBranchScope(ctx, input.branchId);
      try {
        return await exportInsightReports(ctx.db, 'operational', input);
      } catch (error) {
        mapInsightError(error);
      }
    }),

  listFinancialReports: financialProcedure.input(RANGE).query(async ({ ctx, input }) => {
    await requireBranchScope(ctx, input.branchId);
    try {
      return await listInsightReports(ctx.db, 'financial', input);
    } catch (error) {
      mapInsightError(error);
    }
  }),

  readFinancialReport: financialProcedure.input(READ).query(async ({ ctx, input }) => {
    await requireBranchScope(ctx, input.branchId);
    try {
      return await readInsightReport(ctx.db, 'financial', input);
    } catch (error) {
      mapInsightError(error);
    }
  }),

  exportFinancialReports: financialProcedure.input(EXPORT_RANGE).query(async ({ ctx, input }) => {
    await requireBranchScope(ctx, input.branchId);
    try {
      return await exportInsightReports(ctx.db, 'financial', input);
    } catch (error) {
      mapInsightError(error);
    }
  }),

  backfill: configureProcedure
    .input(z.object({ branchId: ID, from: DATE, to: DATE }).strict())
    .mutation(async ({ ctx, input }) => {
      await requireBranchScope(ctx, input.branchId);
      try {
        return await enqueueInsightBackfill(ctx.db, input);
      } catch (error) {
        mapInsightError(error);
      }
    }),

  importLabourCost: financialProcedure
    .input(
      z
        .object({
          branchId: ID,
          businessDate: DATE,
          labourHours: DECIMAL,
          labourCost: DECIMAL,
          source: z.string().trim().min(1).max(200),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await requireLabourScope(ctx, input.branchId);
      try {
        return await importLabourCost(ctx.db, input);
      } catch (error) {
        mapInsightError(error);
      }
    }),

  listLabourCosts: financialProcedure.input(RANGE).query(async ({ ctx, input }) => {
    await requireLabourScope(ctx, input.branchId);
    try {
      return await listLabourCosts(ctx.db, input);
    } catch (error) {
      mapInsightError(error);
    }
  }),

  readLabourCost: financialProcedure
    .input(z.object({ id: ID }).strict())
    .query(async ({ ctx, input }) => {
      await requireAction(ctx, 'workforce:rates');
      try {
        const fact = await readLabourCost(ctx.db, input.id);
        await requireBranchScope(ctx, fact.branchId);
        return fact;
      } catch (error) {
        mapInsightError(error);
      }
    }),

  exportLabourCosts: financialProcedure.input(EXPORT_RANGE).query(async ({ ctx, input }) => {
    await requireLabourScope(ctx, input.branchId);
    try {
      return await exportLabourCosts(ctx.db, input);
    } catch (error) {
      mapInsightError(error);
    }
  }),
});
