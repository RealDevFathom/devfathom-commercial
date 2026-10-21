import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, router, type TRPCContext } from '../trpc';
import {
  assertReviewBranch,
  listStagedMedicines,
  reviewBatchInput,
  reviewListInput,
  reviewScopeInput,
  stagedMedicineDetail,
} from '@/lib/pharmacy/migration/staged-review-read';

function organizationId(ctx: TRPCContext): string {
  const id = ctx.session?.user.organizationId;
  if (
    !id ||
    id !== ctx.entitlements.organizationId ||
    (ctx.organization && ctx.organization.id !== id)
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace scope mismatch.' });
  }
  return id;
}

/** Server-page caller only. Nesting preserves the existing pharmacy-core entitlement path. */
export const pharmacyStagedReviewRouter = router({
  pharmacyMedicine: router({
    stagedBranches: adminProcedure.query(({ ctx }) =>
      ctx.db.pharmacyBranch.findMany({
        where: { organizationId: organizationId(ctx), active: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      })
    ),
    stagedBatches: adminProcedure
      .input(reviewScopeInput.extend({ page: z.number().int().min(1).max(10000).default(1) }))
      .query(async ({ ctx, input }) => {
        const org = organizationId(ctx);
        await assertReviewBranch(ctx.db, org, input.branchId);
        const where = { organizationId: org, source: { organizationId: org } };
        const total = await ctx.db.pharmacyMigrationBatch.count({ where });
        const batches = await ctx.db.pharmacyMigrationBatch.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 25,
          skip: (input.page - 1) * 25,
          select: {
            id: true,
            sourceId: true,
            label: true,
            status: true,
            rowCount: true,
            source: { select: { fileName: true, contentHash: true } },
          },
        });
        return { batches, total };
      }),
    stagedRows: adminProcedure
      .input(reviewListInput)
      .query(({ ctx, input }) => listStagedMedicines(ctx.db, organizationId(ctx), input)),
    stagedDetail: adminProcedure
      .input(reviewBatchInput.extend({ rowId: z.string().min(1).max(128) }).strict())
      .query(({ ctx, input }) => stagedMedicineDetail(ctx.db, organizationId(ctx), input)),
  }),
});
