import { describe, expect, it } from 'vitest';

import {
  buildDemoRestaurantSeed,
  DEMO_TIME_ZONE,
  demoRestaurantSeedCounts,
  parseDemoSeatCount,
  type DemoRestaurantSeed,
} from './seed-data';
import { resolveBusinessDate } from '@/lib/restaurant/business-date';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-09-04T12:00:00.000Z');
const seed = buildDemoRestaurantSeed(NOW, 1);
const repeatedSeed = buildDemoRestaurantSeed(NOW, 1);
const secondSeat = buildDemoRestaurantSeed(NOW, 2);

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizedSeat(seedValue: DemoRestaurantSeed): string {
  const seat = seedValue.identity.seatNumber;

  return JSON.stringify(seedValue, (key, value: unknown) => {
    if (key === 'seatNumber') return 0;
    if (key === 'email' || key === 'phone') return key;
    if (typeof value !== 'string') return value;

    return value
      .replaceAll(`demo_s${seat}_`, 'demo_s#_')
      .replaceAll(`seat_${seat}`, 'seat_#')
      .replaceAll(`seat-${seat}`, 'seat-#')
      .replaceAll(`seat${seat}`, 'seat#')
      .replaceAll(`Seat ${seat}`, 'Seat #')
      .replaceAll(`S${seat}-`, 'S#-');
  });
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

describe('buildDemoRestaurantSeed', () => {
  it('is deterministic and keeps seats logically identical with isolated identities', () => {
    expect(repeatedSeed).toEqual(seed);
    expect(secondSeat.identity).not.toEqual(seed.identity);
    expect(secondSeat.branches[0]?.id).not.toBe(seed.branches[0]?.id);
    expect(normalizedSeat(secondSeat) === normalizedSeat(seed)).toBe(true);
  });

  it('validates seat counts and the builder clock', () => {
    expect(parseDemoSeatCount(' 25 ')).toBe(25);
    for (const value of [0, 1.5, 26, '0', '1.5', 'twenty-five', Number.NaN]) {
      expect(() => parseDemoSeatCount(value)).toThrow(RangeError);
    }
    expect(() => buildDemoRestaurantSeed(new Date('invalid'))).toThrow(TypeError);
    expect(() => buildDemoRestaurantSeed('2026-09-04' as unknown as Date)).toThrow(TypeError);
  });

  it('anchors the pre-cutoff seed day to the current restaurant business date', () => {
    const preCutoffSeed = buildDemoRestaurantSeed(new Date('2026-09-04T22:05:00.000Z'), 5);
    const preCutoffSopDates = preCutoffSeed.operations.sopOccurrences
      .map((occurrence) => occurrence.scheduledFor.slice(0, 10))
      .sort();
    const middaySopDates = seed.operations.sopOccurrences
      .map((occurrence) => occurrence.scheduledFor.slice(0, 10))
      .sort();

    expect(preCutoffSeed.historicalBusinessDates).toEqual(seed.historicalBusinessDates);
    expect(preCutoffSopDates).toEqual(middaySopDates);
    expect(preCutoffSopDates.at(-1)).toBe('2026-09-04');
  });

  it('has the required descriptors, 90 business dates, purchasing window, and sales weights', () => {
    const counts = demoRestaurantSeedCounts(seed);
    expect(counts).toMatchObject({
      products: 40,
      ingredients: 60,
      suppliers: 6,
      loyaltyCustomers: 200,
      sopTemplates: 3,
      historicalBusinessDates: 90,
    });
    expect(counts.recipes).toBeGreaterThanOrEqual(25);
    expect(counts.historicalOrders).toBeGreaterThanOrEqual(1_200);
    expect(counts.historicalOrders).toBeLessThanOrEqual(2_000);

    const dates = seed.historicalBusinessDates;
    expect(new Set(dates).size).toBe(90);
    expect(daysBetween(dates[0]!, dates.at(-1)!)).toBe(89);
    expect(dates.at(-1)).toBe('2026-09-03');

    const coveredDateBranches = new Set(
      seed.sales.historicalOrders.map((order) => `${order.businessDate}:${order.branchId}`)
    );
    expect(coveredDateBranches.size).toBe(90 * 3);

    const purchaseDates = seed.purchasing.purchaseOrders
      .map((order) => order.orderedAt.slice(0, 10))
      .sort();
    expect(daysBetween(purchaseDates[0]!, dates.at(-1)!)).toBe(59);
    expect(purchaseDates.every((date) => dates.includes(date))).toBe(true);

    const ordersByDate = new Map(dates.map((date) => [date, 0]));
    for (const order of seed.sales.historicalOrders) {
      ordersByDate.set(order.businessDate, ordersByDate.get(order.businessDate)! + 1);
    }
    const weekend: number[] = [];
    const weekday: number[] = [];
    for (const [date, count] of ordersByDate) {
      ([0, 6].includes(new Date(`${date}T00:00:00.000Z`).getUTCDay()) ? weekend : weekday).push(
        count
      );
    }
    expect(average(weekend)).toBeGreaterThan(average(weekday) * 1.1);
    expect(
      seed.sales.historicalOrders.filter((order) => order.localHour >= 18).length /
        counts.historicalOrders
    ).toBeGreaterThan(0.6);
    expect(new Set(seed.sales.historicalOrders.map((order) => order.channel))).toEqual(
      new Set(['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
    );
  });

  it('uses coherent g, ml, and piece conversions and real low-stock balances', () => {
    const conversions = new Map(
      seed.inventory.unitConversions.map((conversion) => [
        `${conversion.fromUnit}:${conversion.toUnit}`,
        conversion.factor,
      ])
    );
    const ingredients = new Map(
      seed.inventory.ingredients.map((ingredient) => [ingredient.id, ingredient])
    );
    const recipeLines = seed.inventory.recipes.flatMap((recipe) => recipe.lines);
    expect(new Set(recipeLines.map((line) => line.unit))).toEqual(new Set(['g', 'ml', 'piece']));
    expect(Object.fromEntries(conversions)).toEqual({
      'g:kg': 0.001,
      'ml:litre': 0.001,
      'piece:piece': 1,
    });

    for (const line of recipeLines) {
      const ingredient = ingredients.get(line.ingredientId)!;
      const factor = conversions.get(`${line.unit}:${line.baseUnit}`)!;
      expect(line.baseUnit).toBe(ingredient.baseUnit);
      expect(line.baseQuantity).toBeCloseTo(line.quantity * factor, 8);
      expect(line.estimatedCostPkr).toBe(
        roundMoney(line.baseQuantity * ingredient.referenceCostPkr)
      );
    }

    const balances = new Map(
      seed.inventory.stockBalances.map((balance) => [
        `${balance.branchId}:${balance.ingredientId}`,
        balance,
      ])
    );
    const triggered = seed.inventory.lowStockRules.filter((rule) => rule.triggered);
    expect(triggered.length).toBeGreaterThan(0);
    for (const rule of seed.inventory.lowStockRules) {
      expect(rule.currentQuantity).toBe(
        balances.get(`${rule.branchId}:${rule.ingredientId}`)?.onHandQuantity
      );
      expect(rule.triggered).toBe(rule.currentQuantity < rule.thresholdQuantity);
    }
    expect(
      new Set(
        seed.operations.notifications
          .filter((notification) => notification.type === 'LOW_STOCK')
          .map((notification) => notification.subjectId)
      )
    ).toEqual(new Set(triggered.map((rule) => rule.id)));
  });

  it('keeps bills, tenders, refunds, and line arithmetic consistent', () => {
    const bills = new Map(seed.sales.bills.map((bill) => [bill.orderId, bill]));
    const variantPrices = new Map(
      seed.menu.products.flatMap((product) =>
        product.variants.map((variant) => [variant.id, variant.pricePkr] as const)
      )
    );
    const modifierPrices = new Map(
      seed.menu.modifierGroups.flatMap((group) =>
        group.options.map((option) => [option.id, option.pricePkr] as const)
      )
    );
    const settlements = new Map<string, typeof seed.sales.settlements>();
    for (const settlement of seed.sales.settlements) {
      settlements.set(settlement.orderId, [
        ...(settlements.get(settlement.orderId) ?? []),
        settlement,
      ]);
    }
    const refunds = new Map(seed.sales.refunds.map((refund) => [refund.orderId, refund]));
    const failures: string[] = [];

    for (const order of seed.sales.historicalOrders) {
      for (const line of order.lines) {
        const modifierTotal = line.modifiers.reduce((sum, modifier) => sum + modifier.pricePkr, 0);
        if (
          line.unitPricePkr !== variantPrices.get(line.variantId)! + modifierTotal ||
          line.lineTotalPkr !== line.unitPricePkr * line.quantity ||
          line.modifiers.some(
            (modifier) => modifier.pricePkr !== modifierPrices.get(modifier.optionId)
          )
        ) {
          failures.push(`${order.id}:line`);
        }
      }
      const subtotal = order.lines.reduce((sum, line) => sum + line.lineTotalPkr, 0);
      const total = subtotal - order.discountPkr + order.serviceChargePkr + order.taxPkr;
      const bill = bills.get(order.id);
      const tenderTotal = (settlements.get(order.id) ?? []).reduce(
        (sum, settlement) => sum + settlement.amountPkr,
        0
      );
      if (
        subtotal !== order.subtotalPkr ||
        total !== order.totalPkr ||
        !bill ||
        bill.totalPkr !== order.totalPkr ||
        tenderTotal !== bill.totalPkr
      ) {
        failures.push(`${order.id}:bill`);
      }
      const refund = refunds.get(order.id);
      if (
        (refund && bill?.status !== 'PARTIALLY_REFUNDED') ||
        (!refund && bill?.status !== 'SETTLED')
      ) {
        failures.push(`${order.id}:refund-status`);
      }
    }

    for (const refund of seed.sales.refunds) {
      const settlement = seed.sales.settlements.find((item) => item.id === refund.settlementId);
      if (
        !settlement ||
        settlement.orderId !== refund.orderId ||
        settlement.billId !== refund.billId ||
        refund.amountPkr <= 0 ||
        refund.amountPkr >= settlement.amountPkr
      ) {
        failures.push(`${refund.id}:refund`);
      }
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });

  it('provides live KDS/payment artifacts and a non-overlapping roster', () => {
    const liveOrders = new Map(seed.sales.liveOrders.map((order) => [order.id, order]));
    expect(seed.sales.kdsTickets).toHaveLength(1);
    const ticket = seed.sales.kdsTickets[0]!;
    const kitchenOrder = liveOrders.get(ticket.orderId)!;
    expect(kitchenOrder.status).toBe('IN_PREPARATION');
    expect(new Set(ticket.orderLineIds)).toEqual(
      new Set(kitchenOrder.lines.map((line) => line.id))
    );

    const paymentPending = seed.sales.liveOrders.filter(
      (order) => order.status === 'PAYMENT_PENDING'
    );
    expect(paymentPending).toHaveLength(1);
    expect(paymentPending[0]?.branchId).toBe(seed.branches[0]?.id);
    expect(paymentPending[0]?.bill.status).toBe('PAYMENT_PENDING');
    expect(paymentPending[0]?.bill.totalPkr).toBe(paymentPending[0]?.totalPkr);

    const shiftsByStaff = new Map<string, typeof seed.workforce.roster>();
    for (const shift of seed.workforce.roster) {
      shiftsByStaff.set(shift.staffId, [...(shiftsByStaff.get(shift.staffId) ?? []), shift]);
    }
    const overlaps: string[] = [];
    for (const [staffId, shifts] of shiftsByStaff) {
      shifts.sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
      for (let index = 0; index < shifts.length; index += 1) {
        const shift = shifts[index]!;
        if (Date.parse(shift.startsAt) >= Date.parse(shift.endsAt)) overlaps.push(staffId);
        if (index > 0 && Date.parse(shift.startsAt) < Date.parse(shifts[index - 1]!.endsAt)) {
          overlaps.push(staffId);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('keeps the KDS order on the seed business date across the 05:00 cutoff', () => {
    const cutoffSeed = buildDemoRestaurantSeed(new Date('2026-09-05T00:04:00.000Z'), 1);
    const ticket = cutoffSeed.sales.kdsTickets[0]!;
    const order = cutoffSeed.sales.liveOrders.find((item) => item.id === ticket.orderId)!;

    expect(resolveBusinessDate(new Date(order.openedAt), DEMO_TIME_ZONE, '05:00')).toBe(
      resolveBusinessDate(new Date(cutoffSeed.generatedAt), DEMO_TIME_ZONE, '05:00')
    );
  });
});
