import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';

import { router, capabilityProcedure, protectedProcedure, type TRPCContext } from '../trpc';
import { annotateAudit } from '../audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  assertAuthorizedBranch,
  resolveStaffBranchAuthorization,
} from '@/lib/restaurant/staff-branch-authorization';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import { hasModule } from '@/lib/entitlements';
import { cancelShift, createShift, listShifts, updateShift } from '@/lib/restaurant/shifts';
import {
  appendTimeAdjustment,
  clockIn,
  clockOut,
  endBreak,
  exportWorkforceAttendanceCsv,
  presentWorkforceShift,
  readMyWorkforce,
  requestShiftSwap,
  reviewShiftSwap,
  startBreak,
  WORKFORCE_SHIFT_SELECT,
} from '@/lib/restaurant/workforce';
import { mapShiftError, mapWorkforceError } from './restaurant-shifts.errors';

/**
 * Completion wave — back-office roster surface for branch-scoped staff shifts.
 *
 * Existing scheduling and terminal eligibility remain in `restaurant-core`.
 * Attendance, breaks, swaps and exports add an explicit
 * `restaurant-workforce` check. Manager operations retain the existing
 * `staff:manage` capability and branch-assignment resolver; employee operations
 * resolve the authenticated user's own active staff profile. No procedure
 * accepts an organization id.
 *
 * Instants cross the wire as ISO strings and are coerced to `Date` here; the
 * business date is stamped SERVER-side from the branch's timezone and cutoff, so
 * a client can never choose which operating day a shift lands on.
 */

const BUSINESS_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD business date');

const shiftProcedure = capabilityProcedure('staff:manage');
const IDEMPOTENCY_KEY = z.string().trim().min(1).max(200);
const MAX_RANGE_DAYS = 31;

function requireWorkforce(ctx: TRPCContext) {
  if (!hasModule(ctx.entitlements, 'restaurant-workforce')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Restaurant Workforce is not enabled for this organization.',
    });
  }
}

export function boundedBusinessRange(from: string, to: string) {
  try {
    const start = businessDateToUtcDate(from);
    const end = businessDateToUtcDate(to);
    const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days < 1 || days > MAX_RANGE_DAYS) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Workforce ranges must cover between 1 and ${MAX_RANGE_DAYS} business days.`,
      });
    }
    return { start, end };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid business-date range.' });
  }
}

async function managerAuthorization(ctx: TRPCContext, branchId: string) {
  const authorization = await resolveStaffBranchAuthorization(
    ctx.db,
    ctx.session!.user,
    ctx.entitlements.organizationId
  );
  assertAuthorizedBranch(authorization, branchId);
  return authorization;
}

async function branchForShift(ctx: TRPCContext, shiftId: string) {
  const shift = await ctx.db.restaurantShift.findUnique({
    where: { id: shiftId },
    select: { branchId: true },
  });
  if (!shift) throw new TRPCError({ code: 'NOT_FOUND', message: 'Shift not found.' });
  return shift.branchId;
}

async function managerShift(tx: Prisma.TransactionClient, organizationId: string, shiftId: string) {
  const rows = await tx.$queryRaw<Array<{ staffProfileId: string; version: number }>>(
    Prisma.sql`SELECT "staffProfileId", "version" FROM "restaurant_shifts"
      WHERE "id" = ${shiftId} AND "organizationId" = ${organizationId}`
  );
  if (!rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Shift not found.' });
  return rows[0];
}

async function lockStaffRoster(tx: Prisma.TransactionClient, staffProfileId: string) {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`restaurant-roster:${staffProfileId}`}, 0))`
  );
}

