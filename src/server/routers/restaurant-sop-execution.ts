import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { resolveRestaurantActor } from '../restaurant-actor';
import { assertInOrganization } from '../org-refs';
import { router, capabilityProcedure, type TRPCContext } from '../trpc';
import { annotateAudit } from '../audit';
import {
  SopExecutionError,
  startOccurrence,
  completeStep,
  attachEvidence,
  submitOccurrence,
} from '@/lib/restaurant/sop-execution';
import {
  SopVerificationError,
  verifyOccurrence,
  rejectOccurrence,
  waiveOccurrence,
} from '@/lib/restaurant/sop-verification';
import { acknowledgeEscalation } from '@/lib/restaurant/sop-escalation';
import {
  evaluateSopDepth,
  sopDepthDenialMessage,
  type EntitlementSnapshot,
  type SopDepthCapability,
} from '@/lib/module-catalog';
import { summarizeSopReport } from '@/lib/restaurant/sop-reporting';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import { can, subjectFromSession } from '@/lib/abac';

/**
 * M7-L4 — the SOP execution router (branch-board reads + operator/verifier commands).
 *
 * Two capability gates:
 *   `sop:complete`  — operators starting/completing/submitting occurrences
 *   `sop:verify`    — verifiers approving/rejecting/waiving occurrences
 *
 * Both gate on the `restaurant-sop` module (via module-catalog). Tenant scoping
 * is the RLS-forced `organizationId` on every row. All input schemas are `.strict()`
 * — an unknown key is REJECTED.
 *
 * WHA-264 — the module gate above answers "does this organization have SOP at
 * all"; it cannot answer "how deep". Every restaurant package includes
 * `restaurant-sop`, so the DEPTH of each command (bare execution vs. proof,
 * verification, waiver, escalation) is resolved against the module/limit catalog
 * by `assertSopDepth` at the top of each resolver. Authorization (`sop:complete`
 * / `sop:verify`) and entitlement are independent gates and both must pass:
 * a capable manager in an under-entitled organization is still refused, and an
 * entitled organization still needs the capability.
 */

const completeProcedure = capabilityProcedure('sop:complete');
const verifyProcedure = capabilityProcedure('sop:verify');
const reportProcedure = capabilityProcedure('reports:operational');

/**
 * Fail closed on an SOP depth the caller's organization is not entitled to.
 * Reads only `ctx.entitlements`, which `resolveOrganizationEntitlements` builds
 * for the caller's own organization — the depth decision can never be made from
 * another tenant's licensing.
 */
function assertSopDepth(entitlements: EntitlementSnapshot, capability: SopDepthCapability): void {
  const result = evaluateSopDepth(entitlements, capability);
  if (!result.allowed) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: sopDepthDenialMessage(capability, result),
    });
  }
}

