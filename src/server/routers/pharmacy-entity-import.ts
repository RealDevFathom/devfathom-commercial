import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { subjectFromSession } from '@/lib/abac';
import type { CreatedEntity } from '@/lib/pharmacy/migration/entity-committers';
import { commitImportBatch, rollbackImportBatch, type EntityImportRepository } from '@/lib/pharmacy/migration/entity-import-service';
import { capabilityProcedure, router, type TRPCContext } from '../trpc';

const input = z.object({
  batchId: z.string().min(1).max(128),
  branchId: z.string().min(1).max(128),
  stockLocationId: z.string().min(1).max(128),
  awardImportedLoyalty: z.boolean().default(false),
}).strict();

export type EntityImportRepositoryFactory = (ctx: TRPCContext) => EntityImportRepository;

/** The outer procedure and service deliberately both authorize: transport bypass cannot bypass ABAC. */
export function createPharmacyEntityImportRouter(repositoryFor: EntityImportRepositoryFactory) {
  const mutation = capabilityProcedure('pharmacy:data-import').input(input);
  const scope = (ctx: TRPCContext) => {
    const user = ctx.session?.user;
    const organizationId = user?.organizationId;
    if (!user?.id || !organizationId || organizationId !== ctx.entitlements.organizationId)
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace scope mismatch.' });
    return { subject: subjectFromSession(user), organizationId };
  };
  return router({
    commit: mutation.mutation(async ({ ctx, input: values }): Promise<CreatedEntity[]> => {
      const authenticated = scope(ctx);
      return commitImportBatch(authenticated.subject, ctx.db, authenticated.organizationId, repositoryFor(ctx), values);
    }),
    rollback: mutation.mutation(async ({ ctx, input: values }): Promise<void> => {
      const authenticated = scope(ctx);
      await rollbackImportBatch(authenticated.subject, ctx.db, authenticated.organizationId, repositoryFor(ctx), values);
    }),
  });
}
