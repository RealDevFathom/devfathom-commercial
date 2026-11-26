import { readRepeatPurchasing, validateRepeatFilters } from '@/lib/pharmacy/repeat-purchasing';
import {
  readPharmacyMarketingReport,
  validateMarketingReportFilters,
} from '@/lib/pharmacy/marketing-report';
import { readLostSalesRecovery } from '@/lib/pharmacy/lost-sales-recovery-report';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  pharmacyReplenishmentReportInput,
  readPharmacyReplenishmentReport,
  validatePharmacyReplenishmentReportInput,
} from '@/lib/pharmacy/replenishment-report';

import { assignedRegisterBranchIds } from '@/lib/pharmacy/controlled-register';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
} from '@/lib/restaurant/operator-credentials';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
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
  deleteSeasonalWindow,
  listSeasonalWindows,
  readSaltDemandSpikes,
  saltSpikeInput,
  saveSeasonalWindow,
  seasonalWindowInput,
} from '@/lib/pharmacy/seasonal-calendar-operations';
import {
  DEFAULT_STAFFING_CONFIG,
  readStaffingSuggestions,
  STAFFING_LIMITS,
  StaffingSuggestionError,
} from '@/lib/pharmacy/staffing-suggestions';
import { auditedProtectedProcedure, capabilityProcedure, router, type TRPCContext } from '../trpc';
import { managerBranchIds } from '../pharmacy-manager-branches';
import {
  pharmacyBranchDayEndsField,
  pharmacyDayEndField,
  withClientPharmacyDayEnd,
  type PharmacyDayEndChange,
} from '@/lib/pharmacy/business-day';

import {
  PHARMACY_GROWTH_CATEGORIES,
  readPharmacyCategoryGrowthReport,
} from '@/lib/pharmacy/category-growth-report';

const reports = capabilityProcedure('reports:operational');

/**
 * DEV-505: who may read the operational reports, and over which branches.
 * `reports:operational` keeps its organization-wide reach (Owner, Owner /
 * Operator, Auditor). A Manager (`pharmacy:manage`) reads the same operational
 * reports for the active branches they are assigned to and no others, unless
 * `reports:operational` is explicitly denied to them. The Manager template does
 * not carry `reports:operational` itself, so this never widens the finance,
 * accounts or digest surfaces that grant reaches organization-wide.
 */
export async function pharmacyReportAccess(ctx: TRPCContext): Promise<'ALL' | string[]> {
  const user = ctx.session?.user;
  if (!user?.id) return [];
  if (
    await can(subjectFromSession(user), 'reports:operational', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    })
  )
    return 'ALL';
  return managerBranchIds(ctx, 'reports:operational');
}

/** Operational reports a Manager may also run, narrowed to their branches. */
const branchReports = auditedProtectedProcedure.use(async ({ ctx, next }) => {
  const reportBranches = await pharmacyReportAccess(ctx);
  if (reportBranches !== 'ALL' && !reportBranches.length)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  return next({ ctx: { ...ctx, reportBranches } });
});

/** `scope` narrowed to the branches this report reader may see. */
async function reportScope(ctx: TRPCContext, reportBranches: 'ALL' | string[]) {
  const available = await scope(ctx);
  if (reportBranches === 'ALL') return available;
  return {
    ...available,
    branches: available.branches.filter((branch) => reportBranches.includes(branch.id)),
  };
}
const safety = capabilityProcedure('pharmacy:safety');
// Product decision (#479): clinical dispensing staff may FILE adverse-reaction and
// medication-error reports, but review, readiness, submission and export stay with
// exact `pharmacy:safety` holders. Both actions are exact-grant-only in can().
const PV_FILING_ACTIONS = ['pharmacy:safety', 'pharmacy:dispense'] as const;

