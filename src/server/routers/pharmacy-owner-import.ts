import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, router, type TRPCContext } from '../trpc';
import { annotateAudit } from '../audit';
import { ownerImportInput, ownerUploadInput, suggestImportMapping } from '@/lib/pharmacy/migration/owner-import-input';
import { OwnerImportError, parseOwnerUpload } from '@/lib/pharmacy/migration/owner-import-upload';
import { commitOwnerImport, previewOwnerImport } from '@/lib/pharmacy/migration/owner-import';

function actor(ctx: TRPCContext) {
  const organizationId = ctx.entitlements.organizationId;
  if (ctx.session?.user.organizationId !== organizationId ||
      (ctx.organization && ctx.organization.id !== organizationId)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace scope mismatch.' });
  }
  annotateAudit(ctx, { skipInput: true });
  return { organizationId, actorId: ctx.session.user.id };
}

async function readable<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof OwnerImportError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    throw error;
  }
}

export const pharmacyOwnerImportRouter = router({
  options: adminProcedure.query(async ({ ctx }) => {
    const { organizationId } = actor(ctx);
    const branches = await ctx.db.pharmacyBranch.findMany({
      where: { organizationId, active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' },
    });
    const locations = await ctx.db.pharmacyStockLocation.findMany({
      where: { organizationId, active: true, branchId: { in: branches.map((branch) => branch.id) } },
      select: { id: true, branchId: true, name: true }, orderBy: { name: 'asc' },
    });
    return { branches, locations };
  }),
  upload: adminProcedure.input(ownerUploadInput).mutation(({ ctx, input }) => readable(async () => {
    actor(ctx);
    const table = await parseOwnerUpload(input.fileName, Buffer.from(input.content, 'base64'));
    return { headers: [...table.headers], sample: table.rows.slice(0, 3).map((row) => [...row]), rowCount: table.rows.length, mapping: suggestImportMapping(table.headers) };
  })),
  preview: adminProcedure.input(ownerImportInput).mutation(({ ctx, input }) => readable(async () => {
    const scope = { ...actor(ctx), branchId: input.branchId };
    const preview = await previewOwnerImport(ctx.db, scope, input);
    annotateAudit(ctx, { metadata: { sourceHash: preview.sourceHash, fileName: input.fileName, branchId: input.branchId, mapping: input.mapping, canCommit: preview.canCommit } });
    return preview;
  })),
  commit: adminProcedure.input(ownerImportInput.extend({ previewHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict())
    .mutation(({ ctx, input }) => readable(async () => {
      const scope = { ...actor(ctx), branchId: input.branchId };
      const result = await commitOwnerImport(ctx.db, scope, input);
      annotateAudit(ctx, {
        targetType: 'PharmacyOpeningSession', targetId: result.sessionId,
        description: 'Owner opening-stock import', result,
        metadata: { fileName: input.fileName, branchId: input.branchId, stockLocationId: input.stockLocationId, mapping: input.mapping, previewHash: input.previewHash },
      });
      return result;
    })),
});
