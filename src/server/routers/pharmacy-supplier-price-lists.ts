import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { annotateAudit } from '../audit';
import { denyByDefaultProcedure, router, type ProcedureMeta, type TRPCContext } from '../trpc';
import { ownerUploadInput } from '@/lib/pharmacy/migration/owner-import-input';
import { OwnerImportError } from '@/lib/pharmacy/migration/owner-import-upload';
import {
  decideSupplierPriceDrafts,
  importSupplierPriceList,
  listSupplierPriceLists,
  supplierPriceListReview,
} from '@/lib/pharmacy/supplier-price-lists';

/**
 * DEV-681 — supplier price lists. Deny by default: importing and reading the
 * alerts is procurement work; turning a draft into a shelf price needs the
 * approver capability (Manager, Owner and the solo owner hold it).
 */
export const PRICE_LIST_PROCUREMENT = {
  capabilities: ['pharmacy:procurement'],
} as const satisfies ProcedureMeta;
export const PRICE_LIST_APPROVAL = {
  capabilities: ['pharmacy:procurement-approve'],
} as const satisfies ProcedureMeta;

function scope(ctx: TRPCContext) {
  const organizationId = ctx.entitlements?.organizationId;
  if (!organizationId || !ctx.session)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant actor on this request.' });
  return { organizationId, actorId: ctx.session.user.id };
}

const id = z.string().min(1).max(128);

export const pharmacySupplierPriceListsRouter = router({
  options: denyByDefaultProcedure.meta(PRICE_LIST_PROCUREMENT).query(async ({ ctx }) => {
    const { organizationId } = scope(ctx);
    const suppliers = await ctx.db.pharmacySupplier.findMany({
      where: { organizationId, active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return { suppliers };
  }),
  list: denyByDefaultProcedure
    .meta(PRICE_LIST_PROCUREMENT)
    .query(({ ctx }) => listSupplierPriceLists(ctx.db, scope(ctx).organizationId)),
  review: denyByDefaultProcedure
    .meta(PRICE_LIST_PROCUREMENT)
    .input(z.object({ priceListId: id }).strict())
    .query(({ ctx, input }) =>
      supplierPriceListReview(ctx.db, scope(ctx).organizationId, input.priceListId)
    ),
  import: denyByDefaultProcedure
    .meta(PRICE_LIST_PROCUREMENT)
    .input(ownerUploadInput.extend({ supplierId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = scope(ctx);
      annotateAudit(ctx, { skipInput: true });
      try {
        return await importSupplierPriceList(ctx.db, actor, {
          supplierId: input.supplierId,
          fileName: input.fileName,
          bytes: Buffer.from(input.content, 'base64'),
        });
      } catch (error) {
        if (error instanceof OwnerImportError)
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        throw error;
      }
    }),
  decide: denyByDefaultProcedure
    .meta(PRICE_LIST_APPROVAL)
    .input(
      z
        .object({
          lineIds: z.array(id).min(1).max(100),
          decision: z.enum(['APPROVE', 'REJECT']),
        })
        .strict()
    )
    .mutation(({ ctx, input }) => decideSupplierPriceDrafts(ctx.db, scope(ctx), input)),
});
