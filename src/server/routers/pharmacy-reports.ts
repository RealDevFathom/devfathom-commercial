import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { hasModule } from '@/lib/entitlements';
import {
  PHARMACY_METRIC_CONTRACT,
  pharmacyReportCatalog,
  readPharmacyOwnerCommandCentre,
} from '@/lib/pharmacy/reports';
import { auditedProtectedProcedure, capabilityProcedure, router, type TRPCContext } from '../trpc';

const reports = capabilityProcedure('reports:operational');
const digestSetting = z
  .object({
    enabled: z.boolean(),
    localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    channel: z.literal('CAPTURE'),
  })
  .strict();

async function assertOwner(ctx: TRPCContext) {
  const userId = ctx.session?.user?.id;
  if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const owner = await ctx.db.user.findFirst({
    where: {
      id: userId,
      organizationId: ctx.entitlements.organizationId,
      organizationRole: { key: 'owner', organizationId: ctx.entitlements.organizationId },
    },
    select: { id: true },
  });
  if (!owner) throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access is required.' });
  return owner.id;
}
const filters = z
  .object({
    branchId: z.string().trim().min(1).max(128).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    supplierId: z.string().trim().min(1).max(128).optional(),
    ingredientId: z.string().trim().min(1).max(128).optional(),
    batchId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

async function scope(ctx: TRPCContext) {
  if (!hasModule(ctx.entitlements, 'pharmacy-reports'))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Pharmacy reports are not licensed.' });
  const organizationId = ctx.entitlements.organizationId;
  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return { branches, organizationId };
}

export const pharmacyReportsRouter = router({
  digest: auditedProtectedProcedure.query(async ({ ctx }) => {
    await assertOwner(ctx);
    const [setting, history] = await Promise.all([
      ctx.db.pharmacyOwnerDigestSetting.findUnique({
        where: { organizationId: ctx.entitlements.organizationId },
      }),
      ctx.db.pharmacyOwnerDigest.findMany({
        where: { organizationId: ctx.entitlements.organizationId },
        orderBy: { createdAt: 'desc' },
        take: 31,
        include: { branch: { select: { name: true } } },
      }),
    ]);
    return { setting, history };
  }),
  updateDigest: auditedProtectedProcedure.input(digestSetting).mutation(async ({ ctx, input }) => {
    const configuredByUserId = await assertOwner(ctx);
    return ctx.db.pharmacyOwnerDigestSetting.upsert({
      where: { organizationId: ctx.entitlements.organizationId },
      create: { organizationId: ctx.entitlements.organizationId, configuredByUserId, ...input },
      update: { configuredByUserId, ...input },
    });
  }),
  branches: reports.query(({ ctx }) => scope(ctx)),
  catalog: reports.query(() => ({
    reports: pharmacyReportCatalog(),
    metrics: PHARMACY_METRIC_CONTRACT,
  })),
  commandCentre: reports.input(filters).query(async ({ ctx, input }) => {
    const available = await scope(ctx);
    const branchIds = input.branchId
      ? [input.branchId]
      : available.branches.map((branch) => branch.id);
    if (
      !branchIds.length ||
      branchIds.some((id) => !available.branches.some((branch) => branch.id === id))
    )
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'One or more branches are outside your report scope.',
      });
    try {
      return await readPharmacyOwnerCommandCentre(ctx.db, { ...input, branchIds });
    } catch (error) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid report filters.',
      });
    }
  }),
});
