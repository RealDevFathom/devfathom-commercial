import { randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { recordHotelAudit } from '@/lib/hotel/audit';
import { MAX_MONEY_MINOR, MAX_TAX_BASIS_POINTS } from '@/lib/hotel/rates';
import { hotelDate, MAX_STAY_NIGHTS, stayDates } from '@/lib/hotel/reservations';
import { currentProperty, hasSqlState, withLockedProperty } from '@/server/hotel-property-context';
import { priceStay } from '@/server/hotel-rate-quote';
import { capabilityProcedure, router } from '../trpc';

/**
 * Rate plans gate on `hotel:rates`, the registered capability the rest of
 * `hotelRates.*` uses, and every procedure re-resolves the property with it.
 */
const rates = capabilityProcedure('hotel:rates');
const RATES = 'hotel:rates' as const;

const selection = z.object({ branchId: z.string().trim().min(1).max(128) }).strict();
const id = z.string().trim().min(1).max(191);

/** Strict: a quote takes configuration only; a client-supplied price is refused. */
export const ratePlanQuoteInput = selection
  .extend({ roomTypeId: id, ratePlanId: id, arrivalDate: hotelDate, departureDate: hotelDate })
  .strict()
  .superRefine((value, context) => {
    if (!hotelDate.safeParse(value.arrivalDate).success || !hotelDate.safeParse(value.departureDate).success) {
      return;
    }
    if (value.departureDate <= value.arrivalDate) {
      context.addIssue({ code: 'custom', path: ['departureDate'], message: 'Departure must follow arrival.' });
    } else if (stayDates(value.arrivalDate, value.departureDate).length > MAX_STAY_NIGHTS) {
      context.addIssue({
        code: 'custom',
        path: ['departureDate'],
        message: `Quote at most ${MAX_STAY_NIGHTS} nights.`,
      });
    }
  });

export const ratePlanCreateInput = selection
  .extend({
    roomTypeId: id,
    code: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .transform((value) => value.toUpperCase()),
    name: z.string().trim().min(1).max(160),
    /**
     * Optional: a plan is always priced in its property's currency (folios,
     * extras and the ledger are single-currency). A different code is refused.
     */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    taxBasisPoints: z.number().int().min(0).max(MAX_TAX_BASIS_POINTS),
  })
  .strict();

export const ratePlanPriceInput = selection
  .extend({
    roomTypeId: id,
    ratePlanId: id,
    validFrom: hotelDate,
    validTo: hotelDate,
    netMinor: z
      .bigint()
      .refine((value) => value >= BigInt(0) && value <= MAX_MONEY_MINOR, 'Enter a valid price.'),
  })
  .strict()
  .refine((value) => value.validFrom <= value.validTo, {
    path: ['validTo'],
    message: 'The price must end on or after it starts.',
  });

function actorId(ctx: { session: { user?: { id?: string } } | null }): string {
  const value = ctx.session?.user?.id;
  if (!value) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return value;
}

export const hotelRatePlansRouter = router({
  list: rates.input(selection).query(async ({ ctx, input }) => {
    const property = await currentProperty(ctx, input.branchId, RATES);
    return ctx.db.$queryRaw<
      {
        id: string;
        roomTypeId: string;
        code: string;
        name: string;
        currency: string;
        taxBasisPoints: number;
        active: boolean;
      }[]
    >(Prisma.sql`
      SELECT id, "roomTypeId", code, name, currency, "taxBasisPoints", active
      FROM hotel_rate_plans
      WHERE "organizationId" = ${ctx.entitlements.organizationId}
        AND "branchId" = ${property.branchId}
      ORDER BY code`);
  }),

  /** Same pricing path a booking snapshots: published prices plus the plan's tax. */
  quote: rates.input(ratePlanQuoteInput).query(async ({ ctx, input }) => {
    const property = await currentProperty(ctx, input.branchId, RATES);
    const scope = { organizationId: ctx.entitlements.organizationId, branchId: property.branchId };
    const priced = await priceStay(ctx.db, scope, input).catch((error: unknown) => {
      if (error instanceof RangeError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
      throw error;
    });
    if (!priced) throw new TRPCError({ code: 'NOT_FOUND', message: 'Rate plan not found.' });
    return priced;
  }),

  create: rates.input(ratePlanCreateInput).mutation(({ ctx, input }) => {
    const actor = actorId(ctx);
    return withLockedProperty(
      ctx,
      input.branchId,
      async (tx, property) => {
        if (input.currency && input.currency !== property.currency) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Rate plans are priced in this property's currency (${property.currency}).`,
          });
        }
        const currency = property.currency;
        const planId = randomUUID();
        let written: number;
        try {
          written = await tx.db.$executeRaw(Prisma.sql`
            INSERT INTO hotel_rate_plans
              (id, "organizationId", "branchId", "roomTypeId", code, name, currency, "taxBasisPoints", "createdById")
            SELECT ${planId}, rt."organizationId", rt."branchId", rt.id, ${input.code}, ${input.name},
              ${currency}, ${input.taxBasisPoints}, ${actor}
            FROM hotel_room_types rt
            WHERE rt."organizationId" = ${tx.entitlements.organizationId}
              AND rt."branchId" = ${property.branchId}
              AND rt.id = ${input.roomTypeId}
              AND rt.active = true`);
        } catch (error) {
          if (hasSqlState(error, '23505')) {
            throw new TRPCError({ code: 'CONFLICT', message: 'A rate plan with that code already exists.' });
          }
          throw error;
        }
        if (written !== 1) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room type not found.' });
        recordHotelAudit(ctx, {
          entity: { type: 'HotelRatePlan', id: planId, label: input.code },
          action: 'hotel.ratePlan.create',
          operation: 'CREATE',
          after: {
            roomTypeId: input.roomTypeId,
            code: input.code,
            name: input.name,
            currency,
            taxBasisPoints: input.taxBasisPoints,
          },
          metadata: { branchId: property.branchId },
        });
        return { id: planId };
      },
      RATES
    );
  }),

  /** Prices are append-only versions; the latest published row covering a night wins. */
  publishPrice: rates.input(ratePlanPriceInput).mutation(({ ctx, input }) => {
    const actor = actorId(ctx);
    return withLockedProperty(
      ctx,
      input.branchId,
      async (tx, property) => {
        const priceId = randomUUID();
        const written = await tx.db.$executeRaw(Prisma.sql`
          INSERT INTO hotel_rate_plan_prices
            (id, "organizationId", "branchId", "roomTypeId", "ratePlanId", "validFrom", "validTo",
             "netMinor", published, "createdById")
          SELECT ${priceId}, rp."organizationId", rp."branchId", rp."roomTypeId", rp.id,
            ${input.validFrom}::date, ${input.validTo}::date, ${input.netMinor}, true, ${actor}
          FROM hotel_rate_plans rp
          WHERE rp."organizationId" = ${tx.entitlements.organizationId}
            AND rp."branchId" = ${property.branchId}
            AND rp.id = ${input.ratePlanId}
            AND rp."roomTypeId" = ${input.roomTypeId}
            AND rp.active = true`);
        if (written !== 1) throw new TRPCError({ code: 'NOT_FOUND', message: 'Rate plan not found.' });
        recordHotelAudit(ctx, {
          entity: { type: 'HotelRatePlanPrice', id: priceId, label: input.ratePlanId },
          action: 'hotel.ratePlan.publishPrice',
          operation: 'CREATE',
          after: {
            ratePlanId: input.ratePlanId,
            roomTypeId: input.roomTypeId,
            validFrom: input.validFrom,
            validTo: input.validTo,
            netMinor: input.netMinor.toString(),
          },
          metadata: { branchId: property.branchId },
        });
        return { id: priceId };
      },
      RATES
    );
  }),
});
