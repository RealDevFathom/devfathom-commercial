import { readRepeatPurchasing, validateRepeatFilters } from '@/lib/pharmacy/repeat-purchasing';
import {
  readPharmacyMarketingReport,
  validateMarketingReportFilters,
} from '@/lib/pharmacy/marketing-report';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  pharmacyReplenishmentReportInput,
  readPharmacyReplenishmentReport,
  validatePharmacyReplenishmentReportInput,
} from '@/lib/pharmacy/replenishment-report';

import { hasModule } from '@/lib/entitlements';
import { can, subjectFromSession } from '@/lib/abac';
import {
  readPharmacyDailyWorkPack,
  validateDailyWorkPackInput,
} from '@/lib/pharmacy/daily-work-pack';
import {
  PHARMACY_WIDGET_KEYS,
  pharmacyDashboardDefault,
  type PharmacyDashboardPreference,
} from '@/lib/pharmacy/dashboard';
import {
  PHARMACY_METRIC_CONTRACT,
  MAX_PHARMACY_REPORT_DAYS,
  pharmacyReportCatalog,
  readPharmacyOwnerCommandCentre,
  validatePharmacyReportFilters,
} from '@/lib/pharmacy/reports';
import { nextDigestDueAt, WhatsAppChannel } from '@/lib/pharmacy/owner-digest';
import {
  acknowledgePharmacyAnomalySignal,
  readPharmacyAnomalySignals,
  refreshPharmacyAnomalySignals,
  snoozePharmacyAnomalySignal,
} from '@/lib/pharmacy/anomaly-signals-operations';
import { proposeExpiryReturn, readExpiryAdvice } from '@/lib/pharmacy/expiry-advisor-operations';
import {
  acknowledgePackAuthenticationFlag,
  readPackAuthenticationFlags,
} from '@/lib/pharmacy/pack-authentication-operations';
import { readPharmacyBranchComparison } from '@/lib/pharmacy/branch-comparison';
import {
  PHARMACY_REPORT_EXPORTS,
  branchComparisonCsv,
  expiryAdviceCsv,
  periodSummaryCsv,
  type ReportCsvContext,
} from '@/lib/pharmacy/report-csv';
import { annotateAudit } from '../audit';
import { auditedProtectedProcedure, capabilityProcedure, router, type TRPCContext } from '../trpc';
import {
  PHARMACY_GROWTH_CATEGORIES,
  readPharmacyCategoryGrowthReport,
} from '@/lib/pharmacy/category-growth-report';

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
const pvKind = z.enum(['ADVERSE_DRUG_REACTION', 'MEDICATION_ERROR', 'PRODUCT_QUALITY_COMPLAINT']);
const pvState = z.enum(['DRAFT', 'UNDER_REVIEW', 'READY', 'SUBMITTED', 'CLOSED']);
const externalState = z.enum(['NOT_SUBMITTED', 'PENDING', 'SUBMITTED', 'FAILED']);
const transitions: Record<z.infer<typeof pvState>, readonly z.infer<typeof pvState>[]> = {
  DRAFT: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['DRAFT', 'READY'],
  READY: ['UNDER_REVIEW', 'SUBMITTED', 'CLOSED'],
  SUBMITTED: ['CLOSED'],
  CLOSED: [],
};
const externalTransitions: Record<
  z.infer<typeof externalState>,
  readonly z.infer<typeof externalState>[]
> = {
  NOT_SUBMITTED: ['PENDING', 'SUBMITTED', 'FAILED'],
  PENDING: ['SUBMITTED', 'FAILED'],
  SUBMITTED: [],
  FAILED: ['PENDING', 'SUBMITTED'],
};