export const restaurantShiftsRouter = router({
  list: shiftProcedure
    .input(
      z.object({
        branchId: z.string().min(1),
        fromBusinessDate: BUSINESS_DATE,
        toBusinessDate: BUSINESS_DATE,
        staffProfileId: z.string().min(1).optional(),
        includeCancelled: z.boolean().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        boundedBusinessRange(input.fromBusinessDate, input.toBusinessDate);
        await managerAuthorization(ctx, input.branchId);
        return await listShifts(ctx.db, input);
      } catch (err) {
        mapShiftError(err);
      }
    }),

  create: shiftProcedure
    .input(
      z.object({
        branchId: z.string().min(1),
        staffProfileId: z.string().min(1),
        startAt: z.coerce.date(),
        endAt: z.coerce.date(),
        role: z.string().max(120).nullable().optional(),
        notes: z.string().max(1000).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await managerAuthorization(ctx, input.branchId);
        const shift = await ctx.db.$transaction(async (tx) => {
          await lockStaffRoster(tx, input.staffProfileId);
          const created = await createShift(tx as unknown as ScopedDb, input);
          await tx.restaurantShiftEvent.create({
            data: {
              shiftId: created.id,
              kind: 'PUBLISHED',
              actorUserId: ctx.session!.user.id,
              toStaffProfileId: created.staffProfileId,
            },
          });
          return created;
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantShift',
          targetId: shift.id,
          targetLabel: shift.role ?? 'Shift',
          description: `Scheduled a shift for staff ${shift.staffProfileId}`,
          metadata: {
            branchId: shift.branchId,
            staffProfileId: shift.staffProfileId,
            startAt: shift.startAt,
            endAt: shift.endAt,
          },
        });
        return shift;
      } catch (err) {
        mapShiftError(err);
      }
    }),

  update: shiftProcedure
    .input(
      z.object({
        id: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        startAt: z.coerce.date().optional(),
        endAt: z.coerce.date().optional(),
        role: z.string().max(120).nullable().optional(),
        notes: z.string().max(1000).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, expectedVersion, ...patch } = input;
      try {
        await managerAuthorization(ctx, await branchForShift(ctx, id));
        const shift = await ctx.db.$transaction(async (tx) => {
          const current = await managerShift(tx, ctx.entitlements.organizationId, id);
          await lockStaffRoster(tx, current.staffProfileId);
          const updated = await updateShift(tx as unknown as ScopedDb, id, patch, {
            organizationId: ctx.entitlements.organizationId,
            expectedVersion,
          });
          await tx.restaurantShiftEvent.create({
            data: {
              shiftId: updated.id,
              kind: 'UPDATED',
              actorUserId: ctx.session!.user.id,
              fromStaffProfileId: updated.staffProfileId,
              toStaffProfileId: updated.staffProfileId,
            },
          });
          return updated;
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantShift',
          targetId: shift.id,
          targetLabel: shift.role ?? 'Shift',
          description: `Updated the shift for staff ${shift.staffProfileId}`,
          metadata: { startAt: shift.startAt, endAt: shift.endAt },
        });
        return shift;
      } catch (err) {
        mapShiftError(err);
      }
    }),

  cancel: shiftProcedure
    .input(
      z.object({
        id: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        reason: z.string().max(500).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await managerAuthorization(ctx, await branchForShift(ctx, input.id));
        const shift = await ctx.db.$transaction(async (tx) => {
          await managerShift(tx, ctx.entitlements.organizationId, input.id);
          // Take the same shift row lock that clock corrections take, before
          // cancelShift reads attendance. Otherwise a correction committing
          // mid-cancel can leave a cancelled shift with open attendance.
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "restaurant_shifts"
              WHERE "id" = ${input.id} AND "organizationId" = ${ctx.entitlements.organizationId}
              FOR UPDATE`
          );
          const cancelled = await cancelShift(
            tx as unknown as ScopedDb,
            input.id,
            {
              now: new Date(),
              reason: input.reason,
            },
            {
              organizationId: ctx.entitlements.organizationId,
              expectedVersion: input.expectedVersion,
            }
          );
          await tx.restaurantShiftEvent.create({
            data: {
              shiftId: cancelled.id,
              kind: 'CANCELLED',
              actorUserId: ctx.session!.user.id,
              fromStaffProfileId: cancelled.staffProfileId,
              reason: cancelled.cancelReason,
            },
          });
          return cancelled;
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantShift',
          targetId: shift.id,
          targetLabel: shift.role ?? 'Shift',
          description: `Cancelled the shift for staff ${shift.staffProfileId}`,
          metadata: { cancelledAt: shift.cancelledAt, cancelReason: shift.cancelReason },
        });
        return shift;
      } catch (err) {
        mapShiftError(err);
      }
    }),

  myRoster: protectedProcedure
    .input(
      z
        .object({ from: z.coerce.date(), to: z.coerce.date() })
        .strict()
        .refine((value) => value.to >= value.from, 'The roster range is reversed.')
    )
    .query(async ({ ctx, input }) => {
      requireWorkforce(ctx);
      if (input.to.getTime() - input.from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The roster range is too large.' });
      }
      try {
        return await readMyWorkforce(ctx.db, ctx.session!.user.id, input.from, input.to);
      } catch (error) {
        mapWorkforceError(error);
      }
    }),

  managerRoster: shiftProcedure
    .input(
      z.object({
        branchId: z.string().min(1),
        fromBusinessDate: BUSINESS_DATE,
        toBusinessDate: BUSINESS_DATE,
        includeCancelled: z.boolean().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      requireWorkforce(ctx);
      const { start, end } = boundedBusinessRange(input.fromBusinessDate, input.toBusinessDate);
      await managerAuthorization(ctx, input.branchId);
      const rows = await ctx.db.restaurantShift.findMany({
        where: {
          branchId: input.branchId,
          businessDate: { gte: start, lte: end },
          ...(input.includeCancelled ? {} : { status: 'SCHEDULED' as const }),
        },
        select: WORKFORCE_SHIFT_SELECT,
        orderBy: [{ businessDate: 'asc' }, { startAt: 'asc' }],
      });
      return rows.map((row) => presentWorkforceShift(row));
    }),

  swapCandidates: protectedProcedure.query(async ({ ctx }) => {
    requireWorkforce(ctx);
    try {
      const own = await readMyWorkforce(ctx.db, ctx.session!.user.id, new Date(0), new Date(0));
      if (!own.actor.primaryBranchId) return [];
      return ctx.db.restaurantStaffProfile.findMany({
        where: {
          organizationId: ctx.organization?.id ?? ctx.session!.user.organizationId,
          primaryBranchId: own.actor.primaryBranchId,
          status: 'ACTIVE',
          id: { not: own.actor.id },
        },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
      });
    } catch (error) {
      mapWorkforceError(error);
    }
  }),

  clockIn: protectedProcedure
    .input(z.object({ shiftId: z.string().min(1), idempotencyKey: IDEMPOTENCY_KEY }).strict())
    .mutation(async ({ ctx, input }) => {
      requireWorkforce(ctx);
      try {
        return await clockIn(ctx.db, { ...input, userId: ctx.session!.user.id });
      } catch (error) {
        mapWorkforceError(error);
      }
    }),

  startBreak: protectedProcedure
    .input(z.object({ shiftId: z.string().min(1), idempotencyKey: IDEMPOTENCY_KEY }).strict())
    .mutation(async ({ ctx, input }) => {
      requireWorkforce(ctx);
      try {
        return await startBreak(ctx.db, { ...input, userId: ctx.session!.user.id });
      } catch (error) {
        mapWorkforceError(error);
      }
    }),

  endBreak: protectedProcedure
    .input(z.object({ shiftId: z.string().min(1), idempotencyKey: IDEMPOTENCY_KEY }).strict())
    .mutation(async ({ ctx, input }) => {
      requireWorkforce(ctx);
      try {
        return await endBreak(ctx.db, { ...input, userId: ctx.session!.user.id });
      } catch (error) {
        mapWorkforceError(error);
      }
    }),

  clockOut: protectedProcedure
    .input(z.object({ shiftId: z.string().min(1), idempotencyKey: IDEMPOTENCY_KEY }).strict())
    .mutation(async ({ ctx, input }) => {
      requireWorkforce(ctx);
      try {
        return await clockOut(ctx.db, { ...input, userId: ctx.session!.user.id });
      } catch (error) {
        mapWorkforceError(error);
      }
    }),

  requestSwap: protectedProcedure
    .input(
      z
        .object({
          shiftId: z.string().min(1),
          replacementStaffProfileId: z.string().min(1),
          note: z.string().max(500).optional(),
          idempotencyKey: IDEMPOTENCY_KEY,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      requireWorkforce(ctx);
      try {
        const request = await requestShiftSwap(ctx.db, {
          ...input,
          userId: ctx.session!.user.id,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantShiftSwapRequest',
          targetId: request!.id,
          targetLabel: 'Shift swap request',
          description: 'Requested a shift swap',
          metadata: { shiftId: input.shiftId },
        });
        return request;
      } catch (error) {
        mapWorkforceError(error);
      }
    }),

  reviewSwap: shiftProcedure
    .input(
      z
        .object({
          requestId: z.string().min(1),
          branchId: z.string().min(1),
          decision: z.enum(['APPROVED', 'REJECTED']),
          reason: z.string().max(500).optional(),
          idempotencyKey: IDEMPOTENCY_KEY,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      requireWorkforce(ctx);
      try {
        const authorization = await managerAuthorization(ctx, input.branchId);
        const decision = await reviewShiftSwap(ctx.db, {
          ...input,
          actorUserId: ctx.session!.user.id,
          actorStaffProfileId: authorization.actorStaffProfileId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantShiftSwapDecision',
          targetId: decision!.id,
          targetLabel: input.decision,
          description: `${input.decision === 'APPROVED' ? 'Approved' : 'Rejected'} a shift swap`,
          metadata: { requestId: input.requestId, branchId: input.branchId },
        });
        return decision;
      } catch (error) {
        mapWorkforceError(error);
      }
    }),

  correctTime: shiftProcedure
    .input(
      z
        .object({
          shiftId: z.string().min(1),
          branchId: z.string().min(1),
          breakId: z.string().min(1).optional(),
          kind: z.enum(['CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END']),
          correctedAt: z.coerce.date(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      requireWorkforce(ctx);
      try {
        const authorization = await managerAuthorization(ctx, input.branchId);
        if ((await branchForShift(ctx, input.shiftId)) !== input.branchId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Shift not found in this branch.' });
        }
        const adjustment = await appendTimeAdjustment(ctx.db, {
          ...input,
          actorUserId: ctx.session!.user.id,
          actorStaffProfileId: authorization.actorStaffProfileId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantTimeAdjustment',
          targetId: adjustment.id,
          targetLabel: input.kind,
          description: 'Appended a reasoned timekeeping correction',
          metadata: { shiftId: input.shiftId, correctedAt: input.correctedAt },
        });
        return adjustment;
      } catch (error) {
        mapWorkforceError(error);
      }
    }),

  exportAttendanceCsv: shiftProcedure
    .input(
      z.object({
        branchId: z.string().min(1),
        fromBusinessDate: BUSINESS_DATE,
        toBusinessDate: BUSINESS_DATE,
      })
    )
    .query(async ({ ctx, input }) => {
      requireWorkforce(ctx);
      const { start, end } = boundedBusinessRange(input.fromBusinessDate, input.toBusinessDate);
      await managerAuthorization(ctx, input.branchId);
      return exportWorkforceAttendanceCsv(ctx.db, {
        branchId: input.branchId,
        fromBusinessDate: start,
        toBusinessDate: end,
      });
    }),
});
