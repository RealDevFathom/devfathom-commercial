import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { capabilityProcedure, router } from '../trpc';

const configureProcedure = capabilityProcedure('restaurant:configure');
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/**
 * Owner/admin promotion read model. Identifiers are deliberately returned only
 * alongside tenant-scoped, human-readable records so the authoring console can
 * use pickers instead of asking an operator to paste database identifiers.
 */
export const restaurantPromotionsRouter = router({
  list: configureProcedure.query(async ({ ctx }) => {
    const promotions = await ctx.db.restaurantPromotion.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          include: { components: { orderBy: { ordinal: 'asc' } } },
        },
      },
    });

    return promotions.map((promotion) => ({
      ...promotion,
      latestVersion: promotion.versions[0]
        ? {
            ...promotion.versions[0],
            minimumAmount: promotion.versions[0].minimumAmount?.toString() ?? null,
            benefitAmount: promotion.versions[0].benefitAmount?.toString() ?? null,
            maxBenefitAmount: promotion.versions[0].maxBenefitAmount?.toString() ?? null,
            budgetAmount: promotion.versions[0].budgetAmount?.toString() ?? null,
          }
        : null,
      versions: undefined,
    }));
  }),

  pickerOptions: configureProcedure.query(async ({ ctx }) => {
    const [branches, categories, products] = await Promise.all([
      ctx.db.restaurantBranch.findMany({
        where: { active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, timezone: true },
      }),
      ctx.db.restaurantCategory.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, parentId: true },
      }),
      ctx.db.restaurantProduct.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          categoryId: true,
          variants: { orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } },
        },
      }),
    ]);
    return { branches, categories, products };
  }),

  assertBranchAccess: configureProcedure
    .input(strict({ branchId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const branch = await ctx.db.restaurantBranch.findFirst({
        where: { id: input.branchId, active: true },
        select: { id: true, name: true, timezone: true },
      });
      if (!branch) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'The selected branch is unavailable in this workspace.',
        });
      }
      return branch;
    }),
});
