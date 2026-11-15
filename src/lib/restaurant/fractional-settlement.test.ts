// No DB client: real FRACTIONAL bill planning, settlement quote, tender and settlement
// validation against in-memory delegates (DEV-771). Persistence, RLS and rollback
// require the database-backed suites.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  evaluateOrderSettlement,
  finalizeBillSettlement,
  planBills,
  type FinalizeBillSettlementInput,
} from './bills';
import { applyTenderInTransaction, quoteOpenBillSettlement } from './tenders';

vi.mock('./bills', async (original) => ({
  ...(await original<typeof import('./bills')>()),
  finalizeBillSettlement: vi.fn(),
}));
vi.mock('./loyalty', () => ({
  reverseLoyaltyForRefund: vi.fn(),
  earnLoyaltyForClosedOrder: vi.fn(),
}));
vi.mock('./inventory', () => ({ postOrderRecipeConsumption: vi.fn() }));
vi.mock('./outbox', () => ({ appendOrderEvent: vi.fn() }));

const D = (value: string) => new Prisma.Decimal(value);
const NOW = new Date('2026-09-11T12:00:00Z');
const BUSINESS_DATE = new Date('2026-09-11T00:00:00Z');
const PERSISTENCE_REACHED = 'settlement validation passed; persistence reached';

type Item = { id: string; unitPrice: string; quantity: number; modifiers?: string[] };
type TaxMode = { priceMode: 'EXCLUSIVE' | 'INCLUSIVE'; rate: string };
const sum = (values: Prisma.Decimal[]) =>
  values.reduce((total, value) => total.plus(value), D('0'));

