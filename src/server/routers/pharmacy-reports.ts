import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { hasModule } from '@/lib/entitlements';
import { can, subjectFromSession } from '@/lib/abac';
import {
  PHARMACY_WIDGET_KEYS,
  pharmacyDashboardDefault,
  type PharmacyDashboardPreference,
} from '@/lib/pharmacy/dashboard';
import {
  PHARMACY_METRIC_CONTRACT,
  pharmacyReportCatalog,
  readPharmacyOwnerCommandCentre,
} from '@/lib/pharmacy/reports';
import { capabilityProcedure, router, type TRPCContext } from '../trpc';

const reports = capabilityProcedure('reports:operational');
const widget = z
  .object({
    key: z.enum(PHARMACY_WIDGET_KEYS),
    visible: z.boolean(),
    span: z.enum(['compact', 'wide']),
  })
  .strict();
const preference = z
  .object({ version: z.literal(1), widgets: z.array(widget).length(PHARMACY_WIDGET_KEYS.length) })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.widgets.map((item) => item.key);
    if (
      new Set(keys).size !== PHARMACY_WIDGET_KEYS.length ||
      PHARMACY_WIDGET_KEYS.some((key) => !keys.includes(key))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['widgets'],
        message: 'Each pharmacy dashboard widget must appear exactly once.',
      });
    }
  });
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
  branches: reports.query(({ ctx }) => scope(ctx)),
  catalog: reports.query(async ({ ctx }) => ({
    reports: pharmacyReportCatalog(),
    metrics: PHARMACY_METRIC_CONTRACT,
    permissions: {
      operational: true,
      financial: await can(subjectFromSession(ctx.session!.user), 'reports:financial', undefined, {
        db: ctx.db,
      }),
    },
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
      const result = await readPharmacyOwnerCommandCentre(ctx.db, { ...input, branchIds });
      const financial = await can(
        subjectFromSession(ctx.session!.user),
        'reports:financial',
        undefined,
        { db: ctx.db }
      );
      return {
        ...result,
        permissions: { operational: true, financial },
        metrics: financial
          ? result.metrics
          : {
              ...result.metrics,
              salesMinor: null,
              marginMinor: null,
              cashVarianceMinor: null,
              refundsMinor: null,
              accountsPayableMinor: null,
              accountsReceivableMinor: null,
              khataAgingMinor: null,
            },
      };
    } catch (error) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid report filters.',
      });
    }
  }),
  getPreferences: reports.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session!.user.id },
      select: { preferences: true },
    });
    const fallback = pharmacyDashboardDefault(ctx.session!.user.role);
    const raw =
      user?.preferences && typeof user.preferences === 'object' && !Array.isArray(user.preferences)
        ? (user.preferences as Record<string, unknown>).pharmacyDashboard
        : undefined;
    const parsed = preference.safeParse(raw);
    return parsed.success ? parsed.data : fallback;
  }),
  updatePreferences: reports.input(preference).mutation(async ({ ctx, input }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session!.user.id },
      select: { preferences: true },
    });
    const base =
      user?.preferences && typeof user.preferences === 'object' && !Array.isArray(user.preferences)
        ? (user.preferences as Record<string, unknown>)
        : {};
    await ctx.db.user.update({
      where: { id: ctx.session!.user.id },
      data: { preferences: { ...base, pharmacyDashboard: input } },
    });
    return input as PharmacyDashboardPreference;
  }),
});
