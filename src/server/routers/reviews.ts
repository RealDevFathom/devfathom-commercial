import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, hrProcedure } from '../trpc';
import { annotateAudit } from '../audit';

/**
 * IMP-HR-04 — performance-review workflow.
 *
 * Two entities (schema already exists):
 *  - ReviewCycle: a named evaluation window (OPEN | CLOSED). HR/Admin manage these.
 *  - Review: one reviewer's evaluation of one subject within a cycle
 *    (DRAFT | SUBMITTED), unique per [cycleId, subjectId, reviewerId].
 *
 * Authorization model:
 *  - Cycle CRUD + reviewer assignment are HR/Admin only (`hrProcedure`, backed by
 *    the ABAC 'hr:access' capability + audited).
 *  - Submitting a review is gated to the *assigned reviewer* inside the resolver.
 *  - Read visibility (`listReviews`) is scoped per role: HR/Admin see everything;
 *    a reviewer sees the reviews they were assigned; a subject sees only
 *    SUBMITTED reviews written about them (drafts about you stay private).
 */

// Compact, privacy-safe projection of the people attached to a review.
const personSelect = {
  id: true,
  name: true,
  avatar: true,
  title: true,
  department: true,
} as const;

// Cycle header for a review row.
const cycleSelect = {
  id: true,
  name: true,
  status: true,
  startDate: true,
  endDate: true,
} as const;

const reviewInclude = {
  cycle: { select: cycleSelect },
  subject: { select: personSelect },
  reviewer: { select: personSelect },
} as const;

function isPrivileged(role?: string | null): boolean {
  return role === 'ADMIN' || role === 'HR';
}