function fixture(items: Item[], weights: number[], tax: TaxMode) {
  const orderItems = items.map((item) => ({
    id: item.id,
    status: 'SERVED',
    remakeOfItemId: null,
    seatNumber: null,
    name: item.id,
    unitPrice: D(item.unitPrice),
    quantity: item.quantity,
    modifiers: (item.modifiers ?? []).map((priceDelta) => ({ priceDelta: D(priceDelta) })),
  }));
  const planned = planBills(
    {
      id: 'order',
      branchId: 'branch',
      status: 'PAYMENT_PENDING',
      businessDate: BUSINESS_DATE,
      items: orderItems,
    },
    { kind: 'FRACTIONAL', weights }
  );
  const bills = planned.map((plan, index) => ({
    id: `bill-${index}`,
    organizationId: 'tenant',
    orderId: 'order',
    branchId: 'branch',
    businessDate: BUSINESS_DATE,
    status: 'OPEN',
    splitKind: 'FRACTIONAL' as const,
    fractionNumerator: plan.fractionNumerator,
    fractionDenominator: plan.fractionDenominator,
    subtotal: plan.subtotal,
    compTotal: D('0'),
    discountTotal: D('0'),
    taxTotal: D('0'),
    serviceChargeTotal: D('0'),
    serviceChargePolicyVersionId: null,
    serviceChargeRate: null,
    serviceChargeBasis: D('0'),
    serviceChargeTaxTreatment: null,
    deliveryFeeTotal: D('0'),
    roundingAdjustment: plan.roundingAdjustment,
    grandTotal: plan.grandTotal,
    createdAt: NOW,
    lines: [],
  }));
  const byId = new Map(bills.map((bill) => [bill.id, bill] as const));
  const tenders: Array<{
    id: string;
    billId: string;
    type: string;
    amount: Prisma.Decimal;
    createdAt: Date;
  }> = [];
  const finalized: FinalizeBillSettlementInput[] = [];
  const effective = {
    effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    effectiveTo: null,
    status: 'PUBLISHED',
    approvalReference: 'SYNTHETIC_TEST_APPROVAL',
    approvedAt: new Date('2026-08-01T00:00:00Z'),
  };
  const raw = {
    $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
    $executeRaw: vi.fn(async () => 1),
    restaurantMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    restaurantBill: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => byId.get(where.id) ?? null),
      findMany: vi.fn(async () =>
        bills.map((bill) => ({
          ...bill,
          receiptNumber: null,
          tenders: tenders.filter((tender) => tender.billId === bill.id),
        }))
      ),
    },
    restaurantTender: {
      findMany: vi.fn(async ({ where }: { where: { billId: string } }) =>
        tenders.filter((tender) => tender.billId === where.billId)
      ),
      create: vi.fn(
        async ({ data }: { data: { billId: string; type: string; amount: Prisma.Decimal } }) => {
          const row = { ...data, id: `tender-${tenders.length + 1}`, createdAt: NOW };
          tenders.push(row);
          return row;
        }
      ),
    },
    restaurantOrderItem: {
      findMany: vi.fn(async () =>
        [...orderItems]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(({ id, quantity, unitPrice, modifiers }) => ({ id, quantity, unitPrice, modifiers }))
      ),
    },
    restaurantOrder: {
      findUnique: vi.fn(async () => ({
        id: 'order',
        branchId: 'branch',
        status: 'PAYMENT_PENDING',
        channel: 'DINE_IN',
        items: orderItems.map(({ id, status }) => ({ id, status })),
      })),
      findFirst: vi.fn(async () => ({
        id: 'order',
        branchId: 'branch',
        status: 'PAYMENT_PENDING',
        businessDate: BUSINESS_DATE,
        serviceChargePolicyVersion: null,
        deliveryFulfillment: null,
        items: orderItems,
      })),
      update: vi.fn(async () => undefined),
      count: vi.fn(async () => 0),
    },
    restaurantOrderTable: { updateMany: vi.fn(async () => ({ count: 1 })) },
    restaurantRegisteredDevice: {
      findFirst: vi.fn(async () => ({
        branchId: 'branch',
        branch: { timezone: 'Asia/Karachi', businessDayCutoff: '04:00' },
      })),
    },
    restaurantBranch: {
      findUnique: vi.fn(async () => ({
        organizationId: 'tenant',
        timezone: 'Asia/Karachi',
        businessDayCutoff: '04:00',
      })),
    },
    restaurantDailyClose: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    organization: { findUnique: vi.fn(async () => ({ currency: 'PKR' })) },
    restaurantTaxProfileVersion: {
      findMany: vi.fn(async () => [
        {
          id: 'profile',
          ...effective,
          rules: ['CASH', 'CARD', 'OTHER'].map((paymentCategory) => ({
            id: `rule-${paymentCategory}`,
            profileVersionId: 'profile',
            paymentCategory,
            priceMode: tax.priceMode,
            rate: D(tax.rate),
            ...effective,
            officialSource: { expiresAt: new Date('2027-08-01T00:00:00Z') },
          })),
        },
      ]),
    },
    restaurantBillLine: { findMany: vi.fn(async () => []) },
    restaurantPromotionBillApplicationSnapshot: { findMany: vi.fn(async () => []) },
    restaurantTaxTransactionSnapshot: {
      findMany: vi.fn(async () =>
        finalized.map((input, index) => ({
          id: `snapshot-${index}`,
          billId: input.billId,
          settledAt: NOW,
          createdAt: NOW,
          reversesSnapshotId: null,
          reversals: [],
          taxTotal: input.taxTotal,
          buckets: [],
          profile: { rules: [{ priceMode: tax.priceMode }] },
        }))
      ),
    },
    restaurantPayment: { create: vi.fn(async () => ({ id: 'payment' })) },
    restaurantPaymentEvent: { create: vi.fn(async () => ({ id: 'event' })) },
  };
  const db = raw as unknown as ScopedDb;
  vi.mocked(finalizeBillSettlement).mockImplementation(async (_tx, input) => {
    finalized.push(input);
    Object.assign(byId.get(input.billId)!, {
      status: 'SETTLED',
      subtotal: input.subtotal,
      taxTotal: input.taxTotal,
      discountTotal: input.discountTotal,
      roundingAdjustment: input.roundingAdjustment,
      grandTotal: input.grandTotal,
    });
    return { receiptNumber: finalized.length, alreadySettled: false } as never;
  });

  /** Run the real settlement validation for one captured final input; it must get past
   * every reconciliation guard and reach the first persistence write. */
  async function validateFinalization(input: FinalizeBillSettlementInput) {
    const actual = await vi.importActual<typeof import('./bills')>('./bills');
    const bill = { ...byId.get(input.billId)!, status: 'OPEN' };
    const tx = {
      restaurantBill: { findUnique: vi.fn(async () => bill) },
      restaurantTender: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => {
        throw new Error(PERSISTENCE_REACHED);
      }),
    } as unknown as ScopedDb;
    await expect(actual.finalizeBillSettlement(tx, input)).rejects.toThrow(PERSISTENCE_REACHED);
  }

  async function payEveryBill() {
    const quotes = [];
    for (const [index, bill] of bills.entries()) {
      const quote = await quoteOpenBillSettlement(db, bill.id, NOW);
      expect(quote).not.toBeNull();
      quotes.push(quote!);
      const result = await applyTenderInTransaction(db, {
        billId: bill.id,
        branchId: 'branch',
        actor: { staffProfileId: 'operator', deviceId: 'device', idempotencyKey: `pay-${index}` },
        now: NOW,
        tender: { type: 'OTHER', amount: quote!.remainingDue.toFixed(2) },
      });
      expect(result.settled).toBe(true);
      expect(result.remainingDue.toFixed(2)).toBe('0.00');
    }
    for (const input of finalized) await validateFinalization(input);
    // The last final tender closed the order only because the order-level settlement
    // reconciled every bill against the derived order total.
    expect(raw.restaurantOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CLOSED' }) })
    );
    const settlement = await evaluateOrderSettlement(db, 'order');
    expect(settlement).toMatchObject({ settled: true, blocker: null });
    expect(settlement.accountedTotal.toFixed(2)).toBe(settlement.derivedOrderTotal.toFixed(2));
    return quotes;
  }

  return { planned, bills, tenders, finalized, payEveryBill };
}