async function requirePvBranch(ctx: TRPCContext, branchId: string) {
  const organizationId = ctx.entitlements.organizationId;
  const branch = await ctx.db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
  });
  if (!branch) throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  return organizationId;
}
const anomalyDecision = z
  .object({
    branchId: z.string().trim().min(1).max(128),
    signalId: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
const anomalySnooze = anomalyDecision
  .extend({ snoozedUntil: z.iso.datetime({ offset: true }) })
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

async function ownerFilters(ctx: TRPCContext, input: z.infer<typeof filters>) {
  await requireFinancialReports(ctx);
  const available = await scope(ctx);
  if (ctx.session!.user.role !== 'ADMIN')
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access is required.' });
  const branchIds = input.branchId
    ? [input.branchId]
    : available.branches.map((branch) => branch.id);
  if (
    !branchIds.length ||
    branchIds.some((id) => !available.branches.some((branch) => branch.id === id))
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
  return { ...input, branchIds };
}

const isoDate = (input: string) => {
  const parsed = new Date(`${input}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === input;
};
const reportExport = z
  .object({
    report: z.enum(PHARMACY_REPORT_EXPORTS),
    branchId: z.string().trim().min(1).max(128).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

/** Same currency rule as the Reports screen: the authenticated tenant's own setting only. */
function reportCurrency(ctx: TRPCContext) {
  const organizationCurrency =
    ctx.organization?.id === ctx.entitlements.organizationId ? ctx.organization?.currency : null;
  return organizationCurrency && /^[A-Z]{3}$/.test(organizationCurrency)
    ? organizationCurrency
    : null;
}

async function requireOwnerBranch(ctx: TRPCContext, branchId: string) {
  const available = await scope(ctx);
  if (ctx.session!.user.role !== 'ADMIN')
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access is required.' });
  if (!available.branches.some((branch) => branch.id === branchId))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
}

export const pharmacyReportsRouter = router({
  categoryGrowth: reports
    .input(
      filters
        .pick({ branchId: true, from: true, to: true })
        .extend({
          configuration: z
            .array(
              z
                .object({
                  category: z.enum(PHARMACY_GROWTH_CATEGORIES),
                  displaySpaceSquareMetres: z.number().positive().nullable(),
                  targetSalesSharePercent: z.number().min(0).max(100).nullable(),
                })
                .strict()
            )
            .max(PHARMACY_GROWTH_CATEGORIES.length),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scoped = await ownerFilters(ctx, input);
      let period: ReturnType<typeof validatePharmacyReportFilters>;
      try {
        period = validatePharmacyReportFilters(scoped);
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid category growth report dates.',
        });
      }
      return readPharmacyCategoryGrowthReport(ctx.db, ctx.entitlements.organizationId, {
        branchIds: scoped.branchIds,
        from: input.from,
        // Public report filters are inclusive; the evidence reader uses an exclusive cutoff.
        to: period.to.toISOString().slice(0, 10),
        configuration: input.configuration,
      });
    }),
  marketing: reports
    .input(filters.pick({ branchId: true, from: true, to: true }))
    .query(async ({ ctx, input }) => {
      const scoped = await ownerFilters(ctx, input);
      try {
        validateMarketingReportFilters(scoped);
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid marketing report dates.',
        });
      }
      return readPharmacyMarketingReport(ctx.db, ctx.entitlements.organizationId, scoped);
    }),
  createPharmacovigilanceReport: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId: z.string().min(1),
          kind: pvKind,
          occurredAt: z.date(),
          assertedDescription: z.string().trim().min(1).max(10000),
          patientId: z.string().min(1).optional(),
          medicineId: z.string().min(1).optional(),
          inventoryLotId: z.string().min(1).optional(),
          prescriberId: z.string().min(1).optional(),
        })
        .strict()
        .refine((value) => !value.inventoryLotId || value.medicineId, {
          message: 'A lot reference requires its medicine reference.',
          path: ['medicineId'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = await requirePvBranch(ctx, input.branchId);
      if (input.inventoryLotId) {
        const lot = await ctx.db.pharmacyInventoryLot.findFirst({
          where: {
            id: input.inventoryLotId,
            branchId: input.branchId,
            organizationId,
            batch: { medicineId: input.medicineId },
          },
          select: { id: true },
        });
        if (!lot)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Inventory lot does not match this branch and medicine.',
          });
      }
      ctx.audit.detail = {
        category: 'PHARMACY_SAFETY',
        action: 'human_asserted_report_capture',
        skipInput: true,
      };
      return ctx.db.pharmacyPharmacovigilanceReport.create({
        data: { ...input, organizationId, createdByUserId: ctx.session.user.id },
      });
    }),
  transitionPharmacovigilanceReport: auditedProtectedProcedure
    .input(
      z.object({ id: z.string().min(1), branchId: z.string().min(1), state: pvState }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = await requirePvBranch(ctx, input.branchId);
      const report = await ctx.db.pharmacyPharmacovigilanceReport.findFirst({
        where: { id: input.id, branchId: input.branchId, organizationId },
      });
      if (!report) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found.' });
      if (!transitions[report.state].includes(input.state))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid report lifecycle transition.',
        });
      if (report.externalSubmissionState === 'SUBMITTED' && input.state === 'UNDER_REVIEW')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A submitted report cannot return to review.',
        });
      const [updated] = await ctx.db.pharmacyPharmacovigilanceReport.updateManyAndReturn({
        where: {
          id: report.id,
          branchId: input.branchId,
          organizationId,
          state: report.state,
          externalSubmissionState: report.externalSubmissionState,
        },
        data: { state: input.state, reviewedByUserId: ctx.session.user.id },
      });
      if (!updated)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Report lifecycle changed; refresh and try again.',
        });
      return updated;
    }),
  recordPharmacovigilanceSubmission: auditedProtectedProcedure
    .input(
      z
        .object({
          id: z.string().min(1),
          branchId: z.string().min(1),
          state: externalState,
          externalReference: z.string().trim().min(1).optional(),
          failureReason: z.string().trim().min(1).optional(),
        })
        .strict()
        .superRefine((value, issue) => {
          if (value.state === 'SUBMITTED' && !value.externalReference)
            issue.addIssue({
              code: 'custom',
              path: ['externalReference'],
              message: 'External reference is required.',
            });
          if (value.state === 'FAILED' && !value.failureReason)
            issue.addIssue({
              code: 'custom',
              path: ['failureReason'],
              message: 'Failure reason is required.',
            });
        })
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = await requirePvBranch(ctx, input.branchId);
      const report = await ctx.db.pharmacyPharmacovigilanceReport.findFirst({
        where: { id: input.id, branchId: input.branchId, organizationId },
      });
      if (!report) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found.' });
      if (!['READY', 'SUBMITTED'].includes(report.state))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Report must be ready before recording a submission.',
        });
      const isIdempotent =
        report.externalSubmissionState === input.state &&
        report.externalReference ===
          (input.state === 'SUBMITTED' ? input.externalReference : null) &&
        report.externalFailureReason === (input.state === 'FAILED' ? input.failureReason : null);
      if (isIdempotent) return report;
      if (!externalTransitions[report.externalSubmissionState].includes(input.state))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid external submission transition.',
        });
      const [updated] = await ctx.db.pharmacyPharmacovigilanceReport.updateManyAndReturn({
        where: {
          id: report.id,
          branchId: input.branchId,
          organizationId,
          state: report.state,
          externalSubmissionState: report.externalSubmissionState,
        },
        data: {
          externalSubmissionState: input.state,
          externalReference: input.state === 'SUBMITTED' ? input.externalReference : null,
          externalFailureReason: input.state === 'FAILED' ? input.failureReason : null,
        },
      });
      if (!updated)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Submission state changed; refresh and try again.',
        });
      return updated;
    }),
  exportPharmacovigilanceDrap: auditedProtectedProcedure
    .input(
      z
        .object({ branchId: z.string().min(1), from: z.date(), to: z.date() })
        .strict()
        .refine((v) => v.to >= v.from, { message: 'Invalid date range.' })
    )
    .query(async ({ ctx, input }) => {
      const organizationId = await requirePvBranch(ctx, input.branchId);
      ctx.audit.detail = { category: 'PHARMACY_SAFETY', action: 'drap_export', skipInput: true };
      const reports = await ctx.db.pharmacyPharmacovigilanceReport.findMany({
        where: {
          organizationId,
          branchId: input.branchId,
          occurredAt: { gte: input.from, lte: input.to },
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        include: {
          patient: true,
          medicine: true,
          lot: { include: { batch: true } },
          prescriber: true,
        },
      });
      return {
        format: 'DRAP_PHARMACOVIGILANCE_V1' as const,
        from: input.from,
        to: input.to,
        reports: reports.map((report) => ({
          ...report,
          reportState: report.state,
          externalSubmissionState: report.externalSubmissionState,
        })),
      };
    }),
  branches: reports.query(({ ctx }) => scope(ctx)),
  replenishment: reports.input(pharmacyReplenishmentReportInput).query(async ({ ctx, input }) => {
    // Existing capability middleware denies before report reads; scope enforces licensing.
    const available = await scope(ctx);
    if (!available.branches.some((branch) => branch.id === input.branchId))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
    const financial =
      ctx.session!.user.role === 'ADMIN' &&
      (await can(subjectFromSession(ctx.session!.user), 'reports:financial', undefined, {
        db: ctx.db,
        source: 'TRPC',
        ip: ctx.requestMeta.ip,
      }));
    const readAt = new Date();
    try {
      validatePharmacyReplenishmentReportInput(input, readAt);
    } catch {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid replenishment report inputs.' });
    }
    try {
      return await readPharmacyReplenishmentReport(
        ctx.db,
        {
          ...input,
          organizationId: available.organizationId,
          authorizedBranchIds: available.branches.map((branch) => branch.id),
          financial,
        },
        readAt
      );
    } catch {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Replenishment evidence is unavailable for this scope or scenario.',
      });
    }
  }),
  dailyWorkPack: reports
    .input(
      filters
        .pick({ branchId: true, from: true, to: true })
        .extend({ asOf: z.iso.datetime({ offset: true }) })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const available = await scope(ctx);
      const branchIds = input.branchId
        ? [input.branchId]
        : available.branches.map((branch) => branch.id);
      if (
        !branchIds.length ||
        branchIds.some((id) => !available.branches.some((branch) => branch.id === id))
      )
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
      // Preserve the existing owner gate on anomaly/expiry financial sources.
      const financial =
        ctx.session!.user.role === 'ADMIN' &&
        (await can(subjectFromSession(ctx.session!.user), 'reports:financial', undefined, {
          db: ctx.db,
          source: 'TRPC',
          ip: ctx.requestMeta.ip,
        }));
      const resolved = {
        ...input,
        branchIds,
        organizationId: available.organizationId,
        actorId: ctx.session!.user.id,
        financial,
      };
      const readAt = new Date();
      try {
        validateDailyWorkPackInput(resolved, readAt);
      } catch {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid report period or as-of time.',
        });
      }
      return readPharmacyDailyWorkPack(ctx.db, resolved, readAt);
    }),
  catalog: reports.query(async ({ ctx }) => ({
    reports: pharmacyReportCatalog(),
    metrics: PHARMACY_METRIC_CONTRACT,
    permissions: {
      operational: true,
      owner: ctx.session!.user.role === 'ADMIN',
      financial: await can(subjectFromSession(ctx.session!.user), 'reports:financial', undefined, {
        db: ctx.db,
      }),
    },
  })),
  branchComparison: reports
    .input(
      z
        .object({ from: z.iso.date(), to: z.iso.date() })
        .strict()
        .refine((input) => input.from <= input.to, {
          message: 'The report start date must not be after the end date.',
        })
        .refine(
          (input) =>
            (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000 + 1 <=
            MAX_PHARMACY_REPORT_DAYS,
          {
            message: `Interactive pharmacy reports are limited to ${MAX_PHARMACY_REPORT_DAYS} days.`,
          }
        )
    )
    .query(async ({ ctx, input }) => {
      await requireFinancialReports(ctx);
      if (ctx.session!.user.role !== 'ADMIN')
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access is required.' });
      const available = await scope(ctx);
      // The RSC tenant facade otherwise gives each statement its own transaction, losing
      // the transaction-local branch context before the khata ledger is read.
      return ctx.db.$transaction((tx) =>
        readPharmacyBranchComparison(tx as typeof ctx.db, {
          branches: available.branches,
          from: input.from,
          to: input.to,
        })
      );
    }),
  /**
   * CSV of a Reports screen table for the current filters. reports:financial is enforced here,
   * not only by the hidden button; every attempt (allowed or denied) is audited.
   */
  exportCsv: reports.input(reportExport).query(async ({ ctx, input }) => {
    annotateAudit(ctx, {
      category: 'PHARMACY',
      operation: 'READ',
      action: 'report_csv_export',
      description: `Pharmacy ${input.report} report CSV export`,
      targetType: 'PharmacyReport',
      targetId: input.report,
      metadata: {
        report: input.report,
        from: input.from,
        to: input.to,
        branchId: input.branchId ?? null,
      },
    });
    await requireFinancialReports(ctx);
    if (!isoDate(input.from) || !isoDate(input.to) || input.from > input.to)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid report period.' });
    if (
      (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000 + 1 >
      MAX_PHARMACY_REPORT_DAYS
    )
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Interactive pharmacy reports are limited to ${MAX_PHARMACY_REPORT_DAYS} days.`,
      });
    const available = await scope(ctx);
    const branchScope = input.branchId
      ? (available.branches.find((branch) => branch.id === input.branchId)?.name ?? input.branchId)
      : 'All available branches';
    const generatedAt = new Date();
    const base = {
      currency: reportCurrency(ctx),
      from: input.from,
      to: input.to,
      generatedAt,
    } satisfies Omit<ReportCsvContext, 'branchScope'>;
    let content: string;
    let branchIds: string[];
    let rowCount: number | null;
    if (input.report === 'period-summary') {
      branchIds = input.branchId
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
      let result: Awaited<ReturnType<typeof readPharmacyOwnerCommandCentre>>;
      try {
        result = await readPharmacyOwnerCommandCentre(ctx.db, {
          ...(input.branchId ? { branchId: input.branchId } : {}),
          from: input.from,
          to: input.to,
          branchIds,
        });
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid report filters.',
        });
      }
      content = periodSummaryCsv(result.metrics, {
        ...base,
        branchScope,
        branchSelected: !!input.branchId,
      });
      rowCount = null;
    } else if (input.report === 'branch-comparison') {
      // The comparison screen always covers every active branch; a branch filter is not shown.
      if (input.branchId)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Branch comparison covers all active branches.',
        });
      if (ctx.session!.user.role !== 'ADMIN')
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access is required.' });
      branchIds = available.branches.map((branch) => branch.id);
      const comparison = await ctx.db.$transaction((tx) =>
        readPharmacyBranchComparison(tx as typeof ctx.db, {
          branches: available.branches,
          from: input.from,
          to: input.to,
        })
      );
      content = branchComparisonCsv(comparison, { ...base, branchScope: 'All active branches' });
      rowCount = comparison.rows.length;
    } else {
      const bounded = await ownerFilters(ctx, {
        ...(input.branchId ? { branchId: input.branchId } : {}),
        from: input.from,
        to: input.to,
      });
      branchIds = bounded.branchIds;
      const advice = await readExpiryAdvice(ctx.db, branchIds);
      content = expiryAdviceCsv(advice, available.branches, {
        ...base,
        branchScope,
      });
      rowCount = advice.length;
    }
    annotateAudit(ctx, { metadata: { branchIds, rowCount } });
    return {
      filename: `pharmacy-${input.report}-${input.from}-to-${input.to}.csv`,
      contentType: 'text/csv; charset=utf-8',
      content,
    };
  }),
  repeatPurchasing: reports
    .input(
      filters
        .pick({ branchId: true, from: true, to: true })
        .extend({ asOf: z.iso.datetime({ offset: true }) })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scoped = { ...(await ownerFilters(ctx, input)), asOf: input.asOf };
      try {
        validateRepeatFilters(scoped);
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid cohort window.',
        });
      }
      return readRepeatPurchasing(ctx.db, ctx.entitlements.organizationId, scoped);
    }),
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
  anomalySignals: reports.input(filters).query(async ({ ctx, input }) => {
    const bounded = await ownerFilters(ctx, input);
    return readPharmacyAnomalySignals(ctx.db, bounded);
  }),
  expiryAdvice: reports.input(filters).query(async ({ ctx, input }) => {
    const bounded = await ownerFilters(ctx, input);
    return readExpiryAdvice(ctx.db, bounded.branchIds);
  }),
  proposeExpiryReturn: reports
    .input(
      z
        .object({
          branchId: z.string().trim().min(1).max(128),
          lotId: z.string().trim().min(1).max(128),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await requireFinancialReports(ctx);
      await requireOwnerBranch(ctx, input.branchId);
      return proposeExpiryReturn(
        ctx.db,
        {
          organizationId: ctx.entitlements.organizationId,
          branchId: input.branchId,
          actorId: ctx.session!.user.id,
        },
        input.lotId
      );
    }),
  packAuthenticationFlags: reports.input(filters).query(async ({ ctx, input }) => {
    const resolved = await ownerFilters(ctx, input);
    return readPackAuthenticationFlags(ctx.db, resolved.branchIds);
  }),
  acknowledgePackAuthenticationFlag: reports
    .input(anomalyDecision)
    .mutation(async ({ ctx, input }) => {
      await requireFinancialReports(ctx);
      await requireOwnerBranch(ctx, input.branchId);
      await acknowledgePackAuthenticationFlag(ctx.db, {
        organizationId: ctx.entitlements.organizationId,
        branchId: input.branchId,
        scanId: input.signalId,
        actorId: ctx.session!.user.id,
        reason: input.reason,
      });
      return { acknowledged: true };
    }),
  refreshAnomalies: reports.input(filters).mutation(async ({ ctx, input }) => {
    const bounded = await ownerFilters(ctx, input);
    return refreshPharmacyAnomalySignals(ctx.db, bounded, ctx.session!.user.id);
  }),
  acknowledgeAnomaly: reports.input(anomalyDecision).mutation(async ({ ctx, input }) => {
    await requireFinancialReports(ctx);
    await requireOwnerBranch(ctx, input.branchId);
    return acknowledgePharmacyAnomalySignal(ctx.db, {
      ...input,
      actorId: ctx.session!.user.id,
    });
  }),
  snoozeAnomaly: reports.input(anomalySnooze).mutation(async ({ ctx, input }) => {
    await requireFinancialReports(ctx);
    await requireOwnerBranch(ctx, input.branchId);
    return snoozePharmacyAnomalySignal(ctx.db, {
      ...input,
      actorId: ctx.session!.user.id,
      snoozedUntil: new Date(input.snoozedUntil),
    });
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
