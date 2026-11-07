import { restaurantGrowthBinding } from '@/lib/restaurant/growth-binding';
import {
  growthGenerateInput,
  growthListInput,
  generateRestaurantGrowth,
  listRestaurantGrowth,
} from '@/lib/restaurant/growth-generation';
import { TRPCError } from '@trpc/server';
import type { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { growthReadInput, growthReviewInput } from '@/lib/restaurant/growth-review-contract';
import {
  GrowthReviewError,
  readRestaurantGrowthReview,
  reviewRestaurantGrowth,
  type GrowthActor,
  type RestaurantGrowthBinding,
} from '@/lib/restaurant/growth-review';
import { auditedProtectedProcedure, router, type TRPCContext } from '../trpc';

function actor(ctx: TRPCContext): GrowthActor {
  const user = ctx.session!.user;
  return {
    db: ctx.db,
    ctx: {
      organizationId: ctx.organization?.id ?? user.organizationId,
      userId: user.id,
      role: user.role,
      vertical: ctx.organization?.vertical === 'RESTAURANT' ? 'RESTAURANT' : null,
      enabledModules: ['restaurant-core', 'restaurant-pos'].filter((key) =>
        hasModule(ctx.entitlements, key)
      ),
    },
    can: (action) =>
      can(subjectFromSession(user), action, undefined, {
        db: ctx.db as Prisma.TransactionClient,
        source: 'TRPC',
        ip: ctx.requestMeta.ip,
      }),
  };
}
/**
 * Generation spends AI credits and review drafts customer outreach, so both
 * require the growth write grant (financial reporting plus restaurant
 * configuration) before any transaction opens. The service re-checks the same
 * grants, the branch and the vertical inside its transaction.
 */
async function requireGrowthWrite(ctx: TRPCContext) {
  const growth = actor(ctx);
  if (!(await growth.can('reports:financial')) || !(await growth.can('restaurant:configure'))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission to generate or review growth insights.',
    });
  }
}
/** Coordinator owns central registration and accepted shared binding. */
export function createRestaurantGrowthRouter(binding: RestaurantGrowthBinding | null = null) {
  return router({
    list: auditedProtectedProcedure
      .input(growthListInput)
      .query(({ ctx, input }) => listRestaurantGrowth(actor(ctx), input)),
    generate: auditedProtectedProcedure
      .input(growthGenerateInput)
      .mutation(async ({ ctx, input }) => {
        await requireGrowthWrite(ctx);
        try {
          return await generateRestaurantGrowth(actor(ctx), input);
        } catch (error) {
          throw new TRPCError({
            code:
              error instanceof GrowthReviewError && error.code === 'DENIED'
                ? 'FORBIDDEN'
                : 'BAD_REQUEST',
            message:
              'Insight could not be saved. Reconcile the same request before trying another.',
          });
        }
      }),
    read: auditedProtectedProcedure
      .input(growthReadInput)
      .query(({ ctx, input }) =>
        readRestaurantGrowthReview(
          actor(ctx),
          input,
          binding ?? restaurantGrowthBinding(actor(ctx))
        )
      ),
    review: auditedProtectedProcedure.input(growthReviewInput).mutation(async ({ ctx, input }) => {
      await requireGrowthWrite(ctx);
      try {
        await reviewRestaurantGrowth(
          actor(ctx),
          input,
          binding ?? restaurantGrowthBinding(actor(ctx))
        );
        return await readRestaurantGrowthReview(
          actor(ctx),
          { branchId: input.branchId, insightId: input.insightId },
          binding ?? restaurantGrowthBinding(actor(ctx))
        );
      } catch (error) {
        throw new TRPCError({
          code:
            error instanceof GrowthReviewError && error.code === 'DENIED'
              ? 'FORBIDDEN'
              : error instanceof GrowthReviewError && ['CONFLICT', 'STALE'].includes(error.code)
                ? 'CONFLICT'
                : 'BAD_REQUEST',
          message:
            'Review could not be completed. Reload the saved result before another decision.',
        });
      }
    }),
  });
}
export const restaurantGrowthRouter = createRestaurantGrowthRouter();
