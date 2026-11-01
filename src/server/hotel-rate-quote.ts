import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { quoteStay, type NightQuote, type RateScope } from '@/lib/hotel/rates';

/**
 * The one pricing model. A stay is priced from the rate plan's published,
 * effective-dated `hotel_rate_plan_prices` rows and the plan's own
 * `taxBasisPoints` — for a quote and for a booking alike, so what a guest is
 * quoted is what the reservation snapshots.
 */
export type RateQuoteDb = { $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T> };

export type StayPriceRequest = {
  roomTypeId: string;
  ratePlanId: string;
  arrivalDate: string;
  departureDate: string;
};

export type PricedStay = {
  ratePlanId: string;
  roomTypeId: string;
  currency: string;
  taxBasisPoints: number;
  nights: NightQuote[];
  netMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
};

type PriceRow = { stayDate: Date; netMinor: bigint; taxBasisPoints: number };
type PlanRow = { id: string; currency: string; taxBasisPoints: number };

const dateOnly = (value: Date) => value.toISOString().slice(0, 10);

function priceLoader(db: RateQuoteDb): RateScope['loadPrices'] {
  return (scope) =>
    db.$queryRaw<PriceRow[]>(Prisma.sql`
      SELECT night.day AS "stayDate", p."netMinor", rp."taxBasisPoints"
      FROM (
        SELECT generate_series(
          ${dateOnly(scope.arrival)}::date,
          ${dateOnly(scope.departure)}::date - 1,
          interval '1 day'
        )::date AS day
      ) night
      JOIN LATERAL (
        SELECT candidate."netMinor", candidate."ratePlanId"
        FROM hotel_rate_plan_prices candidate
        WHERE candidate."organizationId" = ${scope.organizationId}
          AND candidate."branchId" = ${scope.branchId}
          AND candidate."roomTypeId" = ${scope.roomTypeId}
          AND candidate."ratePlanId" = ${scope.ratePlanId}
          AND candidate.published = true
          AND night.day BETWEEN candidate."validFrom" AND candidate."validTo"
        ORDER BY candidate."createdAt" DESC, candidate.id DESC
        LIMIT 1
      ) p ON true
      JOIN hotel_rate_plans rp
        ON rp."organizationId" = ${scope.organizationId}
       AND rp."branchId" = ${scope.branchId}
       AND rp.id = p."ratePlanId"
       AND rp."roomTypeId" = ${scope.roomTypeId}
       AND rp.active = true
      ORDER BY night.day`);
}

/**
 * Prices a stay for one property. Returns null when the plan is not an active
 * plan of this property for this room type; throws RangeError when a night has
 * no published price. `lock` takes a share lock on the plan row so its terms
 * cannot change under a booking.
 */
export async function priceStay(
  db: RateQuoteDb,
  scope: { organizationId: string; branchId: string },
  request: StayPriceRequest,
  options: { lock?: boolean } = {}
): Promise<PricedStay | null> {
  const lock = options.lock ? Prisma.sql`FOR SHARE` : Prisma.empty;
  const plans = await db.$queryRaw<PlanRow[]>(Prisma.sql`
    SELECT id, currency, "taxBasisPoints"
    FROM hotel_rate_plans
    WHERE "organizationId" = ${scope.organizationId}
      AND "branchId" = ${scope.branchId}
      AND id = ${request.ratePlanId}
      AND "roomTypeId" = ${request.roomTypeId}
      AND active = true
    ${lock}`);
  const plan = plans[0];
  if (!plan) return null;
  const quote = await quoteStay(
    { organizationId: scope.organizationId, branchId: scope.branchId, loadPrices: priceLoader(db) },
    request.roomTypeId,
    request.ratePlanId,
    new Date(`${request.arrivalDate}T00:00:00Z`),
    new Date(`${request.departureDate}T00:00:00Z`)
  );
  return {
    ratePlanId: plan.id,
    roomTypeId: request.roomTypeId,
    currency: plan.currency,
    taxBasisPoints: plan.taxBasisPoints,
    ...quote,
  };
}