export const reviewsRouter = router({
  /* ---------------------------------------------------------------------------
   * Cycle management — HR / Admin only.
   * ------------------------------------------------------------------------- */

  // Create a new review cycle. The current HR/Admin user is recorded as creator.
  createCycle: hrProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.endDate < input.startDate) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The end date must be on or after the start date.',
        });
      }

      const cycle = await ctx.db.reviewCycle.create({
        data: {
          name: input.name.trim(),
          startDate: input.startDate,
          endDate: input.endDate,
          createdById: ctx.session.user.id,
        },
      });

      annotateAudit(ctx, {
        targetType: 'ReviewCycle',
        targetId: cycle.id,
        targetLabel: cycle.name,
        description: `Created review cycle "${cycle.name}"`,
      });

      return cycle;
    }),

  // All cycles with their review counts, newest first (HR/Admin overview).
  listCycles: hrProcedure.query(async ({ ctx }) => {
    return ctx.db.reviewCycle.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { reviews: true } },
      },
    });
  }),

  // Close a cycle (locks it as the active management state; assignment is blocked
  // while CLOSED). Idempotent.
  closeCycle: hrProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const cycle = await ctx.db.reviewCycle.findUnique({ where: { id: input.id } });
    if (!cycle) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Review cycle not found.' });
    }
    const updated = await ctx.db.reviewCycle.update({
      where: { id: input.id },
      data: { status: 'CLOSED' },
    });
    annotateAudit(ctx, {
      targetType: 'ReviewCycle',
      targetId: cycle.id,
      targetLabel: cycle.name,
      description: `Closed review cycle "${cycle.name}"`,
      changes: { status: { before: cycle.status, after: 'CLOSED' } },
    });
    return updated;
  }),

  // Reopen a closed cycle. Idempotent.
  reopenCycle: hrProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const cycle = await ctx.db.reviewCycle.findUnique({ where: { id: input.id } });
    if (!cycle) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Review cycle not found.' });
    }
    const updated = await ctx.db.reviewCycle.update({
      where: { id: input.id },
      data: { status: 'OPEN' },
    });
    annotateAudit(ctx, {
      targetType: 'ReviewCycle',
      targetId: cycle.id,
      targetLabel: cycle.name,
      description: `Reopened review cycle "${cycle.name}"`,
      changes: { status: { before: cycle.status, after: 'OPEN' } },
    });
    return updated;
  }),

  // Assign a reviewer to evaluate a subject within a cycle (creates a DRAFT).
  // The composite unique [cycleId, subjectId, reviewerId] prevents duplicates;
  // we use createMany + skipDuplicates for a race-safe insert and surface a clean
  // CONFLICT when the assignment already exists.
  addReview: hrProcedure
    .input(
      z.object({
        cycleId: z.string(),
        subjectId: z.string(),
        reviewerId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const cycle = await ctx.db.reviewCycle.findUnique({ where: { id: input.cycleId } });
      if (!cycle) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Review cycle not found.' });
      }
      if (cycle.status !== 'OPEN') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Reviewers can only be assigned while the cycle is open.',
        });
      }

      // Both participants must exist (clean error instead of an FK 500).
      const people = await ctx.db.user.findMany({
        where: { id: { in: [input.subjectId, input.reviewerId] } },
        select: { id: true, name: true },
      });
      const byId = new Map(people.map((p) => [p.id, p]));
      if (!byId.has(input.subjectId) || !byId.has(input.reviewerId)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Subject or reviewer not found.' });
      }

      // Race-safe insert; count === 0 means the assignment already existed.
      const result = await ctx.db.review.createMany({
        data: [
          {
            cycleId: input.cycleId,
            subjectId: input.subjectId,
            reviewerId: input.reviewerId,
          },
        ],
        skipDuplicates: true,
      });
      if (result.count === 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'That reviewer is already assigned to evaluate this person in this cycle.',
        });
      }

      const review = await ctx.db.review.findUnique({
        where: {
          cycleId_subjectId_reviewerId: {
            cycleId: input.cycleId,
            subjectId: input.subjectId,
            reviewerId: input.reviewerId,
          },
        },
        include: reviewInclude,
      });

      annotateAudit(ctx, {
        targetType: 'Review',
        targetId: review?.id,
        targetLabel: `${byId.get(input.reviewerId)?.name} → ${byId.get(input.subjectId)?.name}`,
        description: `Assigned ${byId.get(input.reviewerId)?.name} to review ${byId.get(input.subjectId)?.name} in "${cycle.name}"`,
      });

      return review;
    }),

  /* ---------------------------------------------------------------------------
   * Reviewer / subject facing.
   * ------------------------------------------------------------------------- */

  // Submit (or revise) YOUR review. Only the assigned reviewer may submit, and
  // not after the cycle has been closed.
  submitReview: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        rating: z.number().int().min(1).max(5),
        strengths: z.string().max(5000).optional(),
        improvements: z.string().max(5000).optional(),
        comments: z.string().max(5000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const review = await ctx.db.review.findUnique({
        where: { id: input.id },
        include: { cycle: { select: { id: true, name: true, status: true } } },
      });
      if (!review) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Review not found.' });
      }
      if (review.reviewerId !== ctx.session.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only submit a review that was assigned to you.',
        });
      }
      if (review.cycle.status !== 'OPEN') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This review cycle is closed.',
        });
      }

      const updated = await ctx.db.review.update({
        where: { id: input.id },
        data: {
          rating: input.rating,
          strengths: input.strengths?.trim() || null,
          improvements: input.improvements?.trim() || null,
          comments: input.comments?.trim() || null,
          status: 'SUBMITTED',
          submittedAt: new Date(),
        },
        include: reviewInclude,
      });

      annotateAudit(ctx, {
        targetType: 'Review',
        targetId: updated.id,
        targetLabel: updated.subject.name,
        description: `Submitted review of ${updated.subject.name} for "${review.cycle.name}"`,
        changes: { status: { before: review.status, after: 'SUBMITTED' } },
      });

      return updated;
    }),

  // List reviews, scoped to what the caller is allowed to see:
  //  - HR/Admin: everything.
  //  - everyone else: reviews they were assigned to write, OR SUBMITTED reviews
  //    written about them. (DRAFT feedback about you is never exposed.)
  listReviews: protectedProcedure
    .input(z.object({ cycleId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      const cycleFilter = input?.cycleId ? { cycleId: input.cycleId } : {};

      const where = isPrivileged(ctx.session.user.role)
        ? cycleFilter
        : {
            ...cycleFilter,
            OR: [{ reviewerId: me }, { subjectId: me, status: 'SUBMITTED' }],
          };

      return ctx.db.review.findMany({
        where,
        include: reviewInclude,
        orderBy: [{ createdAt: 'desc' }],
      });
    }),

  // Convenience for the employee surface: reviews I still need to fill in, plus
  // submitted feedback written about me.
  myReviews: protectedProcedure.query(async ({ ctx }) => {
    const me = ctx.session.user.id;

    const [assigned, aboutMe] = await Promise.all([
      // Everything assigned to me (DRAFT to complete + my own submitted ones).
      ctx.db.review.findMany({
        where: { reviewerId: me },
        include: reviewInclude,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      }),
      // Only SUBMITTED feedback about me is visible to the subject.
      ctx.db.review.findMany({
        where: { subjectId: me, status: 'SUBMITTED' },
        include: reviewInclude,
        orderBy: { submittedAt: 'desc' },
      }),
    ]);

    return { assigned, aboutMe };
  }),
});
