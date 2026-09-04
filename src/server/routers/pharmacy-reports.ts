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
import { nextDigestDueAt, WhatsAppChannel } from '@/lib/pharmacy/owner-digest';
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
const digestSetting = z
  .object({
    branchId: z.string().trim().min(1).max(128),
    enabled: z.boolean(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
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

async function requireFinancialReports(ctx: TRPCContext) {
  const allowed = await can(subjectFromSession(ctx.session!.user), 'reports:financial', undefined, {
    db: ctx.db,
    source: 'TRPC',
    ip: ctx.requestMeta.ip,
  });
  if (!allowed)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
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
              cashMinor: null,
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
  digestOverview: reports.query(async ({ ctx }) => {
    await requireFinancialReports(ctx);
    const available = await scope(ctx);
    if (ctx.session!.user.role !== 'ADMIN')
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access is required.' });
    const [settings, history] = await Promise.all([
      ctx.db.pharmacyOwnerDigestSetting.findMany({
        where: { userId: ctx.session!.user.id },
        orderBy: { branch: { name: 'asc' } },
        select: {
          branchId: true,
          enabled: true,
          timeMinutes: true,
          nextDueAt: true,
          branch: { select: { name: true } },
        },
      }),
      ctx.db.pharmacyOwnerDigestCapture.findMany({
        where: { userId: ctx.session!.user.id },
        orderBy: { capturedAt: 'desc' },
        take: 30,
        select: {
          id: true,
          branchId: true,
          businessDate: true,
          rendered: true,
          capturedAt: true,
          branch: { select: { name: true } },
        },
      }),
    ]);
    return {
      branches: available.branches,
      settings,
      history,
      channels: {
        capture: { enabled: true },
        whatsapp: { enabled: false, configured: new WhatsAppChannel().configured },
      },
    };
  }),
  updateDigestSetting: reports.input(digestSetting).mutation(async ({ ctx, input }) => {
    await requireFinancialReports(ctx);
    const available = await scope(ctx);
    if (ctx.session!.user.role !== 'ADMIN')
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access is required.' });
    if (!available.branches.some((branch) => branch.id === input.branchId))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
    const [hours, minutes] = input.time.split(':').map(Number);
    const timeMinutes = hours * 60 + minutes;
    const organization = await ctx.db.organization.findUnique({
      where: { id: available.organizationId },
      select: { timezone: true },
    });
    if (!organization) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
    return ctx.db.pharmacyOwnerDigestSetting.upsert({
      where: {
        organizationId_userId_branchId: {
          organizationId: available.organizationId,
          userId: ctx.session!.user.id,
          branchId: input.branchId,
        },
      },
      update: {
        enabled: input.enabled,
        timeMinutes,
        nextDueAt: input.enabled
          ? nextDigestDueAt(new Date(), organization.timezone, timeMinutes)
          : null,
      },
      create: {
        organizationId: available.organizationId,
        userId: ctx.session!.user.id,
        branchId: input.branchId,
        enabled: input.enabled,
        timeMinutes,
        nextDueAt: input.enabled
          ? nextDigestDueAt(new Date(), organization.timezone, timeMinutes)
          : null,
      },
      select: { branchId: true, enabled: true, timeMinutes: true, nextDueAt: true },
    });
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
