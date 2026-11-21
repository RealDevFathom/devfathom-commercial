import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { readFinancialComparison } from '@/lib/restaurant/financial-comparison';
import {
  exportRestaurantReportCsv,
  readCateringReport,
  readDishProfitabilityReport,
  readFoodCostReport,
  readInventoryReport,
  readOverviewReport,
  readPaymentsReport,
  readPurchasingReport,
  readSopReport,
  readStockMovementReport,
  readWastageReport,
  readWorkforceReport,
  RestaurantReportError,
} from '@/lib/restaurant/reports';
import { annotateAudit } from '../audit';
import {
  auditedProtectedProcedure,
  capabilityProcedure,
  protectedProcedure,
  router,
  type TRPCContext,
} from '../trpc';

const range = z
  .object({
    branchId: z.string().min(1).max(200).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
const stockRange = range.extend({ stockLocationId: z.string().min(1).max(200).optional() });
const section = z.enum([
  'overview',
  'payments',
  'food-cost',
  'dish-profitability',
  'catering',
  'inventory',
  'wastage',
  'stock-movements',
  'purchasing',
  'workforce',
  'sop',
]);
async function allowed(ctx: TRPCContext, action: Action) {
  const user = ctx.session?.user;
  return Boolean(
    user &&
    (await can(subjectFromSession(user), action, undefined, {
      db: ctx.db as Prisma.TransactionClient,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }))
  );
}
async function availableBranches(ctx: TRPCContext) {
  const canAllBranches = await allowed(ctx, 'restaurant:configure');
  if (canAllBranches)
    return {
      canAllBranches,
      branches: await ctx.db.restaurantBranch.findMany({
        where: {
          organizationId: ctx.organization?.id ?? ctx.session!.user.organizationId,
          active: true,
        },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, timezone: true, businessDayCutoff: true },
      }),
    };
  const userId = ctx.session!.user.id;
  const [staff, assignments] = await Promise.all([
    ctx.db.restaurantStaffProfile.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { primaryBranchId: true },
    }),
    ctx.db.restaurantBranchAssignment.findMany({ where: { userId }, select: { branchId: true } }),
  ]);
  const ids = new Set(assignments.map((row) => row.branchId));
  if (staff?.primaryBranchId) ids.add(staff.primaryBranchId);
  return {
    canAllBranches,
    branches: await ctx.db.restaurantBranch.findMany({
      where: {
        organizationId: ctx.organization?.id ?? ctx.session!.user.organizationId,
        id: { in: [...ids] },
        active: true,
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, timezone: true, businessDayCutoff: true },
    }),
  };
}
async function resolvedBranchIds(ctx: TRPCContext, branchId?: string) {
  const available = await availableBranches(ctx);
  if (!branchId && !available.canAllBranches)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'All-branch reports require restaurant:configure.',
    });
  const branchIds = branchId ? [branchId] : available.branches.map((branch) => branch.id);
  if (
    !branchIds.length ||
    branchIds.some((id) => !available.branches.some((branch) => branch.id === id))
  )
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'One or more branches are outside your report scope.',
    });
  return branchIds;
}
async function resolvedRange(ctx: TRPCContext, input: z.infer<typeof stockRange>) {
  const branchIds = await resolvedBranchIds(ctx, input.branchId);
  if (input.stockLocationId) {
    const location = await ctx.db.restaurantStockLocation.findFirst({
      where: { id: input.stockLocationId, branchId: { in: branchIds } },
      select: { id: true },
    });
    if (!location)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'The stock location is outside your report scope.',
      });
  }
  return {
    branchIds,
    from: input.from,
    to: input.to,
    ...(input.stockLocationId ? { stockLocationId: input.stockLocationId } : {}),
  };
}
function requireModule(ctx: TRPCContext, key: string) {
  if (!hasModule(ctx.entitlements, key))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This report source is not licensed.' });
}
async function guarded<T>(
  ctx: TRPCContext,
  input: z.infer<typeof stockRange>,
  read: (resolved: Awaited<ReturnType<typeof resolvedRange>>) => Promise<T>
) {
  const resolved = await resolvedRange(ctx, input);
  try {
    return await read(resolved);
  } catch (error) {
    if (error instanceof RestaurantReportError)
      throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    throw error;
  }
}
const operational = capabilityProcedure('reports:operational');
const financial = capabilityProcedure('reports:financial');
export const restaurantReportsRouter = router({
  branches: protectedProcedure.query(async ({ ctx }) => {
    if (!(await allowed(ctx, 'reports:operational')) && !(await allowed(ctx, 'reports:financial')))
      throw new TRPCError({ code: 'FORBIDDEN' });
    return availableBranches(ctx);
  }),
  overview: operational.input(range).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-pos');
    return guarded(ctx, input, (resolved) => readOverviewReport(ctx.db, resolved));
  }),
  payments: financial.input(range).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-pos');
    return guarded(ctx, input, (resolved) => readPaymentsReport(ctx.db, resolved));
  }),
  financialComparison: financial.input(range).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-pos');
    return guarded(ctx, input, (resolved) =>
      readFinancialComparison(ctx.db, resolved, {
        organizationId: ctx.organization?.id ?? ctx.session!.user.organizationId,
      })
    );
  }),
  foodCost: financial.input(range).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-pos');
    requireModule(ctx, 'restaurant-menu');
    requireModule(ctx, 'restaurant-inventory');
    return guarded(ctx, input, (resolved) => readFoodCostReport(ctx.db, resolved));
  }),
  dishProfitability: financial.input(range).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-pos');
    requireModule(ctx, 'restaurant-menu');
    requireModule(ctx, 'restaurant-inventory');
    return guarded(ctx, input, (resolved) => readDishProfitabilityReport(ctx.db, resolved));
  }),
  catering: financial.input(range).query(async ({ ctx, input }) => {
    requireModule(ctx, 'restaurant-core');
    if (!(await allowed(ctx, 'catering:read')))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'catering:read permission is required.' });
    return guarded(ctx, input, (resolved) => readCateringReport(ctx.db, resolved));
  }),
  inventory: operational.input(range).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-inventory');
    return guarded(ctx, input, (resolved) => readInventoryReport(ctx.db, resolved));
  }),
  stockLocations: operational
    .input(z.object({ branchId: z.string().min(1).max(200).optional() }).strict())
    .query(async ({ ctx, input }) => {
      requireModule(ctx, 'restaurant-inventory');
      const branchIds = await resolvedBranchIds(ctx, input.branchId);
      return ctx.db.restaurantStockLocation.findMany({
        where: { branchId: { in: branchIds } },
        orderBy: [{ branch: { name: 'asc' } }, { name: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          isActive: true,
          branch: { select: { id: true, name: true } },
        },
      });
    }),
  wastage: operational.input(stockRange).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-inventory');
    return guarded(ctx, input, (resolved) => readWastageReport(ctx.db, resolved));
  }),
  stockMovements: operational.input(stockRange).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-inventory');
    return guarded(ctx, input, (resolved) => readStockMovementReport(ctx.db, resolved));
  }),
  purchasing: operational.input(range).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-purchasing');
    return guarded(ctx, input, (resolved) => readPurchasingReport(ctx.db, resolved));
  }),
  workforce: operational.input(range).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-workforce');
    return guarded(ctx, input, (resolved) =>
      readWorkforceReport(ctx.db, resolved, { includeLabourCosts: false })
    );
  }),
  workforceFinancial: financial.input(range).query(async ({ ctx, input }) => {
    requireModule(ctx, 'restaurant-workforce');
    if (!(await allowed(ctx, 'reports:operational')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'reports:operational permission is required.',
      });
    if (!(await allowed(ctx, 'workforce:rates')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'workforce:rates permission is required.',
      });
    return guarded(ctx, input, (resolved) =>
      readWorkforceReport(ctx.db, resolved, { includeLabourCosts: true })
    );
  }),
  sop: operational.input(range).query(({ ctx, input }) => {
    requireModule(ctx, 'restaurant-sop');
    return guarded(ctx, input, (resolved) => readSopReport(ctx.db, resolved));
  }),
  exportCsv: auditedProtectedProcedure
    .input(stockRange.extend({ section }))
    .query(async ({ ctx, input }) => {
      const needsFinancial = ['payments', 'food-cost', 'dish-profitability', 'catering'].includes(
        input.section
      );
      if (needsFinancial && !(await allowed(ctx, 'reports:financial')))
        throw new TRPCError({ code: 'FORBIDDEN' });
      if (!needsFinancial && !(await allowed(ctx, 'reports:operational')))
        throw new TRPCError({ code: 'FORBIDDEN' });
      if (input.section === 'overview' || input.section === 'payments')
        requireModule(ctx, 'restaurant-pos');
      if (input.section === 'food-cost' || input.section === 'dish-profitability') {
        requireModule(ctx, 'restaurant-pos');
        requireModule(ctx, 'restaurant-menu');
        requireModule(ctx, 'restaurant-inventory');
      }
      if (input.section === 'catering') {
        requireModule(ctx, 'restaurant-core');
        if (!(await allowed(ctx, 'catering:read')))
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'catering:read permission is required.',
          });
      }
      if (
        input.section === 'inventory' ||
        input.section === 'wastage' ||
        input.section === 'stock-movements'
      )
        requireModule(ctx, 'restaurant-inventory');
      if (input.section === 'purchasing') requireModule(ctx, 'restaurant-purchasing');
      if (input.section === 'workforce') requireModule(ctx, 'restaurant-workforce');
      if (input.section === 'sop') requireModule(ctx, 'restaurant-sop');
      const includeLabourCosts =
        input.section === 'workforce' &&
        (await allowed(ctx, 'reports:financial')) &&
        (await allowed(ctx, 'workforce:rates'));
      return guarded(ctx, input, async (resolved) => {
        const result = await exportRestaurantReportCsv(ctx.db, input.section, resolved, {
          includeLabourCosts,
        });
        annotateAudit(ctx, {
          metadata: {
            branchIds: resolved.branchIds,
            section: input.section,
            from: resolved.from,
            to: resolved.to,
            ...(resolved.stockLocationId ? { stockLocationId: resolved.stockLocationId } : {}),
          },
        });
        return result;
      });
    }),
});