beforeEach(() => vi.clearAllMocks());

describe('FRACTIONAL bills conserve remainder cents through quote and settlement (DEV-771)', () => {
  it('quotes and settles 10.01 split [1,1,1] at exactly the cut amounts', async () => {
    const f = fixture([{ id: 'item-a', unitPrice: '10.01', quantity: 1 }], [1, 1, 1], {
      priceMode: 'EXCLUSIVE',
      rate: '0',
    });
    expect(f.planned.map((bill) => bill.grandTotal.toFixed(2))).toEqual(['3.34', '3.34', '3.33']);

    const quotes = await f.payEveryBill();

    expect(quotes.map((quote) => quote.grandTotal.toFixed(2))).toEqual(['3.34', '3.34', '3.33']);
    expect(quotes.map((quote) => quote.tax.toFixed(2))).toEqual(['0.00', '0.00', '0.00']);
    expect(sum(f.tenders.map((tender) => tender.amount)).toFixed(2)).toBe('10.01');
    expect(f.finalized.map((input) => input.grandTotal.toFixed(2))).toEqual([
      '3.34',
      '3.34',
      '3.33',
    ]);
    expect(sum(f.finalized.map((input) => input.grandTotal)).toFixed(2)).toBe('10.01');
  });

  it('conserves multi-item, multi-quantity orders with unequal weights', async () => {
    const f = fixture(
      [
        { id: 'item-a', unitPrice: '10.01', quantity: 1 },
        { id: 'item-b', unitPrice: '0.07', quantity: 3, modifiers: ['0.01'] },
        { id: 'item-c', unitPrice: '1.00', quantity: 2 },
      ],
      [2, 1, 4],
      { priceMode: 'EXCLUSIVE', rate: '0' }
    );
    const cut = f.planned.map((bill) => bill.grandTotal.toFixed(2));
    expect(sum(f.planned.map((bill) => bill.grandTotal)).toFixed(2)).toBe('12.25');

    const quotes = await f.payEveryBill();

    expect(quotes.map((quote) => quote.grandTotal.toFixed(2))).toEqual(cut);
    expect(sum(f.tenders.map((tender) => tender.amount)).toFixed(2)).toBe('12.25');
    expect(sum(f.finalized.map((input) => input.grandTotal)).toFixed(2)).toBe('12.25');
  });

  it('conserves the pre-tax order total under exclusive tax', async () => {
    const f = fixture([{ id: 'item-a', unitPrice: '10.01', quantity: 1 }], [1, 1, 1], {
      priceMode: 'EXCLUSIVE',
      rate: '0.16',
    });

    const quotes = await f.payEveryBill();

    expect(quotes.map((quote) => quote.grandTotal.minus(quote.tax).toFixed(2))).toEqual([
      '3.34',
      '3.34',
      '3.33',
    ]);
    expect(quotes.every((quote) => quote.tax.greaterThan(0))).toBe(true);
    expect(sum(f.tenders.map((tender) => tender.amount)).toFixed(2)).toBe(
      sum(quotes.map((quote) => quote.grandTotal)).toFixed(2)
    );
    expect(sum(f.finalized.map((input) => input.grandTotal.minus(input.taxTotal))).toFixed(2)).toBe(
      '10.01'
    );
  });

  it('conserves the order total under inclusive tax', async () => {
    const f = fixture([{ id: 'item-a', unitPrice: '10.01', quantity: 1 }], [1, 1, 1], {
      priceMode: 'INCLUSIVE',
      rate: '0.16',
    });

    const quotes = await f.payEveryBill();

    expect(quotes.map((quote) => quote.grandTotal.toFixed(2))).toEqual(['3.34', '3.34', '3.33']);
    expect(quotes.every((quote) => quote.tax.greaterThan(0))).toBe(true);
    expect(sum(f.tenders.map((tender) => tender.amount)).toFixed(2)).toBe('10.01');
    expect(sum(f.finalized.map((input) => input.grandTotal)).toFixed(2)).toBe('10.01');
  });
});
