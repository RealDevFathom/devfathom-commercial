import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule } from '@/lib/entitlements';
import {
  listLoyaltyCustomers,
  readLoyaltyHistory,
  LOYALTY_HISTORY_MAX_PAGE,
  PharmacyLoyaltyError,
  setCustomerPreferredLanguage,
} from '@/lib/pharmacy/customer-loyalty';
import { adminProcedure, router, type TRPCContext } from '@/server/trpc';

function scopeFor(ctx: TRPCContext, branchId = '') {
  const organizationId = ctx.session?.user.organizationId;
  const actorId = ctx.session?.user.id;
  if (
    !organizationId ||
    !actorId ||
    organizationId !== ctx.entitlements.organizationId ||
    (ctx.organization && ctx.organization.id !== organizationId) ||
    !hasModule(ctx.entitlements, 'pharmacy-crm')
  ) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  return { organizationId, actorId, branchId };
}

const branchInput = z.object({ branchId: z.string().trim().min(1).max(128) });
async function historyRead<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PharmacyLoyaltyError)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch or customer unavailable.' });
    throw error;
  }
}

// Server-page caller: no central router mutation. Explicit CRM check also applies
// when composed by core integration; see evidence/handoff-loyalty-20261008.md.
export const pharmacyLoyaltyRouter = router({
  branches: adminProcedure.query(({ ctx }) => {
    const scope = scopeFor(ctx);
    return ctx.db.pharmacyBranch.findMany({
      where: { organizationId: scope.organizationId, active: true },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }),
  customers: adminProcedure
    .input(branchInput.extend({ query: z.string().trim().max(100).default('') }).strict())
    .query(({ ctx, input }) =>
      historyRead(() => listLoyaltyCustomers(ctx.db, scopeFor(ctx, input.branchId), input.query))
    ),
  history: adminProcedure
    .input(
      branchInput
        .extend({
          customerId: z.string().trim().min(1).max(128),
          page: z.number().int().min(1).max(LOYALTY_HISTORY_MAX_PAGE).default(1),
        })
        .strict()
    )
    .query(({ ctx, input }) =>
      historyRead(() =>
        readLoyaltyHistory(ctx.db, scopeFor(ctx, input.branchId), input.customerId, input.page)
      )
    ),
  setPreferredLanguage: adminProcedure
    .input(
      branchInput
        .extend({
          customerId: z.string().trim().min(1).max(128),
          preferredLanguage: z.enum(['en', 'ur']),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      historyRead(() =>
        setCustomerPreferredLanguage(
          ctx.db,
          scopeFor(ctx, input.branchId),
          input.customerId,
          input.preferredLanguage
        )
      )
    ),
});