async function requirePvFiling(ctx: TRPCContext) {
  const subject = subjectFromSession(ctx.session!.user);
  const env = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
  for (const action of PV_FILING_ACTIONS) {
    if (await can(subject, action, undefined, env)) return;
  }
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'You do not have permission for this action.',
  });
}
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
  if (!hasModule(ctx.entitlements, 'pharmacy-reports'))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Pharmacy reports are not licensed.' });
  const organizationId = ctx.entitlements.organizationId;
  const assigned = await assignedRegisterBranchIds(ctx.db, organizationId, ctx.session!.user.id);
  if (!assigned.includes(branchId))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your pharmacy scope.' });
  const branch = await ctx.db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
  });
  if (!branch) throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  return organizationId;
}
/**
 * #1244: the pharmacovigilance table's FORCE RLS policy admits only rows of the branch bound in
 * `app.current_branch_id`, with no fallback. Bind the already-authorized branch inside the
 * caller's transaction before any report read or write, or every insert fails and every read
 * is empty.
 */
async function bindPvBranch(db: ScopedDb, branchId: string) {
  await db.$executeRaw`SELECT set_config('app.current_branch_id', ${branchId}, true)`;
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
    // DEV-958A: each branch's day-end history, which bounds its report days. Only the days and
    // hours leave the server: never who made a change, or when.
    select: { id: true, name: true, businessDayEndsAtHistory: true },
  });
  return { branches: branches.map(withClientPharmacyDayEnd), organizationId };
}

/**
 * DEV-958A: each chosen branch's own day-end history, for a report across branches to read
 * every branch on its own business days (their sum). Only branches not on midnight are
 * listed, and none at all when every branch is, so default reads pass what they always did.
 */
function reportDayEnds(
  available: { branches: { id: string; businessDayEndsAtHistory?: unknown }[] },
  branchIds: readonly string[]
): { dayEnds?: Record<string, PharmacyDayEndChange[]> } {
  return pharmacyBranchDayEndsField(
    available.branches
      .filter((branch) => branchIds.includes(branch.id))
      .map((branch) => ({ id: branch.id, dayEnd: branch.businessDayEndsAtHistory }))
  );
}

/** DEV-958A: one chosen branch's own day-end history. */
function branchDayEnd(
  available: { branches: { id: string; businessDayEndsAtHistory?: unknown }[] },
  branchId: string
): unknown {
  return available.branches.find((branch) => branch.id === branchId)?.businessDayEndsAtHistory;
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
  return { ...input, branchIds, ...reportDayEnds(available, branchIds) };
}

/** The supplier, ingredient and batch filters a reader must apply (DEV-256); unset ones omitted. */
function reportDimensions(input: z.infer<typeof filters>) {
  return {
    ...(input.supplierId ? { supplierId: input.supplierId } : {}),
    ...(input.ingredientId ? { ingredientId: input.ingredientId } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
  };
}

async function requireOwnerBranch(ctx: TRPCContext, branchId: string) {
  const available = await scope(ctx);
  if (ctx.session!.user.role !== 'ADMIN')
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access is required.' });
  if (!available.branches.some((branch) => branch.id === branchId))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
}

async function requireReportBranch(ctx: TRPCContext, branchId: string) {
  const available = await scope(ctx);
  if (!available.branches.some((branch) => branch.id === branchId))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
  return { organizationId: available.organizationId, branchId };
}

function badRequest(error: unknown, fallback: string): never {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: error instanceof RangeError ? error.message : fallback,
  });
}

