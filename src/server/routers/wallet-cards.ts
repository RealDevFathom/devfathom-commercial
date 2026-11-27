import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, router, type TRPCContext } from '../trpc';
import { hasModule } from '@/lib/entitlements';
import { refuseSupportSession } from '@/lib/tenancy/support-session-rule';
import { cardDesignInput, saveCardDesign } from '@/lib/wallet/design';
import { walletRuntime } from '@/lib/wallet/modes';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { branchPoster } from '@/lib/wallet/poster';

function business(ctx: TRPCContext) {
  const org = ctx.organization;
  const requiredModule =
    org?.vertical === 'PHARMACY'
      ? 'pharmacy-crm'
      : org?.vertical === 'RESTAURANT'
        ? 'restaurant-loyalty'
        : null;
  if (
    !org ||
    ctx.entitlements.organizationId !== org.id ||
    !requiredModule ||
    !hasModule(ctx.entitlements, requiredModule)
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
  return org;
}
export const walletCardsRouter = router({
  settings: adminProcedure.query(async ({ ctx }) => {
    const org = business(ctx);
    const design = await ctx.db.walletTenantConfig.findUnique({
      where: { organizationId: org.id },
    });
    const branchArgs = {
      where: { organizationId: org.id, active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' as const },
    };
    const branches =
      org.vertical === 'PHARMACY'
        ? await ctx.db.pharmacyBranch.findMany(branchArgs)
        : await ctx.db.restaurantBranch.findMany(branchArgs);
    return {
      design: {
        enabled: design?.enabled ?? false,
        programDisplayName: design?.programDisplayName ?? org.displayName,
        backgroundColor: design?.backgroundColor ?? '#f6f6f3',
        foregroundColor: design?.foregroundColor ?? '#111110',
        logo: design?.logoPng ? Buffer.from(design.logoPng).toString('base64') : null,
      },
      branches,
      mode: walletRuntime().mode,
    };
  }),
  save: adminProcedure
    .meta(refuseSupportSession)
    .input(cardDesignInput)
    .mutation(async ({ ctx, input }) => {
      const org = business(ctx);
      await saveCardDesign(ctx.db, org.id, input);
    }),
  poster: adminProcedure
    .meta(refuseSupportSession)
    .input(z.object({ branchId: z.string().min(1).max(128) }).strict())
    .mutation(({ ctx, input }) => {
      const org = business(ctx);
      return withTenantDb(
        org.id,
        (db) => branchPoster(db, org.id, org.vertical === 'PHARMACY', input.branchId),
        { userId: ctx.session.user.id }
      );
    }),
});
