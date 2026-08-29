import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, capabilityProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  ShiftError,
  cancelShift,
  createShift,
  listShifts,
  updateShift,
} from '@/lib/restaurant/shifts';

/**
 * Completion wave — back-office roster surface for branch-scoped staff shifts.
 *
 * Every procedure is gated by `capabilityProcedure('staff:manage')`, the same
 * capability that owns staff profiles and operator credentials: a roster decides
 * who may operate a terminal, so it belongs to whoever already manages staff
 * access rather than to a new, parallel permission. It audits, enforces the
 * licensed `restaurant-core` module (`module-catalog.ts`), and runs the ABAC
 * decision. Tenant scoping is the RLS-forced `organizationId` default on every
 * row (C1); no resolver forges an organization id.
 *
 * Instants cross the wire as ISO strings and are coerced to `Date` here; the
 * business date is stamped SERVER-side from the branch's timezone and cutoff, so
 * a client can never choose which operating day a shift lands on.
 */

const BUSINESS_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD business date');

/** Translate a shift-domain error into the right tRPC status; rethrow anything else. */
function mapShiftError(err: unknown): never {
  if (err instanceof ShiftError) {
    const code =
      err.reason === 'OVERLAP' || err.reason === 'ALREADY_CANCELLED'
        ? 'CONFLICT'
        : err.reason === 'SHIFT_NOT_FOUND' ||
            err.reason === 'BRANCH_NOT_FOUND' ||
            err.reason === 'STAFF_NOT_FOUND'
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

const shiftProcedure = capabilityProcedure('staff:manage');

async function requireShiftAtBranch(db: ScopedDb, id: string, branchId: string) {
  const shift = await db.restaurantShift.findFirst({
    where: { id, branchId },
    select: {
      id: true,
      branchId: true,
      staffProfileId: true,
      startAt: true,
      endAt: true,
      status: true,
      clockedInAt: true,
      clockedOutAt: true,
    },
  });
  if (!shift)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Shift not found in this branch.' });
  if (shift.status === 'CANCELLED') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'A cancelled shift cannot record attendance.',
    });
  }
  return shift;
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
        const shift = await createShift(ctx.db, input);
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
        startAt: z.coerce.date().optional(),
        endAt: z.coerce.date().optional(),
        role: z.string().max(120).nullable().optional(),
        notes: z.string().max(1000).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        const shift = await updateShift(ctx.db, id, patch);
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
    .input(z.object({ id: z.string().min(1), reason: z.string().max(500).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const shift = await cancelShift(ctx.db, input.id, {
          now: new Date(),
          reason: input.reason,
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

  clockIn: shiftProcedure
    .input(z.object({ id: z.string().min(1), branchId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      const shift = await requireShiftAtBranch(ctx.db, input.id, input.branchId);
      if (shift.clockedInAt)
        throw new TRPCError({ code: 'CONFLICT', message: 'Shift is already clocked in.' });
      const now = new Date();
      return ctx.db.restaurantShift.update({
        where: { id: shift.id },
        data: { clockedInAt: now, lateArrivalAt: now > shift.startAt ? now : null },
      });
    }),

  startBreak: shiftProcedure
    .input(z.object({ id: z.string().min(1), branchId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      const shift = await requireShiftAtBranch(ctx.db, input.id, input.branchId);
      if (!shift.clockedInAt || shift.clockedOutAt) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Breaks require an active clock-in.' });
      }
      const open = await ctx.db.restaurantShiftBreak.findFirst({
        where: { shiftId: shift.id, endedAt: null },
        select: { id: true },
      });
      if (open) throw new TRPCError({ code: 'CONFLICT', message: 'A break is already active.' });
      return ctx.db.restaurantShiftBreak.create({
        data: { shiftId: shift.id, startedAt: new Date() },
      });
    }),

  endBreak: shiftProcedure
    .input(z.object({ id: z.string().min(1), branchId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      const shift = await requireShiftAtBranch(ctx.db, input.id, input.branchId);
      const open = await ctx.db.restaurantShiftBreak.findFirst({
        where: { shiftId: shift.id, endedAt: null },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      if (!open) throw new TRPCError({ code: 'CONFLICT', message: 'No active break exists.' });
      return ctx.db.restaurantShiftBreak.update({
        where: { id: open.id },
        data: { endedAt: new Date() },
      });
    }),

  clockOut: shiftProcedure
    .input(z.object({ id: z.string().min(1), branchId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      const shift = await requireShiftAtBranch(ctx.db, input.id, input.branchId);
      if (!shift.clockedInAt || shift.clockedOutAt) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Shift does not have an active clock-in.',
        });
      }
      const openBreak = await ctx.db.restaurantShiftBreak.findFirst({
        where: { shiftId: shift.id, endedAt: null },
        select: { id: true },
      });
      if (openBreak)
        throw new TRPCError({ code: 'CONFLICT', message: 'End the active break first.' });
      return ctx.db.restaurantShift.update({
        where: { id: shift.id },
        data: { clockedOutAt: new Date() },
      });
    }),

  requestSwap: shiftProcedure
    .input(
      z
        .object({
          id: z.string().min(1),
          branchId: z.string().min(1),
          requestedByStaffProfileId: z.string().min(1),
          replacementStaffProfileId: z.string().min(1).optional(),
          note: z.string().max(500).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const shift = await requireShiftAtBranch(ctx.db, input.id, input.branchId);
      if (shift.staffProfileId !== input.requestedByStaffProfileId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the rostered operator may request this swap.',
        });
      }
      if (input.replacementStaffProfileId) {
        const replacement = await ctx.db.restaurantStaffProfile.findFirst({
          where: {
            id: input.replacementStaffProfileId,
            primaryBranchId: input.branchId,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (!replacement)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Replacement is not active in this branch.',
          });
      }
      return ctx.db.restaurantShiftSwapRequest.create({
        data: {
          shiftId: shift.id,
          requestedByStaffProfileId: input.requestedByStaffProfileId,
          replacementStaffProfileId: input.replacementStaffProfileId,
          note: input.note?.trim() || null,
        },
      });
    }),

  reviewSwap: shiftProcedure
    .input(
      z
        .object({
          requestId: z.string().min(1),
          branchId: z.string().min(1),
          decision: z.enum(['APPROVED', 'REJECTED']),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const request = await ctx.db.restaurantShiftSwapRequest.findFirst({
        where: { id: input.requestId, status: 'REQUESTED', shift: { branchId: input.branchId } },
        include: { shift: true },
      });
      if (!request)
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Pending swap not found in this branch.',
        });
      if (input.decision === 'APPROVED' && !request.replacementStaffProfileId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'An approved swap requires a replacement.',
        });
      }
      const now = new Date();
      return ctx.db.$transaction(async (tx) => {
        if (input.decision === 'APPROVED') {
          await tx.restaurantShift.update({
            where: { id: request.shiftId },
            data: { staffProfileId: request.replacementStaffProfileId! },
          });
        }
        return tx.restaurantShiftSwapRequest.update({
          where: { id: request.id },
          data: { status: input.decision, reviewedAt: now },
        });
      });
    }),
});