const seasonalBranch = z.object({ branchId: z.string().trim().min(1).max(128) }).strict();

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
        // The caller's own organisation's days, as the other pharmacy reports read them.
        timeZone: ctx.organization?.timezone,
        ...(scoped.dayEnds ? { dayEnds: scoped.dayEnds } : {}),
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
      // DEV-943: the selected dates are the caller organisation's own days.
      return readPharmacyMarketingReport(
        ctx.db,
        ctx.entitlements.organizationId,
        scoped,
        ctx.organization?.timezone
      );
    }),
  /** DEV-79: estimated lost, recovered and net demand value by branch, salt and distributor. */
  lostSalesRecovery: reports
    .input(filters.pick({ branchId: true, from: true, to: true }))
    .query(async ({ ctx, input }) => {
      const scoped = await ownerFilters(ctx, input);
      try {
        validateMarketingReportFilters(scoped);
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid report dates.',
        });
      }
      return readLostSalesRecovery(
        ctx.db,
        ctx.entitlements.organizationId,
        scoped,
        ctx.organization?.timezone
      );
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
      await requirePvFiling(ctx);
      const organizationId = await requirePvBranch(ctx, input.branchId);
      return ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        await bindPvBranch(db, input.branchId);
        if (input.inventoryLotId) {
          const lot = await db.pharmacyInventoryLot.findFirst({
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
        return db.pharmacyPharmacovigilanceReport.create({
          data: { ...input, organizationId, createdByUserId: ctx.session.user.id },
        });
      });
    }),
  transitionPharmacovigilanceReport: safety
    .input(
      z
        .object({
          id: z.string().min(1),
          branchId: z.string().min(1),
          state: pvState,
          pin: z
            .string()
            .regex(/^\d{4,8}$/)
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      ctx.audit.detail = { category: 'PHARMACY_SAFETY', action: 'pv_transition', skipInput: true };
      const organizationId = await requirePvBranch(ctx, input.branchId);
      const actorId = ctx.session.user.id;
      return ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        await bindPvBranch(db, input.branchId);
        const report = await db.pharmacyPharmacovigilanceReport.findFirst({
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
        if (input.state === 'READY' && report.createdByUserId === actorId) {
          // Solo is a tenant staffing fact, never inferred from approver availability.
          // Only this path takes the organization lock shared with seat creation.
          await db.$queryRaw`SELECT id FROM organizations WHERE id=${organizationId} FOR UPDATE`;
          const actor = await db.user.findFirst({
            where: { id: actorId, organizationId, status: 'ACTIVE' },
            select: { role: true, organizationRole: { select: { key: true } } },
          });
          const otherStaff = await db.user.count({
            where: { organizationId, id: { not: actorId }, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
          });
          if (
            !actor ||
            (actor.role !== 'ADMIN' &&
              !['owner', 'owner-operator'].includes(actor.organizationRole?.key ?? '')) ||
            otherStaff !== 0
          )
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'A second approver must review this report.',
            });
          ctx.audit.detail.metadata = {
            policy: 'PV:SOLO_OWNER_PIN',
            reportId: report.id,
            actorId,
            reauthenticated: false,
          };
          if (!input.pin) return { blocked: 'Owner PIN reauthentication is required.' };
          await db.$queryRaw`SELECT c.id FROM restaurant_operator_credentials c JOIN restaurant_staff_profiles s ON s.id=c."staffProfileId" AND s."organizationId"=c."organizationId" WHERE c."organizationId"=${organizationId} AND s."userId"=${actorId} AND c.type='PIN' AND c."revokedAt" IS NULL AND c."deviceId" IS NULL FOR UPDATE OF c`;
          const credential = await db.restaurantOperatorCredential.findFirst({
            where: {
              organizationId,
              type: 'PIN',
              revokedAt: null,
              deviceId: null,
              staffProfile: { organizationId, userId: actorId, status: 'ACTIVE' },
            },
          });
          const now = new Date();
          if (!credential || isLockedOut(credential, now))
            return { blocked: 'Owner PIN reauthentication is required.' };
          if (
            !(await verifyApprovalSecret(db, {
              organizationId,
              approverUserId: actorId,
              credentialHash: credential.credentialHash,
              secret: input.pin,
              action: 'pharmacyReports.transitionPharmacovigilanceReport',
              approverRight: 'OWNER',
              requestedById: actorId,
              now,
            }))
          ) {
            await db.restaurantOperatorCredential.update({
              where: { id: credential.id },
              data: registerFailedAttempt(credential, now),
            });
            // Return rather than throw: the request transaction must commit lockout strikes.
            return { blocked: 'Owner PIN reauthentication is required.' };
          }
          await db.restaurantOperatorCredential.update({
            where: { id: credential.id },
            data: clearLockout(),
          });
          ctx.audit.detail.metadata = {
            ...ctx.audit.detail.metadata,
            reauthenticated: true,
            reauthenticatedAt: now.toISOString(),
          };
          // A solo approval must fail closed if its durable evidence cannot be written.
          await db.auditLog.create({
            data: {
              organizationId,
              actorId,
              actorType: 'USER',
              source: 'TRPC',
              category: 'PHARMACY_SAFETY',
              operation: 'UPDATE',
              action: 'pv_solo_owner_approval',
              targetType: 'PharmacyPharmacovigilanceReport',
              targetId: report.id,
              input: '[skipped]',
              metadata: {
                policy: 'PV:SOLO_OWNER_PIN',
                branchId: input.branchId,
                reauthenticatedAt: now.toISOString(),
              },
            },
          });
        }
        // Compare-and-set (#480): a concurrent lifecycle or submission change wins.
        const [updated] = await db.pharmacyPharmacovigilanceReport.updateManyAndReturn({
          where: {
            id: report.id,
            branchId: input.branchId,
            organizationId,
            state: report.state,
            externalSubmissionState: report.externalSubmissionState,
          },
          data: { state: input.state, reviewedByUserId: actorId },
        });
        if (!updated)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Report lifecycle changed; refresh and try again.',
          });
        return updated;
      });
    }),
  recordPharmacovigilanceSubmission: safety
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
      return ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        await bindPvBranch(db, input.branchId);
        const report = await db.pharmacyPharmacovigilanceReport.findFirst({
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
        const [updated] = await db.pharmacyPharmacovigilanceReport.updateManyAndReturn({
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
      });
    }),
  exportPharmacovigilanceDrap: safety
    .input(
      z
        .object({ branchId: z.string().min(1), from: z.date(), to: z.date() })
        .strict()
        .refine((v) => v.to >= v.from, { message: 'Invalid date range.' })
    )
    .query(async ({ ctx, input }) => {
      const organizationId = await requirePvBranch(ctx, input.branchId);
      ctx.audit.detail = { category: 'PHARMACY_SAFETY', action: 'drap_export', skipInput: true };
      const reports = await ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        await bindPvBranch(db, input.branchId);
        return db.pharmacyPharmacovigilanceReport.findMany({
          where: {
            organizationId,
            branchId: input.branchId,
            occurredAt: { gte: input.from, lte: input.to },
          },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          include: {
            // DEV-832: the safety export names the patient and keeps age context;
            // CNIC, phone and address stay behind the audited patient-record read.
            patient: { select: { id: true, displayName: true, dateOfBirth: true } },
            medicine: true,
            lot: { include: { batch: true } },
            prescriber: { select: { id: true, name: true, registrationNumber: true } },
          },
        });
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
  /**
   * DEV-20: every pharmacy dashboard reads this list, so it never refuses a signed-in member
   * of the licensed workspace. Operational-report holders see every active branch; anyone
   * else sees only the active branches they are assigned to (possibly none). A session that
   * does not belong to this organization gets an empty list.
   */
  branches: auditedProtectedProcedure.query(async ({ ctx }) => {
    if (!hasModule(ctx.entitlements, 'pharmacy-reports'))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Pharmacy reports are not licensed.' });
    const organizationId = ctx.entitlements.organizationId;
    const user = ctx.session.user;
    if (!organizationId || !user.id || user.organizationId !== organizationId)
      return { branches: [], organizationId };
    // DEV-505: an operational-report holder reads every branch; a Manager only
    // the branches their reports are scoped to.
    const reportBranches = await pharmacyReportAccess(ctx);
    if (reportBranches === 'ALL' || reportBranches.length) return reportScope(ctx, reportBranches);
    const assigned = await assignedRegisterBranchIds(ctx.db, organizationId, user.id);
    if (!assigned.length) return { branches: [], organizationId };
    const branches = await ctx.db.pharmacyBranch.findMany({
      where: { organizationId, active: true, id: { in: assigned } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, businessDayEndsAtHistory: true },
    });
    return { branches: branches.map(withClientPharmacyDayEnd), organizationId };
  }),
  suppliers: branchReports.query(async ({ ctx }) => {
    const { organizationId } = await scope(ctx);
    return ctx.db.pharmacySupplier.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }),
  replenishment: branchReports
    .input(pharmacyReplenishmentReportInput)
    .query(async ({ ctx, input }) => {
      // Existing capability middleware denies before report reads; scope enforces licensing.
      const available = await reportScope(ctx, ctx.reportBranches);
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
      // The caller's own organisation's days; the screen offers the same days. DEV-958A: each
      // ends at the branch's "day ends at" hour.
      const timeZone = ctx.organization?.timezone;
      const dayEnd = branchDayEnd(available, input.branchId);
      try {
        validatePharmacyReplenishmentReportInput(input, readAt, timeZone, dayEnd);
      } catch {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid replenishment report inputs.',
        });
      }
      try {
        return await readPharmacyReplenishmentReport(
          ctx.db,
          {
            ...input,
            organizationId: available.organizationId,
            authorizedBranchIds: available.branches.map((branch) => branch.id),
            financial,
            timeZone,
            ...pharmacyDayEndField(dayEnd),
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
  seasonalCalendar: reports.input(seasonalBranch).query(async ({ ctx, input }) => {
    const branchScope = await requireReportBranch(ctx, input.branchId);
    return {
      windows: await listSeasonalWindows(ctx.db, branchScope),
      canEdit:
        ctx.session!.user.role === 'ADMIN' &&
        (await can(subjectFromSession(ctx.session!.user), 'reports:financial', undefined, {
          db: ctx.db,
          source: 'TRPC',
          ip: ctx.requestMeta.ip,
        })),
    };
  }),
  // DEV-74: the seasonal calendar is owner-editable per branch; edits are audited by the
  // procedure's mutation audit and recorded with the acting user on the row.
  saveSeasonalWindow: reports.input(seasonalWindowInput).mutation(async ({ ctx, input }) => {
    await requireFinancialReports(ctx);
    await requireOwnerBranch(ctx, input.branchId);
    try {
      return await saveSeasonalWindow(
        ctx.db,
        {
          organizationId: ctx.entitlements.organizationId,
          branchId: input.branchId,
          actorId: ctx.session!.user.id,
        },
        input
      );
    } catch (error) {
      badRequest(error, 'The seasonal window could not be saved.');
    }
  }),
  deleteSeasonalWindow: reports
    .input(seasonalBranch.extend({ id: z.string().trim().min(1).max(128) }).strict())
    .mutation(async ({ ctx, input }) => {
      await requireFinancialReports(ctx);
      await requireOwnerBranch(ctx, input.branchId);
      try {
        await deleteSeasonalWindow(
          ctx.db,
          { organizationId: ctx.entitlements.organizationId, branchId: input.branchId },
          input.id
        );
      } catch (error) {
        badRequest(error, 'The seasonal window could not be removed.');
      }
      return { deleted: true as const };
    }),
  saltSpikes: reports.input(saltSpikeInput).query(async ({ ctx, input }) => {
    const branchScope = await requireReportBranch(ctx, input.branchId);
    try {
      return await readSaltDemandSpikes(ctx.db, branchScope, input);
    } catch (error) {
      badRequest(error, 'Spike detection is unavailable for this period.');
    }
  }),
  dailyWorkPack: branchReports
    .input(
      filters
        .pick({ branchId: true, from: true, to: true })
        .extend({ asOf: z.iso.datetime({ offset: true }) })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const available = await reportScope(ctx, ctx.reportBranches);
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
        timeZone: ctx.organization?.timezone,
        ...reportDayEnds(available, branchIds),
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
  catalog: branchReports.query(async ({ ctx }) => ({
    reports: pharmacyReportCatalog(),
    currency:
      ctx.organization?.id === ctx.entitlements.organizationId
        ? (ctx.organization?.currency ?? null)
        : null,
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
          timeZone: ctx.organization?.timezone,
        })
      );
    }),
  // DEV-14: suggestions only. Reads completed receipts for one in-scope branch; writes nothing.
  staffingSuggestions: reports
    .input(
      z
        .object({
          branchId: z.string().trim().min(1).max(128),
          from: z.iso.date(),
          to: z.iso.date(),
          receiptsPerStaffHour: z
            .number()
            .int()
            .min(STAFFING_LIMITS.receiptsPerStaffHour.min)
            .max(STAFFING_LIMITS.receiptsPerStaffHour.max)
            .default(DEFAULT_STAFFING_CONFIG.receiptsPerStaffHour),
          minimumStaff: z
            .number()
            .int()
            .min(STAFFING_LIMITS.minimumStaff.min)
            .max(STAFFING_LIMITS.minimumStaff.max)
            .default(DEFAULT_STAFFING_CONFIG.minimumStaff),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const available = await scope(ctx);
      if (!available.branches.some((branch) => branch.id === input.branchId))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
      try {
        return await readStaffingSuggestions(ctx.db, available.organizationId, {
          branchId: input.branchId,
          from: input.from,
          to: input.to,
          timeZone: ctx.organization?.timezone,
          ...pharmacyDayEndField(branchDayEnd(available, input.branchId)),
          config: {
            receiptsPerStaffHour: input.receiptsPerStaffHour,
            minimumStaff: input.minimumStaff,
          },
        });
      } catch (error) {
        if (error instanceof StaffingSuggestionError)
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        throw error;
      }
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
        validateRepeatFilters(scoped, new Date(), ctx.organization?.timezone);
      } catch (error) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid cohort window.',
        });
      }
      return readRepeatPurchasing(
        ctx.db,
        ctx.entitlements.organizationId,
        scoped,
        ctx.organization?.timezone
      );
    }),
  commandCentre: branchReports.input(filters).query(async ({ ctx, input }) => {
    const available = await reportScope(ctx, ctx.reportBranches);
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
      // Khata's branch context is transaction-local; keep it and all report reads together.
      const result = await ctx.db.$transaction((tx) =>
        readPharmacyOwnerCommandCentre(tx, {
          ...input,
          branchIds,
          timeZone: ctx.organization?.timezone,
          ...reportDayEnds(available, branchIds),
        })
      );
      const financial = await can(
        subjectFromSession(ctx.session!.user),
        'reports:financial',
        undefined,
        { db: ctx.db }
      );
      const metrics = financial
        ? result.metrics
        : {
            ...result.metrics,
            expiryValueMinor30: null,
            expiryValueMinor60: null,
            expiryValueMinor90: null,
            expiryValueMinor180: null,
            salesMinor: null,
            marginMinor: null,
            cashMinor: null,
            cashVarianceMinor: null,
            refundsMinor: null,
            accountsPayableMinor: null,
            accountsReceivableMinor: null,
            khataAgingMinor: null,
          };
      return {
        ...result,
        permissions: { operational: true, financial },
        // DEV-505: the safety queue is counted across the whole organization, so a
        // branch-scoped reader (a Manager) is not shown other branches' activity.
        metrics: ctx.reportBranches === 'ALL' ? metrics : { ...metrics, safetyQueue: null },
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
    return readPharmacyAnomalySignals(ctx.db, {
      ...bounded,
      timeZone: ctx.organization?.timezone,
    });
  }),
  expiryAdvice: reports.input(filters).query(async ({ ctx, input }) => {
    const bounded = await ownerFilters(ctx, input);
    return readExpiryAdvice(ctx.db, {
      timeZone: ctx.organization?.timezone,
      organizationId: ctx.entitlements.organizationId,
      branchIds: bounded.branchIds,
      ...reportDimensions(input),
    });
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
          timeZone: ctx.organization?.timezone,
          organizationId: ctx.entitlements.organizationId,
          branchId: input.branchId,
          actorId: ctx.session!.user.id,
        },
        input.lotId
      );
    }),
  packAuthenticationFlags: reports.input(filters).query(async ({ ctx, input }) => {
    const resolved = await ownerFilters(ctx, input);
    return readPackAuthenticationFlags(ctx.db, resolved.branchIds, {
      organizationId: ctx.entitlements.organizationId,
      ...reportDimensions(input),
    });
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
    return refreshPharmacyAnomalySignals(
      ctx.db,
      { ...bounded, timeZone: ctx.organization?.timezone },
      ctx.session!.user.id
    );
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
  getPreferences: branchReports.query(async ({ ctx }) => {
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
  updatePreferences: branchReports.input(preference).mutation(async ({ ctx, input }) => {
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
