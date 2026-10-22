import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { quoteStay } from '@/lib/hotel/rates';
import { currentProperty } from '@/server/hotel-property-context';
import { capabilityProcedure, router } from '../trpc';

// These are intentionally separate grants. The casts bridge the legacy Action
// catalogue until its generated union learns the two finer-grained keys; ABAC
// still receives (and default-denies) the exact runtime capability strings.
const read = capabilityProcedure('hotel:rates:read' as 'hotel:rates');
const manage = capabilityProcedure('hotel:rates:manage' as 'hotel:rates');
const selection = z.object({ branchId: z.string().trim().min(1).max(128) }).strict();
const ids = selection.extend({
  roomTypeId: z.string().trim().min(1).max(128),
  ratePlanId: z.string().trim().min(1).max(128),
});
const quoteInput = ids.extend({ arrival: z.coerce.date(), departure: z.coerce.date() }).strict();
const createInput = selection.extend({
  roomTypeId: z.string().trim().min(1).max(128),
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  currency: z.string().regex(/^[A-Z]{3}$/),
  taxBasisPoints: z.number().int().min(0).max(100_000),
}).strict();
const priceInput = ids.extend({
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  netMinor: z.bigint().nonnegative().max(9_223_372_036_854_775_807n),
}).strict();

type PriceRow = { stayDate: Date; netMinor: bigint; taxBasisPoints: number };

export const hotelRatePlansRouter = router({
  list: read.input(selection).query(async ({ ctx, input }) => {
    const property = await currentProperty(ctx, input.branchId, 'hotel:rates');
    return ctx.db.$queryRaw(Prisma.sql`
      SELECT id, "roomTypeId", code, name, currency, "taxBasisPoints", active
      FROM hotel_rate_plans
      WHERE "organizationId"=${ctx.entitlements.organizationId}
        AND "branchId"=${property.branchId}
      ORDER BY code`);
  }),

  quote: read.input(quoteInput).query(async ({ ctx, input }) => {
    const property = await currentProperty(ctx, input.branchId, 'hotel:rates');
    return quoteStay(
      {
        organizationId: ctx.entitlements.organizationId,
        branchId: property.branchId,
        loadPrices: (scope) => ctx.db.$queryRaw<PriceRow[]>(Prisma.sql`
          SELECT day::date AS "stayDate", p."netMinor", rp."taxBasisPoints"
          FROM generate_series(${scope.arrival}::date, ${scope.departure}::date - 1, interval '1 day') day
          JOIN LATERAL (SELECT candidate."netMinor", candidate."ratePlanId"
            FROM hotel_rate_plan_prices candidate
            WHERE candidate."organizationId"=${scope.organizationId}
              AND candidate."branchId"=${scope.branchId} AND candidate."roomTypeId"=${scope.roomTypeId}
              AND candidate."ratePlanId"=${scope.ratePlanId}
              AND candidate.published=true
              AND day::date BETWEEN candidate."validFrom" AND candidate."validTo"
            ORDER BY candidate."createdAt" DESC LIMIT 1) p ON true
          JOIN hotel_rate_plans rp ON rp."organizationId"=${scope.organizationId}
            AND rp."branchId"=${scope.branchId} AND rp.id=p."ratePlanId" AND rp.active=true
          ORDER BY day`),
      },
      input.roomTypeId,
      input.ratePlanId,
      input.arrival,
      input.departure
    );
  }),

  create: manage.input(createInput).mutation(async ({ ctx, input }) => {
    const property = await currentProperty(ctx, input.branchId, 'hotel:rates');
    const id = crypto.randomUUID();
    const written = await ctx.db.$executeRaw(Prisma.sql`
      INSERT INTO hotel_rate_plans
        (id,"organizationId","branchId","roomTypeId",code,name,currency,"taxBasisPoints","taxConfig","validFrom","nightlyRateMinor")
      SELECT ${id},${ctx.entitlements.organizationId},${property.branchId},rt.id,${input.code},${input.name},${input.currency},${input.taxBasisPoints},'{}'::jsonb,CURRENT_DATE,0
      FROM hotel_room_types rt
      WHERE rt."organizationId"=${ctx.entitlements.organizationId} AND rt."branchId"=${property.branchId} AND rt.id=${input.roomTypeId}`);
    if (written !== 1)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Room type not found.' });
    return { id };
  }),

  publishPrice: manage.input(priceInput).mutation(async ({ ctx, input }) => {
    const property = await currentProperty(ctx, input.branchId, 'hotel:rates');
    if (input.validFrom > input.validTo)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid price range.' });
    const id = crypto.randomUUID();
    const written = await ctx.db.$executeRaw(Prisma.sql`
      INSERT INTO hotel_rate_plan_prices
        (id,"organizationId","branchId","roomTypeId","ratePlanId","validFrom","validTo","netMinor",published)
      SELECT ${id},${ctx.entitlements.organizationId},${property.branchId},rp."roomTypeId",rp.id,
        ${input.validFrom}::date,${input.validTo}::date,${input.netMinor},true
      FROM hotel_rate_plans rp
      WHERE rp."organizationId"=${ctx.entitlements.organizationId} AND rp."branchId"=${property.branchId}
        AND rp.id=${input.ratePlanId} AND rp."roomTypeId"=${input.roomTypeId}`);
    if (written !== 1) throw new TRPCError({ code: 'NOT_FOUND', message: 'Rate plan not found.' });
    return { id };
  }),
});
