import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, capabilityProcedure } from '../trpc';
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
 */

const completeProcedure = capabilityProcedure('sop:complete');
const verifyProcedure = capabilityProcedure('sop:verify');

function mapExecutionError(err: unknown): never {
  if (err instanceof SopExecutionError) {
    const code =
      err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'FORBIDDEN'
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
const OPTIONAL_ACTOR = z.string().min(1).nullable().optional();
const OPTIONAL_REASON = z.string().max(2_000).nullable().optional();

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
  // ── Board: list occurrences ───────────────────────────────────────────────

  listOccurrences: completeProcedure.input(BoardFilterSchema).query(async ({ ctx, input }) => {
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
      try {
        const result = await startOccurrence(ctx.db, input);
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
      try {
        return await completeStep(ctx.db, input);
      } catch (err) {
        mapExecutionError(err);
      }
    }),

  /**
   * Compatibility seam for trusted storage adapters. The product UI uses the
   * multipart evidence route, which computes the hash from uploaded bytes.
   */
  attachEvidence: completeProcedure
    .input(
      z
        .object({
          occurrenceId: OCCURRENCE_ID,
          occurrenceStepId: z.string().min(1).nullable().optional(),
          contentHashHex: z.string().regex(/^[0-9a-f]{64}$/, 'Expected 64-char hex sha256.'),
          mimeType: z.string().min(1).max(255),
          sizeBytes: z.number().int().positive(),
          storageRef: z.string().max(2_000).nullable().optional(),
          uploaderStaffProfileId: OPTIONAL_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await attachEvidence(ctx.db, {
          occurrenceId: input.occurrenceId,
          occurrenceStepId: input.occurrenceStepId,
          contentHashHex: input.contentHashHex,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          storageRef: input.storageRef,
          uploaderStaffProfileId: input.uploaderStaffProfileId,
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
      try {
        const result = await submitOccurrence(ctx.db, input);
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
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await verifyOccurrence(ctx.db, input);
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
      try {
        const result = await rejectOccurrence(ctx.db, input);
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
          actorStaffProfileId: z.string().min(1),
          approvingStaffProfileId: z.string().min(1),
          reason: z.string().min(1).max(2_000),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await waiveOccurrence(ctx.db, input);
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
      try {
        return await acknowledgeEscalation(ctx.db, input);
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to acknowledge.' });
      }
    }),
});
