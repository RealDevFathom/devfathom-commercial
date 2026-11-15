import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { saleTotalMinor } from './settlement';

/**
 * DEV-63: delivery order profitability by radius band.
 *
 * Revenue and cost of goods come from the completed counter sale behind each
 * delivered order, net of discounts and later returns. The delivery cost is an
 * ESTIMATE built only from the owner's own assumptions (fixed cost per order,
 * cost per km, band edges); nothing here carries a built-in figure. An order dispatched without a recorded distance is
 * reported apart, never placed in a band by guess.
 */

/** Matches the database CHECK on pharmacy_customer_orders.deliveryDistanceMeters. */
export const MAX_DELIVERY_DISTANCE_METERS = 200_000;

export type DeliveryRadiusAssumptions = Readonly<{
  /** Ascending band edges in metres, e.g. [2000, 5000]: 0–2 km, 2–5 km, 5 km+. */
  bandEdgesMeters: readonly number[];
  costPerKmMinor: number;
  fixedCostPerOrderMinor: number;
}>;

export type DeliveryRadiusOrder = Readonly<{
  orderId: string;
  distanceMeters: number | null;
  revenueMinor: number;
  cogsMinor: number;
}>;

type Totals = {
  orders: number;
  revenueMinor: number;
  cogsMinor: number;
  grossMarginMinor: number;
};

export type DeliveryRadiusBand = Totals &
  Readonly<{
    fromMeters: number;
    /** Null for the open-ended outer band. */
    toMeters: number | null;
    estimatedDeliveryCostMinor: number;
    contributionMinor: number;
    /** Rounded down to whole minor units; null with no orders. */
    contributionPerOrderMinor: number | null;
    profitable: boolean | null;
  }>;

export type DeliveryRadiusReport = Readonly<{
  basis: 'ESTIMATE';
  assumptions: DeliveryRadiusAssumptions;
  bands: readonly DeliveryRadiusBand[];
  unknownDistance: Totals;
}>;

export class DeliveryRadiusAssumptionError extends Error {}

function validate(assumptions: DeliveryRadiusAssumptions) {
  const edges = assumptions.bandEdgesMeters;
  if (
    !edges.length ||
    edges.some(
      (edge, i) => !Number.isSafeInteger(edge) || edge <= 0 || (i > 0 && edge <= edges[i - 1]!)
    )
  )
    throw new DeliveryRadiusAssumptionError('Band edges must be ascending positive whole metres.');
  for (const value of [assumptions.costPerKmMinor, assumptions.fixedCostPerOrderMinor])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new DeliveryRadiusAssumptionError(
        'Delivery cost assumptions must be whole minor units.'
      );
}

const empty = (): Totals => ({ orders: 0, revenueMinor: 0, cogsMinor: 0, grossMarginMinor: 0 });

function add(totals: Totals, order: DeliveryRadiusOrder) {
  totals.orders += 1;
  totals.revenueMinor += order.revenueMinor;
  totals.cogsMinor += order.cogsMinor;
  totals.grossMarginMinor += order.revenueMinor - order.cogsMinor;
}

export function deliveryRadiusProfitability(
  orders: readonly DeliveryRadiusOrder[],
  assumptions: DeliveryRadiusAssumptions
): DeliveryRadiusReport {
  validate(assumptions);
  const edges = assumptions.bandEdgesMeters;
  const bands = [0, ...edges].map((fromMeters, i) => ({
    ...empty(),
    fromMeters,
    toMeters: edges[i] ?? null,
    estimatedDeliveryCostMinor: 0,
  }));
  const unknownDistance = empty();
  for (const order of orders) {
    if (order.distanceMeters === null || order.distanceMeters < 0) {
      add(unknownDistance, order);
      continue;
    }
    const band = bands.find((b) => b.toMeters === null || order.distanceMeters! < b.toMeters)!;
    add(band, order);
    band.estimatedDeliveryCostMinor +=
      assumptions.fixedCostPerOrderMinor +
      Math.round((assumptions.costPerKmMinor * order.distanceMeters) / 1000);
  }
  return {
    basis: 'ESTIMATE',
    assumptions,
    bands: bands.map((band) => {
      const contributionMinor = band.grossMarginMinor - band.estimatedDeliveryCostMinor;
      return {
        ...band,
        contributionMinor,
        contributionPerOrderMinor: band.orders ? Math.floor(contributionMinor / band.orders) : null,
        profitable: band.orders ? contributionMinor > 0 : null,
      };
    }),
    unknownDistance,
  };
}

/** Completed delivery orders for one branch, with revenue and COGS from their sale. */
export async function loadDeliveryRadiusOrders(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  period: { from: Date; to: Date }
): Promise<DeliveryRadiusOrder[]> {
  const orders = await db.pharmacyCustomerOrder.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      fulfillment: 'DELIVER',
      status: 'COMPLETED',
      completedAt: { gte: period.from, lt: period.to },
    },
    select: {
      id: true,
      deliveryDistanceMeters: true,
      counterSale: {
        select: {
          lines: {
            select: {
              quantity: true,
              unitPriceMinor: true,
              grossMinor: true,
              discountMinor: true,
              unitCostMinor: true,
              canonicalUnits: true,
              returnLines: {
                select: { canonicalUnits: true, grossMinor: true, discountMinor: true },
              },
            },
          },
        },
      },
    },
    orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
  });
  return orders.map((order) => {
    const lines = order.counterSale?.lines ?? [];
    return {
      orderId: order.id,
      distanceMeters: order.deliveryDistanceMeters,
      revenueMinor: lines.reduce((total, line) => total + netLineRevenue(line), 0),
      cogsMinor: lines.reduce((total, line) => total + netLineCost(line), 0),
    };
  });
}

type ReportedSaleLine = {
  quantity: number;
  unitPriceMinor: number;
  grossMinor: number;
  discountMinor: number;
  unitCostMinor: number;
  canonicalUnits: number;
  returnLines: {
    canonicalUnits: number;
    grossMinor: number | null;
    discountMinor: number | null;
  }[];
};

function returnedShare(line: ReportedSaleLine, amount: number) {
  const returned = line.returnLines.reduce((total, row) => total + row.canonicalUnits, 0);
  if (!returned || line.canonicalUnits <= 0) return 0;
  return Math.floor((amount * Math.min(returned, line.canonicalUnits)) / line.canonicalUnits);
}

/** Net of discounts and of later returns, using the return's own recorded money when present. */
function netLineRevenue(line: ReportedSaleLine) {
  const net = saleTotalMinor([line]);
  const recorded = line.returnLines.every(
    (row) => row.grossMinor !== null && row.discountMinor !== null
  );
  const returned = recorded
    ? line.returnLines.reduce(
        (total, row) => total + (row.grossMinor ?? 0) - (row.discountMinor ?? 0),
        0
      )
    : returnedShare(line, net);
  return net - returned;
}

/** Cost of the units kept by the customer; returned units go back to stock. */
function netLineCost(line: ReportedSaleLine) {
  const cost = line.unitCostMinor * line.quantity;
  return cost - returnedShare(line, cost);
}
