import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, capabilityProcedure } from '../trpc';
import { annotateAudit } from '../audit';
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
});
