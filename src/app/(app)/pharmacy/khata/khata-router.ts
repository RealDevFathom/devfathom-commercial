import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule } from '@/lib/entitlements';
import { adminProcedure, router, type TRPCContext } from '@/server/trpc';

function ownerScope(ctx: TRPCContext) {
  const organizationId = ctx.session?.user.organizationId;
  if (
    !organizationId ||
    ctx.session?.user.role !== 'ADMIN' ||
    ctx.entitlements.organizationId !== organizationId ||
    ctx.organization?.id !== organizationId ||
    ctx.organization.vertical !== 'PHARMACY' ||
    !hasModule(ctx.entitlements, 'pharmacy-counter')
  ) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  return organizationId;
}

export const pharmacyKhataListRouter = router({
  branches: adminProcedure.query(({ ctx }) => {
    const organizationId = ownerScope(ctx);
    return ctx.db.pharmacyBranch.findMany({
      where: { organizationId, active: true },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }),
  accounts: adminProcedure
    .input(
      z
        .object({
          branchId: z.string().trim().min(1).max(128),
          after: z.string().trim().max(128).default(''),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const organizationId = ownerScope(ctx);
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { id: input.branchId, organizationId, active: true },
        select: { id: true },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND' });
      return ctx.db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT set_config('app.current_branch_id', ${input.branchId}, true)`
        );
        const accounts = await tx.pharmacyFamilyAccount.findMany({
          where: {
            organizationId,
            branchId: input.branchId,
            active: true,
            ...(input.after ? { id: { gt: input.after } } : {}),
          },
          select: {
            id: true,
            displayName: true,
            creditLimitMinor: true,
            payer: { select: { patient: { select: { phone: true } } } },
          },
          orderBy: { id: 'asc' },
          take: 51,
        });
        const page = accounts.slice(0, 50);
        const ids = page.map((account) => account.id);
        const totals = ids.length
          ? await tx.pharmacyKhataEvent.groupBy({
              by: ['familyAccountId', 'kind'],
              where: { organizationId, branchId: input.branchId, familyAccountId: { in: ids } },
              _sum: { amountMinor: true },
            })
          : [];
        const rows = await Promise.all(
          page.map(async (account) => {
            const lastPayment = await tx.pharmacyKhataEvent.findFirst({
              where: {
                organizationId,
                branchId: input.branchId,
                familyAccountId: account.id,
                kind: 'PAYMENT',
              },
              select: { occurredAt: true, amountMinor: true },
              orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            });
            return {
              id: account.id,
              displayName: account.displayName,
              phone: account.payer.patient.phone,
              creditLimitMinor: account.creditLimitMinor,
              balanceMinor: totals
                .filter((row) => row.familyAccountId === account.id)
                .reduce(
                  (sum, row) =>
                    sum + (row.kind === 'PAYMENT' ? -1 : 1) * (row._sum.amountMinor ?? 0),
                  0
                ),
              lastPayment,
            };
          })
        );
        return { rows, next: accounts.length > 50 ? page[page.length - 1]!.id : null };
      });
    }),
});