function mapExecutionError(err: unknown): never {
  if (err instanceof SopExecutionError) {
    const code =
      err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'NOT_OWNER'
          ? 'FORBIDDEN'
          : err.reason === 'INVALID_STATE' || err.reason === 'STEP_ALREADY_COMPLETED'
            ? 'CONFLICT'
            : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof SopVerificationError) {
    const code =
      err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'INVALID_STATE'
          ? 'CONFLICT'
          : err.reason === 'CO_AUTH_REQUIRED'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

// ── Shared schemas ────────────────────────────────────────────────────────────

const OCCURRENCE_ID = z.string().min(1);
/** Operator PINs are 4-8 digits everywhere (terminal, pharmacy, SOP approvals). */
const APPROVAL_PIN = z
  .string()
  .regex(/^\d{4,8}$/)
  .optional();
const OPTIONAL_ACTOR = z.string().min(1).nullable().optional();
const OPTIONAL_REASON = z.string().max(2_000).nullable().optional();
const REPORT_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      businessDateToUtcDate(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid calendar date.');
const DEPARTMENT = z.enum([
  'LEADERSHIP',
  'ENGINEERING',
  'PRODUCT',
  'QUALITY',
  'MARKETING',
  'DESIGN',
]);

async function requireReportBranch(ctx: TRPCContext, branchId: string) {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const [staff, assignment] = await Promise.all([
    ctx.db.restaurantStaffProfile.findFirst({
      where: { userId: user.id, status: 'ACTIVE', primaryBranchId: branchId },
      select: { id: true },
    }),
    ctx.db.restaurantBranchAssignment.findFirst({
      where: { userId: user.id, branchId },
      select: { id: true },
    }),
  ]);
  const allowed =
    Boolean(staff || assignment) ||
    (await can(subjectFromSession(user), 'restaurant:configure', undefined, {
      db: ctx.db,
      source: 'TRPC',
    }));
  if (!allowed) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not authorized for this branch.' });
  }
  const organizationId = ctx.entitlements.organizationId ?? user.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await assertInOrganization(ctx.db.restaurantBranch, organizationId, [branchId], { active: true });
}

/** Resolve scope from the stored occurrence, never from caller attribution. */
async function occurrenceActor(ctx: TRPCContext, occurrenceId: string) {
  const occurrence = await ctx.db.restaurantSopOccurrence.findUnique({
    where: { id: occurrenceId },
    select: { branchId: true },
  });
  if (!occurrence) throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
  return resolveRestaurantActor(ctx, [occurrence.branchId]);
}

// ── Read: branch board ────────────────────────────────────────────────────────

/** Due-today, late, missed, awaiting-verification filters for the branch board. */
const BoardFilterSchema = z
  .object({
    branchId: z.string().min(1),
    /** ISO date string YYYY-MM-DD — board date for "due today" filter. */
    businessDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
      .optional(),
    status: z
      .enum([
        'SCHEDULED',
        'IN_PROGRESS',
        'SUBMITTED',
        'VERIFIED',
        'REJECTED',
        'LATE',
        'MISSED',
        'WAIVED',
      ])
      .optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  })
  .strict();

export const restaurantSopExecutionRouter = router({
  reportBranches: reportProcedure.query(async ({ ctx }) => {
    const user = ctx.session!.user;
    const canConfigure = await can(subjectFromSession(user), 'restaurant:configure', undefined, {
      db: ctx.db,
      source: 'TRPC',
    });

    return ctx.db.restaurantBranch.findMany({
      where: {
        organizationId: ctx.organization?.id ?? ctx.session!.user.organizationId,
        active: true,
        ...(canConfigure
          ? {}
          : {
              OR: [
                { staffProfiles: { some: { userId: user.id, status: 'ACTIVE' } } },
                { assignments: { some: { userId: user.id } } },
              ],
            }),
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    });
  }),

  report: reportProcedure
    .input(
      z
        .object({
          branchId: z.string().min(1),
          from: REPORT_DATE,
          to: REPORT_DATE,
          department: DEPARTMENT.optional(),
        })
        .strict()
        .refine((input) => input.from <= input.to, {
          message: 'From date must be on or before to date.',
          path: ['from'],
        })
    )
    .query(async ({ ctx, input }) => {
      await requireReportBranch(ctx, input.branchId);
      const departmentScope = input.department
        ? {
            OR: [
              { assignedStaff: { user: { department: input.department } } },
              { claimedBy: { user: { department: input.department } } },
              { steps: { some: { completedBy: { user: { department: input.department } } } } },
            ],
          }
        : {};
      const rows = await ctx.db.restaurantSopOccurrence.findMany({
        where: {
          branchId: input.branchId,
          businessDate: {
            gte: businessDateToUtcDate(input.from),
            lte: businessDateToUtcDate(input.to),
          },
          ...departmentScope,
        },
        orderBy: [{ businessDate: 'asc' }, { dueAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          dueAt: true,
          windowEndsAt: true,
          submittedAt: true,
          resolvedAt: true,
          assignedStaff: {
            select: { id: true, displayName: true, user: { select: { department: true } } },
          },
          claimedBy: {
            select: { id: true, displayName: true, user: { select: { department: true } } },
          },
          steps: {
            select: {
              completed: true,
              completedBy: {
                select: { id: true, displayName: true, user: { select: { department: true } } },
              },
            },
          },
          evidence: { select: { id: true } },
          verifications: { select: { action: true } },
          escalationEvents: { select: { kind: true } },
        },
      });
      return summarizeSopReport(rows);
    }),

  // ── Board: list occurrences ───────────────────────────────────────────────

  listOccurrences: completeProcedure.input(BoardFilterSchema).query(async ({ ctx, input }) => {
    assertSopDepth(ctx.entitlements, 'sop.execution');
    const where: Record<string, unknown> = { branchId: input.branchId };

    if (input.businessDate) {
      // Filter by business date (stored as UTC @db.Date midnight)
      const date = new Date(`${input.businessDate}T00:00:00.000Z`);
      where['businessDate'] = date;
    }

    if (input.status) {
      where['status'] = input.status;
    } else {
      // Default board view: active statuses (not terminal)
      where['status'] = {
        in: ['SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'REJECTED', 'LATE', 'MISSED'],
      };
    }

    if (input.cursor) {
      where['id'] = { gt: input.cursor };
    }

    const items = await ctx.db.restaurantSopOccurrence.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
      select: {
        id: true,
        status: true,
        businessDate: true,
        dueAt: true,
        windowEndsAt: true,
        startedAt: true,
        submittedAt: true,
        resolvedAt: true,
        assignment: {
          select: {
            id: true,
            template: { select: { id: true, name: true, category: true } },
          },
        },
        steps: {
          select: { id: true, templateStepId: true, completed: true },
        },
      },
    });

    const hasMore = items.length > input.limit;
    const page = hasMore ? items.slice(0, input.limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }),

  // ── Detail: one occurrence with evidence, verifications, escalation ───────

  getOccurrence: completeProcedure
    .input(z.object({ id: OCCURRENCE_ID }).strict())
    .query(async ({ ctx, input }) => {
      assertSopDepth(ctx.entitlements, 'sop.execution');
      const occ = await ctx.db.restaurantSopOccurrence.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          status: true,
          businessDate: true,
          dueAt: true,
          windowEndsAt: true,
          startedAt: true,
          submittedAt: true,
          resolvedAt: true,
          branchId: true,
          assignment: {
            select: {
              id: true,
              graceMinutes: true,
              template: { select: { id: true, name: true, category: true } },
            },
          },
          templateVersion: {
            select: {
              id: true,
              versionNumber: true,
              steps: {
                orderBy: { stepOrder: 'asc' },
                select: {
                  id: true,
                  stepOrder: true,
                  title: true,
                  instructions: true,
                  requiresPhoto: true,
                  requiresSignature: true,
                  requiresNote: true,
                },
              },
            },
          },
          steps: {
            select: {
              id: true,
              templateStepId: true,
              completed: true,
              completedAt: true,
              completedByStaffProfileId: true,
              note: true,
            },
          },
          evidence: {
            orderBy: { capturedAt: 'asc' },
            select: {
              id: true,
              occurrenceStepId: true,
              contentHash: true,
              mimeType: true,
              sizeBytes: true,
              storageRef: true,
              uploaderStaffProfileId: true,
              capturedAt: true,
            },
          },
          verifications: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              action: true,
              actorStaffProfileId: true,
              coAuthorizationId: true,
              reason: true,
              createdAt: true,
            },
          },
          escalationEvents: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              escalationStepId: true,
              kind: true,
              actorStaffProfileId: true,
              detail: true,
              createdAt: true,
            },
          },
        },
      });
      if (!occ) throw new TRPCError({ code: 'NOT_FOUND', message: 'Occurrence not found.' });
      return occ;
    }),

  // ── Commands: execution lifecycle ─────────────────────────────────────────

  start: completeProcedure
    .input(
      z
        .object({
          occurrenceId: OCCURRENCE_ID,
          actorStaffProfileId: OPTIONAL_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      assertSopDepth(ctx.entitlements, 'sop.execution');
      try {
        const result = await startOccurrence(ctx.db, {
          ...input,
          actorStaffProfileId: (await occurrenceActor(ctx, input.occurrenceId)).staffProfileId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantSopOccurrence',
          targetId: result.occurrenceId,
          description: 'Started SOP occurrence',
        });
        return result;
      } catch (err) {
        mapExecutionError(err);
      }
    }),

  completeStep: completeProcedure
    .input(
      z
        .object({
          occurrenceId: OCCURRENCE_ID,
          templateStepId: z.string().min(1),
          note: z.string().max(2_000).nullable().optional(),
          actorStaffProfileId: OPTIONAL_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      assertSopDepth(ctx.entitlements, 'sop.execution');
      try {
        return await completeStep(ctx.db, {
          ...input,
          actorStaffProfileId: (await occurrenceActor(ctx, input.occurrenceId)).staffProfileId,
        });
      } catch (err) {
        mapExecutionError(err);
      }
    }),

  attachEvidence: completeProcedure
    .input(
      z
        .object({
          occurrenceId: OCCURRENCE_ID,
          occurrenceStepId: z.string().min(1).nullable().optional(),
          /** Hex sha256 of the content (caller computes; bytes never sent to this endpoint). */
          contentHashHex: z.string().regex(/^[0-9a-f]{64}$/, 'Expected 64-char hex sha256.'),
          mimeType: z.string().min(1).max(255),
          sizeBytes: z.number().int().min(0),
          storageRef: z.string().max(2_000).nullable().optional(),
          uploaderStaffProfileId: OPTIONAL_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      assertSopDepth(ctx.entitlements, 'sop.evidence');
      try {
        const result = await attachEvidence(ctx.db, {
          occurrenceId: input.occurrenceId,
          occurrenceStepId: input.occurrenceStepId,
          contentHashHex: input.contentHashHex,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          storageRef: input.storageRef,
          uploaderStaffProfileId: (await occurrenceActor(ctx, input.occurrenceId)).staffProfileId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantSopEvidence',
          targetId: result.evidenceId,
          description: `Attached evidence to occurrence ${input.occurrenceId}`,
        });
        return result;
      } catch (err) {
        mapExecutionError(err);
      }
    }),

  submit: completeProcedure
    .input(
      z
        .object({
          occurrenceId: OCCURRENCE_ID,
          actorStaffProfileId: OPTIONAL_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      assertSopDepth(ctx.entitlements, 'sop.execution');
      try {
        const result = await submitOccurrence(ctx.db, {
          ...input,
          actorStaffProfileId: (await occurrenceActor(ctx, input.occurrenceId)).staffProfileId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantSopOccurrence',
          targetId: result.occurrenceId,
          description: `Submitted SOP occurrence (status: ${result.status})`,
        });
        return result;
      } catch (err) {
        mapExecutionError(err);
      }
    }),

  // ── Commands: verification ────────────────────────────────────────────────

  verify: verifyProcedure
    .input(
      z
        .object({
          occurrenceId: OCCURRENCE_ID,
          actorStaffProfileId: OPTIONAL_ACTOR,
          reason: OPTIONAL_REASON,
          approvalPin: APPROVAL_PIN,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      assertSopDepth(ctx.entitlements, 'sop.verification');
      try {
        const result = await verifyOccurrence(ctx.db, {
          ...input,
          actorStaffProfileId: (await occurrenceActor(ctx, input.occurrenceId)).staffProfileId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantSopOccurrence',
          targetId: input.occurrenceId,
          description: 'Verified SOP occurrence',
        });
        return result;
      } catch (err) {
        mapExecutionError(err);
      }
    }),

  reject: verifyProcedure
    .input(
      z
        .object({
          occurrenceId: OCCURRENCE_ID,
          actorStaffProfileId: OPTIONAL_ACTOR,
          reason: OPTIONAL_REASON,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      assertSopDepth(ctx.entitlements, 'sop.verification');
      try {
        const result = await rejectOccurrence(ctx.db, {
          ...input,
          actorStaffProfileId: (await occurrenceActor(ctx, input.occurrenceId)).staffProfileId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantSopOccurrence',
          targetId: input.occurrenceId,
          description: 'Rejected SOP occurrence',
        });
        return result;
      } catch (err) {
        mapExecutionError(err);
      }
    }),

  waive: verifyProcedure
    .input(
      z
        .object({
          occurrenceId: OCCURRENCE_ID,
          // Ignored: the acting verifier is always the session actor.
          actorStaffProfileId: OPTIONAL_ACTOR,
          approvingStaffProfileId: z.string().trim().min(1),
          approvalPin: APPROVAL_PIN,
          approvingPin: APPROVAL_PIN,
          reason: z.string().min(1).max(2_000),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      assertSopDepth(ctx.entitlements, 'sop.waiver');
      try {
        const result = await waiveOccurrence(ctx.db, {
          ...input,
          actorStaffProfileId: (await occurrenceActor(ctx, input.occurrenceId)).staffProfileId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantSopOccurrence',
          targetId: input.occurrenceId,
          description: 'Waived SOP occurrence',
        });
        return result;
      } catch (err) {
        mapExecutionError(err);
      }
    }),

  // ── Commands: escalation ──────────────────────────────────────────────────

  acknowledge: completeProcedure
    .input(
      z
        .object({
          occurrenceId: OCCURRENCE_ID,
          actorStaffProfileId: OPTIONAL_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      assertSopDepth(ctx.entitlements, 'sop.escalation');
      try {
        return await acknowledgeEscalation(ctx.db, {
          ...input,
          actorStaffProfileId: (await occurrenceActor(ctx, input.occurrenceId)).staffProfileId,
        });
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to acknowledge.' });
      }
    }),
});
