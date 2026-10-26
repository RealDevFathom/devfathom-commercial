/**
 * M5-L2 bill command layer.
 *
 * Two layers of checks:
 *   1. PURE split-exactness property tests over `planBills` / `deriveOrderTotal` —
 *      no database. BY_ITEM/BY_SEAT partition completeness; FRACTIONAL Σ(grandTotal)
 *      ≡ order total by Decimal STRING equality on adversarial remainders; identical
 *      input → identical per-bill cents across runs (deterministic remainder, C4).
 *   2. DB-backed integration tests (require TEST_DATABASE_URL — a migrated throwaway
 *      database, never DATABASE_URL): cut/split persistence, comp-at-zero (snapshot
 *      price retained + reason + co-auth), the re-split guard, settleBill + receipt
 *      allocation, the settlement predicate, and money-key idempotency.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  deriveOrderTotal,
  evaluateOrderSettlement,
  exclusiveTaxFromSettlementSnapshots,
  exclusiveTaxOutsideOrderTotal,
  planBills,
  validateTenderTaxAllocations,
} from './bills';
import type { SettlementTaxSnapshot } from './bills';
import type { FinalizeBillSettlementInput } from './bills';

// ── Pure fixtures ────────────────────────────────────────────────────────────

const D = (v: string | number) => new Prisma.Decimal(v);

describe('tender tax allocation validation', () => {
  const merchandise = {
    id: 'bucket-unit',
    allocationKind: 'MERCHANDISE' as const,
    billLineId: 'line-1',
    unitOrdinal: 0,
    ruleVersionId: 'rule-card',
    paymentCategory: 'CARD' as const,
    taxAmount: D('1.20'),
  };
  const service = {
    id: 'bucket-service',
    allocationKind: 'SERVICE_CHARGE' as const,
    ruleVersionId: 'rule-card',
    paymentCategory: 'CARD' as const,
    taxAmount: D('0.10'),
  };
  const allocations = [
    {
      originalTenderId: 'tender-a',
      paymentCategory: 'CARD' as const,
      bucket: merchandise,
      cents: 70,
    },
    {
      originalTenderId: 'tender-b',
      paymentCategory: 'CARD' as const,
      bucket: merchandise,
      cents: 50,
    },
    {
      originalTenderId: 'tender-a',
      paymentCategory: 'CARD' as const,
      bucket: service,
      cents: 5,
    },
    {
      originalTenderId: 'tender-b',
      paymentCategory: 'CARD' as const,
      bucket: service,
      cents: 5,
    },
  ];

  it('accepts two same-category tenders split across unit and service buckets', () => {
    expect(() =>
      validateTenderTaxAllocations(allocations, [merchandise, service], D('1.30'))
    ).not.toThrow();
  });

  it.each([
    ['negative cents', [{ ...allocations[0]!, cents: -1 }, ...allocations.slice(1)]],
    ['missing bucket allocation', allocations.slice(0, 2)],
    ['duplicate fact', [...allocations, allocations[0]!]],
    [
      'mismatched category',
      [{ ...allocations[0]!, paymentCategory: 'CASH' as const }, ...allocations.slice(1)],
    ],
    [
      'missing bucket identity',
      [{ ...allocations[0]!, bucket: { ...merchandise, unitOrdinal: 9 } }, ...allocations.slice(1)],
    ],
    ['bucket mismatch', [{ ...allocations[0]!, cents: 69 }, ...allocations.slice(1)]],
  ])('rejects %s', (_label, invalid) => {
    expect(() => validateTenderTaxAllocations(invalid, [merchandise, service], D('1.30'))).toThrow(
      'Tender tax allocation'
    );
  });
});

/** Build a minimal LoadedBillOrder-shaped literal for the pure planners. */
function order(
  items: Array<{
    id: string;
    unitPrice: string;
    quantity?: number;
    seatNumber?: number | null;
    status?: string;
    modifiers?: string[];
  }>
) {
  return {
    id: 'o1',
    branchId: 'b1',
    status: 'OPEN',
    businessDate: new Date('2026-08-19T00:00:00.000Z'),
    items: items.map((i) => ({
      id: i.id,
      status: i.status ?? 'SERVED',
      seatNumber: i.seatNumber ?? null,
      name: i.id,
      unitPrice: D(i.unitPrice),
      quantity: i.quantity ?? 1,
      modifiers: (i.modifiers ?? []).map((m) => ({ priceDelta: D(m) })),
    })),
  };
}

function withServiceCharge<T extends ReturnType<typeof order>>(value: T, rate = '0.100000') {
  return {
    ...value,
    serviceChargePolicyVersion: { id: 'service-policy-v1', rate: D(rate) },
  };
}

describe('deriveOrderTotal (pure, C4)', () => {
  it('sums (unitPrice + Σ modifier deltas) × quantity over non-voided items', () => {
    const o = order([
      { id: 'a', unitPrice: '12.50', quantity: 2, modifiers: ['1.00'] }, // (12.50+1)*2 = 27.00
      { id: 'b', unitPrice: '4.25', quantity: 1 }, // 4.25
      { id: 'c', unitPrice: '9.99', quantity: 1, status: 'VOIDED' }, // excluded
    ]);
    expect(deriveOrderTotal(o.items.filter((i) => i.status !== 'VOIDED')).toString()).toBe('31.25');
  });
});

describe('exclusiveTaxOutsideOrderTotal', () => {
  it('subtracts only exclusive bucket tax, which is what settlement adds to grandTotal', () => {
    expect(
      exclusiveTaxOutsideOrderTotal({
        taxTotal: D('6.50'),
        buckets: [
          { priceMode: 'EXCLUSIVE', taxAmount: D('1.50') },
          { priceMode: 'INCLUSIVE', taxAmount: D('5.00') },
        ],
        rulePriceModes: ['EXCLUSIVE', 'INCLUSIVE'],
      }).toString()
    ).toBe('1.5');
  });

  it('uses the snapshot tax when a bucket-less fractional bill is uniformly exclusive', () => {
    expect(
      exclusiveTaxOutsideOrderTotal({
        taxTotal: D('145.50'),
        buckets: [],
        rulePriceModes: ['EXCLUSIVE', 'EXCLUSIVE'],
      }).toString()
    ).toBe('145.5');
    expect(
      exclusiveTaxOutsideOrderTotal({
        taxTotal: D('10.00'),
        buckets: [],
        rulePriceModes: ['INCLUSIVE'],
      }).toString()
    ).toBe('0');
  });
});

function settlementSnapshot(input: {
  id: string;
  tax: string;
  settledAt: string;
  reversesSnapshotId?: string;
  reversals?: readonly { id: string }[];
}): SettlementTaxSnapshot {
  return {
    id: input.id,
    billId: 'bill-1',
    settledAt: new Date(input.settledAt),
    createdAt: new Date(input.settledAt),
    reversesSnapshotId: input.reversesSnapshotId ?? null,
    reversals: input.reversals ?? [],
    taxTotal: D(input.tax),
    buckets: [{ priceMode: 'EXCLUSIVE', taxAmount: D(input.tax) }],
    profile: { rules: [{ priceMode: 'EXCLUSIVE' }] },
  };
}

describe('exclusiveTaxFromSettlementSnapshots', () => {
  const reversedAndRefrozen = [
    settlementSnapshot({
      id: 'original',
      tax: '145.50',
      settledAt: '2026-08-01T12:00:00.000Z',
      reversals: [{ id: 'reversal' }],
    }),
    settlementSnapshot({
      id: 'reversal',
      tax: '-145.50',
      settledAt: '2026-08-01T12:05:00.000Z',
      reversesSnapshotId: 'original',
    }),
    settlementSnapshot({
      id: 'refreeze',
      tax: '145.50',
      settledAt: '2026-08-01T12:10:00.000Z',
    }),
  ];

  it('subtracts a reversed and re-frozen exclusive tax once', () => {
    const totals = exclusiveTaxFromSettlementSnapshots(reversedAndRefrozen);
    expect(totals.size).toBe(1);
    expect(totals.get('bill-1')?.toString()).toBe('145.5');
  });

  it('keeps the order settled when that tax would otherwise be subtracted twice', async () => {
    const db = {
      restaurantOrder: {
        findFirst: async () => ({
          id: 'order-1',
          branchId: 'branch-1',
          status: 'PAYMENT_PENDING',
          businessDate: new Date('2026-08-01T00:00:00.000Z'),
          serviceChargePolicyVersion: null,
          deliveryFulfillment: null,
          items: [
            {
              id: 'item-1',
              status: 'SERVED',
              seatNumber: null,
              name: 'Chicken Karahi',
              unitPrice: D('970.00'),
              quantity: 1,
              modifiers: [],
            },
          ],
        }),
      },
      restaurantBill: {
        findMany: async () => [
          {
            id: 'bill-1',
            status: 'SETTLED',
            splitKind: 'NONE',
            grandTotal: D('1115.50'),
            serviceChargeTotal: D('0.00'),
            deliveryFeeTotal: D('0.00'),
            compTotal: D('0.00'),
            discountTotal: D('0.00'),
            taxTotal: D('145.50'),
            receiptNumber: 1,
            lines: [{ orderItemId: 'item-1' }],
            tenders: [{ amount: D('1115.50') }],
          },
        ],
      },
      restaurantTaxTransactionSnapshot: {
        findMany: async () => reversedAndRefrozen,
      },
    } as unknown as ScopedDb;

    const settlement = await evaluateOrderSettlement(db, 'order-1');
    expect(settlement.settled).toBe(true);
    expect(settlement.blocker).toBeNull();
    expect(settlement.accountedTotal.toString()).toBe('970');
    expect(settlement.accountedTotal.toString()).toBe(settlement.derivedOrderTotal.toString());
  });

  it('uses only the latest live snapshot when two freezes are both still in force', () => {
    const totals = exclusiveTaxFromSettlementSnapshots([
      settlementSnapshot({
        id: 'older',
        tax: '10.00',
        settledAt: '2026-08-01T12:00:00.000Z',
      }),
      settlementSnapshot({
        id: 'newer',
        tax: '1.50',
        settledAt: '2026-08-01T12:10:00.000Z',
      }),
    ]);
    expect(totals.get('bill-1')?.toString()).toBe('1.5');
  });
});

describe('evaluateOrderSettlement reconciliation', () => {
  function settlementDb(input: {
    grandTotal: string;
    compTotal?: string;
    serviceChargeTotal: string;
    taxTotal?: string;
    exclusiveTax?: string;
    voidServiceChargeTotal?: string;
  }): ScopedDb {
    return {
      restaurantOrder: {
        findFirst: async () =>
          withServiceCharge(
            order([
              { id: 'item-1', unitPrice: '40.00' },
              { id: 'item-2', unitPrice: '60.00' },
            ])
          ),
      },
      restaurantBill: {
        findMany: async () => [
          {
            id: 'bill-1',
            status: 'SETTLED',
            splitKind: 'NONE',
            grandTotal: D(input.grandTotal),
            serviceChargeTotal: D(input.serviceChargeTotal),
            deliveryFeeTotal: D('0'),
            compTotal: D(input.compTotal ?? '0'),
            discountTotal: D('0'),
            taxTotal: D(input.taxTotal ?? '0'),
            receiptNumber: 1,
            lines: [{ orderItemId: 'item-1' }, { orderItemId: 'item-2' }],
            tenders: [{ amount: D(input.grandTotal) }],
          },
          ...(input.voidServiceChargeTotal
            ? [
                {
                  id: 'bill-void',
                  status: 'VOID',
                  splitKind: 'NONE',
                  grandTotal: D('0'),
                  serviceChargeTotal: D(input.voidServiceChargeTotal),
                  deliveryFeeTotal: D('0'),
                  compTotal: D('0'),
                  discountTotal: D('0'),
                  taxTotal: D('0'),
                  receiptNumber: null,
                  lines: [],
                  tenders: [],
                },
              ]
            : []),
        ],
      },
      restaurantTaxTransactionSnapshot: {
        findMany: async () =>
          input.exclusiveTax
            ? [
                settlementSnapshot({
                  id: 'snapshot-1',
                  tax: input.exclusiveTax,
                  settledAt: '2026-08-01T12:00:00.000Z',
                }),
              ]
            : [],
      },
    } as unknown as ScopedDb;
  }

  it('accepts a partial comp after service is removed from the comped line', async () => {
    const settlement = await evaluateOrderSettlement(
      settlementDb({ grandTotal: '66.00', compTotal: '40.00', serviceChargeTotal: '6.00' }),
      'order-1'
    );

    expect(settlement.settled).toBe(true);
    expect(settlement.blocker).toBeNull();
    expect(settlement.accountedTotal.toString()).toBe('106');
    expect(settlement.derivedOrderTotal.toString()).toBe('106');
  });

  it('accepts exclusive tax added on top of merchandise and service', async () => {
    const settlement = await evaluateOrderSettlement(
      settlementDb({
        grandTotal: '125.00',
        serviceChargeTotal: '10.00',
        taxTotal: '15.00',
        exclusiveTax: '15.00',
      }),
      'order-1'
    );

    expect(settlement.settled).toBe(true);
    expect(settlement.blocker).toBeNull();
    expect(settlement.accountedTotal.toString()).toBe('110');
    expect(settlement.derivedOrderTotal.toString()).toBe('110');
  });

  it('does not restore service from a voided bill', async () => {
    const settlement = await evaluateOrderSettlement(
      settlementDb({
        grandTotal: '66.00',
        compTotal: '40.00',
        serviceChargeTotal: '6.00',
        voidServiceChargeTotal: '4.00',
      }),
      'order-1'
    );

    expect(settlement.settled).toBe(true);
    expect(settlement.accountedTotal.toString()).toBe('106');
    expect(settlement.derivedOrderTotal.toString()).toBe('106');
  });
});

describe('planBills — NONE / BY_ITEM / BY_SEAT (pure partition, C4)', () => {
  it('freezes DINE_IN policy evidence on exact pre-discount merchandise and modifier basis', () => {
    const [bill] = planBills(
      withServiceCharge(
        order([
          { id: 'a', unitPrice: '10.00', modifiers: ['1.00'] },
          { id: 'b', unitPrice: '5.00', quantity: 2 },
        ])
      ),
      { kind: 'NONE' }
    );
    expect({
      policy: bill!.serviceChargePolicyVersionId,
      basis: bill!.serviceChargeBasis.toFixed(2),
      amount: bill!.serviceChargeTotal.toFixed(2),
      total: bill!.grandTotal.toFixed(2),
      lines: bill!.lines.map((line) => line.serviceChargeAmount.toFixed(2)),
    }).toEqual({
      policy: 'service-policy-v1',
      basis: '21.00',
      amount: '2.10',
      total: '23.10',
      lines: ['1.10', '1.00'],
    });
  });

  it('allocates odd service-charge cents stably across BY_ITEM bills', () => {
    const value = withServiceCharge(
      order([
        { id: 'a', unitPrice: '0.05' },
        { id: 'b', unitPrice: '0.05' },
        { id: 'c', unitPrice: '0.05' },
      ])
    );
    const bills = planBills(value, { kind: 'BY_ITEM', groups: [['a'], ['b'], ['c']] });
    expect(bills.map((bill) => bill.serviceChargeTotal.toFixed(2))).toEqual([
      '0.01',
      '0.01',
      '0.00',
    ]);
  });

  it('rejects FRACTIONAL atomically when a service-charge policy is pinned', () => {
    expect(() =>
      planBills(withServiceCharge(order([{ id: 'a', unitPrice: '10.00' }])), {
        kind: 'FRACTIONAL',
        weights: [1, 1],
      })
    ).toThrow(/not supported when a service charge is pinned/);
  });

  it('NONE places every non-voided item on one bill; subtotal ≡ order total', () => {
    const o = order([
      { id: 'a', unitPrice: '10.00' },
      { id: 'b', unitPrice: '5.00', quantity: 3 },
    ]);
    const [bill, ...rest] = planBills(o, { kind: 'NONE' });
    expect(rest).toHaveLength(0);
    expect(bill!.lines.map((l) => l.orderItemId).sort()).toEqual(['a', 'b']);
    expect(bill!.subtotal.toString()).toBe('25');
    expect(bill!.grandTotal.toString()).toBe('25');
    expect(bill!.roundingAdjustment.toString()).toBe('0');
  });

  it('BY_ITEM asserts a complete partition and rejects gaps/dupes/unknowns', () => {
    const o = order([
      { id: 'a', unitPrice: '10.00' },
      { id: 'b', unitPrice: '6.00' },
      { id: 'c', unitPrice: '4.00' },
    ]);
    const bills = planBills(o, { kind: 'BY_ITEM', groups: [['a', 'b'], ['c']] });
    expect(bills).toHaveLength(2);
    expect(bills[0]!.subtotal.toString()).toBe('16');
    expect(bills[1]!.subtotal.toString()).toBe('4');
    // Every non-voided item is placed on exactly one bill.
    const placed = bills.flatMap((b) => b.lines.map((l) => l.orderItemId)).sort();
    expect(placed).toEqual(['a', 'b', 'c']);

    expect(() => planBills(o, { kind: 'BY_ITEM', groups: [['a', 'b']] })).toThrowError(
      /Every non-voided item/
    );
    expect(() => planBills(o, { kind: 'BY_ITEM', groups: [['a', 'a', 'b', 'c']] })).toThrowError(
      /more than one bill/
    );
    expect(() => planBills(o, { kind: 'BY_ITEM', groups: [['a', 'b', 'c', 'zz']] })).toThrowError(
      /not a billable/
    );
  });

  it('BY_SEAT groups by seatNumber and sends unseated items to one designated bill', () => {
    const o = order([
      { id: 'a', unitPrice: '10.00', seatNumber: 2 },
      { id: 'b', unitPrice: '6.00', seatNumber: 1 },
      { id: 'c', unitPrice: '4.00', seatNumber: 1 },
      { id: 'd', unitPrice: '3.00', seatNumber: null },
    ]);
    const bills = planBills(o, { kind: 'BY_SEAT' });
    // seat 1 (b+c), seat 2 (a), then unseated (d) — ascending seats, unseated last.
    expect(bills).toHaveLength(3);
    expect(bills[0]!.lines.map((l) => l.orderItemId).sort()).toEqual(['b', 'c']);
    expect(bills[1]!.lines.map((l) => l.orderItemId)).toEqual(['a']);
    expect(bills[2]!.lines.map((l) => l.orderItemId)).toEqual(['d']);
    // Full partition and reconciliation.
    const total = deriveOrderTotal(o.items);
    const sum = bills.reduce((acc, b) => acc.plus(b.grandTotal), new Prisma.Decimal(0));
    expect(sum.toString()).toBe(total.toString());
  });
});

describe('planBills — FRACTIONAL split exactness + determinism (C4)', () => {
  // Adversarial remainders: odd cents ÷3 and ÷7.
  const cases: Array<{ total: string; weights: number[] }> = [
    { total: '100.00', weights: [1, 1, 1] },
    { total: '0.01', weights: [1, 1, 1] },
    { total: '10.00', weights: [1, 1, 1, 1, 1, 1, 1] },
    { total: '0.07', weights: [1, 1, 1, 1, 1, 1, 1] },
    { total: '99.99', weights: [2, 1, 1] },
    { total: '33.33', weights: [1, 2, 4] },
    { total: '0.05', weights: [1, 1, 1, 1, 1, 1, 1] },
  ];

  for (const { total, weights } of cases) {
    it(`${total} split ${weights.join('/')} sums exactly and is deterministic`, () => {
      // A single item priced at `total`, quantity 1 — so the derived order total is
      // exactly `total`.
      const o = order([{ id: 'x', unitPrice: total }]);
      const first = planBills(o, { kind: 'FRACTIONAL', weights });
      // Σ grandTotal ≡ order total by Decimal STRING equality (never epsilon).
      const sum = first.reduce((acc, b) => acc.plus(b.grandTotal), new Prisma.Decimal(0));
      expect(sum.toString()).toBe(D(total).toString());
      // Σ (subtotal + roundingAdjustment) ≡ grandTotal per bill; fraction pair set.
      for (const bill of first) {
        expect(bill.subtotal.plus(bill.roundingAdjustment).toString()).toBe(
          bill.grandTotal.toString()
        );
        expect(bill.fractionDenominator).toBe(weights.reduce((a, b) => a + b, 0));
      }
      // Deterministic: a second run yields byte-identical per-bill cents.
      const second = planBills(o, { kind: 'FRACTIONAL', weights });
      expect(second.map((b) => b.grandTotal.toString())).toEqual(
        first.map((b) => b.grandTotal.toString())
      );
    });
  }

  it('rejects non-positive / non-integer weights', () => {
    const o = order([{ id: 'x', unitPrice: '10.00' }]);
    expect(() => planBills(o, { kind: 'FRACTIONAL', weights: [] })).toThrowError(/at least one/);
    expect(() => planBills(o, { kind: 'FRACTIONAL', weights: [1, 0] })).toThrowError(
      /positive integers/
    );
    expect(() => planBills(o, { kind: 'FRACTIONAL', weights: [1, 1.5] })).toThrowError(
      /positive integers/
    );
  });
});

// ── DB-backed integration ────────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha55_${suffix}`;
const ids = {
  brand: `brand_${suffix}`,
  branch: `branch_${suffix}`,
  operator: `staff_op_${suffix}`,
  manager: `staff_mgr_${suffix}`,
  category: `cat_${suffix}`,
  product: `prod_${suffix}`,
  modGroup: `mgrp_${suffix}`,
  modOption: `mopt_${suffix}`,
  menu: `menu_${suffix}`,
  section: `msec_${suffix}`,
  menuItem: `mitem_${suffix}`,
  priceList: `pl_${suffix}`,
  priceVersion: `plv_${suffix}`,
  publication: `pub_${suffix}`,
  taxSource: `tax_source_${suffix}`,
  taxProfile: `tax_profile_${suffix}`,
  taxRule: `tax_rule_${suffix}`,
  loyaltyProgram: `loyalty_program_${suffix}`,
};
const AT = new Date('2026-08-19T18:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  orders: typeof import('@/lib/restaurant/orders');
  bills: typeof import('./bills');
};

let deps: Deps;
let deviceId: string;
let keyCounter = 0;
const key = () => `key_${suffix}_${++keyCounter}`;
const actor = (idempotencyKey = key()) => ({
  staffProfileId: ids.operator,
  deviceId,
  idempotencyKey,
});

function read<T>(fn: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgId, fn);
}

/** Open a fresh order, add N items (each with a price + optional seat + modifier),
 * and return the order id + item ids. Items are HELD (a billable OPEN order). */
async function openWithItems(
  items: Array<{ seat?: number; modifier?: boolean }>
): Promise<{ orderId: string; itemIds: string[]; db: ScopedDb }> {
  const db = deps.createTenantDb(orgId);
  const opened = await deps.orders.openOrder(db, {
    organizationId: orgId,
    entitlementLimits: { 'pos.orders.monthly': 1000000 },
    branchId: ids.branch,
    channel: 'DINE_IN',
    publicationId: ids.publication,
    actor: actor(),
    now: AT,
  });
  const itemIds: string[] = [];
  for (const spec of items) {
    const added = await deps.orders.addItem(db, {
      orderId: opened.orderId,
      menuItemId: ids.menuItem,
      seatNumber: spec.seat,
      modifierOptionIds: spec.modifier ? [ids.modOption] : undefined,
      actor: actor(),
    });
    itemIds.push(added.itemId);
  }
  return { orderId: opened.orderId, itemIds, db };
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, orders, bills] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/orders'),
    import('./bills'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    createTenantDb: scopedDb.createTenantDb,
    enrollDevice: devices.enrollDevice,
    orders,
    bills,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha55-${suffix}`,
        legalName: 'Bills Test Co',
        displayName: 'Bills Test',
        status: 'ACTIVE',
      },
    })
  );

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'Main', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ids.operator, displayName: 'Operator', status: 'ACTIVE' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ids.manager, displayName: 'Manager', status: 'ACTIVE' },
    });
    const enrolled = await deps.enrollDevice(tx, { branchId: ids.branch, name: 'POS-1' });
    deviceId = enrolled.device.id;

    await tx.restaurantCategory.create({ data: { id: ids.category, name: 'Mains' } });
    await tx.restaurantProduct.create({
      data: { id: ids.product, name: 'Burger', categoryId: ids.category },
    });
    await tx.restaurantModifierGroup.create({ data: { id: ids.modGroup, name: 'Extras' } });
    await tx.restaurantModifierOption.create({
      data: {
        id: ids.modOption,
        modifierGroupId: ids.modGroup,
        name: 'Cheese',
        priceDelta: '1.00',
      },
    });
    await tx.restaurantProductModifierGroup.create({
      data: { productId: ids.product, modifierGroupId: ids.modGroup },
    });

    await tx.restaurantBrand.create({ data: { id: ids.brand, name: 'Acme' } });
    await tx.restaurantMenu.create({ data: { id: ids.menu, brandId: ids.brand, name: 'All Day' } });
    await tx.restaurantMenuSection.create({
      data: { id: ids.section, menuId: ids.menu, name: 'Food' },
    });
    await tx.restaurantMenuItem.create({
      data: {
        id: ids.menuItem,
        sectionId: ids.section,
        productId: ids.product,
        displayName: 'Burger',
      },
    });
    await tx.restaurantPriceList.create({
      data: { id: ids.priceList, name: 'Default', isDefault: true },
    });
    await tx.restaurantPriceListVersion.create({
      data: {
        id: ids.priceVersion,
        priceListId: ids.priceList,
        versionNumber: 1,
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        status: 'ACTIVE',
      },
    });
    await tx.restaurantPriceListEntry.create({
      data: { priceListVersionId: ids.priceVersion, productId: ids.product, price: '12.50' },
    });
    await tx.restaurantBranchMenuPublication.create({
      data: {
        id: ids.publication,
        branchId: ids.branch,
        menuId: ids.menu,
        priceListId: ids.priceList,
        status: 'PUBLISHED',
        channels: [],
      },
    });
    await tx.restaurantTaxOfficialSource.create({
      data: {
        id: ids.taxSource,
        authorityCode: 'SYNTHETIC',
        documentTitle: 'Synthetic test source',
        sourceUrl: 'https://example.invalid/synthetic',
        contentHash: `synthetic-${suffix}`,
        retrievedAt: AT,
      },
    });
    await tx.restaurantTaxProfileVersion.create({
      data: {
        id: ids.taxProfile,
        branchId: ids.branch,
        versionNumber: 1,
        status: 'PUBLISHED',
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        approvalReference: 'synthetic-test',
        approvedAt: AT,
        publishedAt: AT,
      },
    });
    await tx.restaurantTaxRuleVersion.create({
      data: {
        id: ids.taxRule,
        profileVersionId: ids.taxProfile,
        officialSourceId: ids.taxSource,
        ruleCode: 'SYNTHETIC_CARD_10',
        paymentCategory: 'CARD',
        priceMode: 'EXCLUSIVE',
        rate: '0.100000',
        status: 'PUBLISHED',
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        approvalReference: 'synthetic-test',
        approvedAt: AT,
        publishedAt: AT,
      },
    });
    await tx.loyaltyProgramVersion.create({
      data: {
        id: ids.loyaltyProgram,
        versionNumber: 1,
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        earnRate: '1.000000',
        redemptionValue: '0.050000',
      },
    });
  });
});

async function seedFinalSettlementEvidence(orderId: string, tag: string) {
  const customerId = `customer_${tag}_${suffix}`;
  const accountId = `account_${tag}_${suffix}`;
  const versionId = `promo_version_${tag}_${suffix}`;
  const evaluationId = `promo_eval_${tag}_${suffix}`;
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantCustomer.create({
      data: { id: customerId, displayName: 'Settlement Guest' },
    });
    await tx.loyaltyAccount.create({ data: { id: accountId, customerId } });
    await tx.restaurantOrder.update({ where: { id: orderId }, data: { customerId } });
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_promotions" ("id","organizationId","code","name","updatedAt")
       VALUES ($1,$2,$3,'Settlement promotion',now())`,
      `promo_${tag}_${suffix}`,
      orgId,
      `SETTLE_${tag}_${suffix}`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_promotion_versions"
         ("id","organizationId","promotionId","versionNumber","status","effectiveFrom",
          "timezone","targetKind","benefitKind","benefitAmount","currency","globalCap",
          "offlinePolicy","approvalReference","publishedAt","ruleSnapshot","ruleHash","updatedAt")
       VALUES ($1,$2,$3,1,'PUBLISHED',$4,'UTC','ORDER','AMOUNT_OFF',0.50,'USD',1,
               'ONLINE_ONLY','synthetic-test',$4,'{}'::jsonb,$5,now())`,
      versionId,
      orgId,
      `promo_${tag}_${suffix}`,
      AT,
      `promo_hash_${tag}_${suffix}`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_promotion_evaluation_snapshots"
         ("id","organizationId","orderId","branchId","channel","currency","idempotencyKey",
          "evaluatedAt","timezone","localDate","localMinute","utcOffsetMinutes",
          "engineVersion","moneyVersion","setRevisionId","setRevisionHash","source",
          "inputLines","evaluationContext","inputHash","outputHash","discountTotal")
       VALUES ($1,$2,$3,$4,'DINE_IN','USD',$1,$5,'UTC','2026-08-19',1080,0,
               '1.0.0','money','revision','revision-hash','ONLINE','[]'::jsonb,'{}'::jsonb,
               $6,$7,0.50)`,
      evaluationId,
      orgId,
      orderId,
      ids.branch,
      AT,
      `promo_input_${tag}_${suffix}`,
      `promo_output_${tag}_${suffix}`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_promotion_cap_counters"
         ("id","organizationId","promotionVersionId","scopeKind","scopeKey","capCount","updatedAt")
       VALUES ($1,$2,$3,'GLOBAL','',1,now())`,
      `promo_counter_${tag}_${suffix}`,
      orgId,
      versionId
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_promotion_cap_reservations"
         ("id","organizationId","counterId","promotionVersionId","scopeKind","scopeKey",
          "evaluationId","applicationOrdinal","reservedCount","reservedAmount","state")
       VALUES ($1,$2,$3,$4,'GLOBAL','',$5,0,1,0.50,'RESERVED')`,
      `promo_reservation_${tag}_${suffix}`,
      orgId,
      `promo_counter_${tag}_${suffix}`,
      versionId,
      evaluationId
    );
  });
  return { evaluationId, accountId };
}

function settlementInput(billId: string, billLineId: string, evaluationId: string, tag: string) {
  const bucket = {
    ruleVersionId: ids.taxRule,
    paymentCategory: 'CARD',
    priceMode: 'EXCLUSIVE' as const,
    rate: D('0.100000'),
    preDiscountGrossAmount: D('13.75'),
    beforeTaxDiscountAmount: D('0.50'),
    afterTaxDiscountAmount: D('0.00'),
  };
  return {
    organizationId: orgId,
    billId,
    staffProfileId: ids.operator,
    deviceId,
    at: AT,
    transactionReference: `tax_settlement_${tag}_${suffix}`,
    profileVersionId: ids.taxProfile,
    currency: 'USD',
    subtotal: D('12.50'),
    discountTotal: D('0.50'),
    serviceChargeTotal: D('1.00'),
    deliveryFeeTotal: D('0.00'),
    taxTotal: D('1.30'),
    roundingAdjustment: D('0.00'),
    grandTotal: D('14.30'),
    eligibleNetMerchandise: D('12.00'),
    loyaltyNetGrandTotal: D('14.30'),
    promotionEvaluationId: evaluationId,
    promotionEvaluationHash: `promo_output_${tag}_${suffix}`,
    lines: [
      {
        billLineId,
        taxAmount: D('1.30'),
        serviceChargeAmount: D('1.00'),
        lineTotal: D('14.30'),
        buckets: [
          {
            ...bucket,
            taxableAmount: D('12.00'),
            taxAmount: D('1.20'),
            grossAmount: D('13.20'),
            unitOrdinal: 0,
          },
        ],
      },
    ],
    serviceChargeBuckets: [
      {
        ...bucket,
        taxableAmount: D('1.00'),
        taxAmount: D('0.10'),
        grossAmount: D('1.10'),
        preDiscountGrossAmount: D('1.10'),
        beforeTaxDiscountAmount: D('0.00'),
      },
    ],
  };
}

describeIfDatabase('bills command layer (real DB)', () => {
  it('cuts one NONE bill for the whole order; replay is idempotent', async () => {
    const { orderId, db } = await openWithItems([{}, { modifier: true }]);
    const result = await deps.bills.cutBills(db, {
      orderId,
      branchId: ids.branch,
      split: { kind: 'NONE' },
      actor: actor(),
    });
    expect(result.billIds).toHaveLength(1);

    const bill = await read((tx) =>
      tx.restaurantBill.findUnique({
        where: { id: result.billIds[0]! },
        select: { status: true, splitKind: true, subtotal: true, grandTotal: true, lines: true },
      })
    );
    expect(bill?.status).toBe('OPEN');
    expect(bill?.splitKind).toBe('NONE');
    // 12.50 + (12.50 + 1.00) = 26.00
    expect(bill?.subtotal.toString()).toBe('26');
    expect(bill?.grandTotal.toString()).toBe('26');
    expect(bill?.lines).toHaveLength(2);

    // Idempotency: on a fresh order, replaying the SAME cut (same device key)
    // returns the original bills and creates nothing new (the money replay domain).
    const fresh = await openWithItems([{}]);
    const sameActor = actor();
    const first = await deps.bills.cutBills(fresh.db, {
      orderId: fresh.orderId,
      branchId: ids.branch,
      split: { kind: 'FRACTIONAL', weights: [1, 1] },
      actor: sameActor,
    });
    const replay = await deps.bills.cutBills(fresh.db, {
      orderId: fresh.orderId,
      branchId: ids.branch,
      split: { kind: 'FRACTIONAL', weights: [1, 1] },
      actor: sameActor,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.billIds.sort()).toEqual(first.billIds.sort());
    const billCount = await read((tx) =>
      tx.restaurantBill.count({ where: { orderId: fresh.orderId } })
    );
    expect(billCount).toBe(2); // the replay created no additional bills
  });

  it('BY_SEAT groups items into per-seat bills that reconcile to the order total', async () => {
    const { orderId, db } = await openWithItems([{ seat: 1 }, { seat: 2 }, { seat: 2 }]);
    const result = await deps.bills.cutBills(db, {
      orderId,
      branchId: ids.branch,
      split: { kind: 'BY_SEAT' },
      actor: actor(),
    });
    expect(result.billIds).toHaveLength(2);

    const settlement = await read((tx) => deps.bills.evaluateOrderSettlement(tx, orderId));
    expect(settlement.accountedTotal.toString()).toBe(settlement.derivedOrderTotal.toString());
    expect(settlement.unbilledItemIds).toEqual([]);
    expect(settlement.blocker).toBe('BILLS_OPEN'); // bills exist, not yet settled
  });

  it('comps a line to zero: retains snapshot price, records reason + co-auth, updates totals', async () => {
    const { orderId, db } = await openWithItems([{}, {}]);
    const { billIds } = await deps.bills.cutBills(db, {
      orderId,
      branchId: ids.branch,
      split: { kind: 'NONE' },
      actor: actor(),
    });
    const line = await read((tx) =>
      tx.restaurantBillLine.findFirst({
        where: { billId: billIds[0]! },
        select: { id: true, unitPrice: true, lineSubtotal: true },
      })
    );
    await deps.bills.compLine(db, {
      billId: billIds[0]!,
      branchId: ids.branch,
      billLineId: line!.id,
      reason: 'guest complaint',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
    });

    const after = await read((tx) =>
      tx.restaurantBillLine.findUnique({
        where: { id: line!.id },
        select: {
          unitPrice: true,
          lineSubtotal: true,
          compAmount: true,
          lineTotal: true,
          compReason: true,
          compCoAuthorization: {
            select: { approvingStaffProfileId: true, capability: true, reason: true },
          },
        },
      })
    );
    // Original snapshot price + subtotal retained; comp nets the line to zero.
    expect(after?.unitPrice.toString()).toBe(line!.unitPrice.toString());
    expect(after?.lineSubtotal.toString()).toBe(line!.lineSubtotal.toString());
    expect(after?.compAmount.toString()).toBe(line!.lineSubtotal.toString());
    expect(after?.lineTotal.toString()).toBe('0');
    expect(after?.compReason).toBe('guest complaint');
    expect(after?.compCoAuthorization?.approvingStaffProfileId).toBe(ids.manager);
    expect(after?.compCoAuthorization?.capability).toBe('orders:complimentary');

    // Bill totals: compTotal picks up the comp; grandTotal drops by it; the
    // settlement identity Σ(grandTotal + compTotal) ≡ order total still holds.
    const settlement = await read((tx) => deps.bills.evaluateOrderSettlement(tx, orderId));
    expect(settlement.accountedTotal.toString()).toBe(settlement.derivedOrderTotal.toString());

    // A second comp of the same line is rejected.
    await expect(
      deps.bills.compLine(db, {
        billId: billIds[0]!,
        branchId: ids.branch,
        billLineId: line!.id,
        reason: 'again',
        approvingStaffProfileId: ids.manager,
        actor: actor(),
      })
    ).rejects.toMatchObject({ reason: 'ALREADY_COMPED' });
  });

  it('clears pinned service-charge evidence after the last service-bearing line is comped', async () => {
    const { orderId, itemIds, db } = await openWithItems([{}, {}]);
    await read((tx) =>
      tx.restaurantServiceChargePolicyVersion.updateMany({
        where: {
          branchId: ids.branch,
          effectiveFrom: { lt: new Date('2026-08-18T00:00:00.000Z') },
          OR: [
            { effectiveTo: null },
            { effectiveTo: { gt: new Date('2026-08-18T00:00:00.000Z') } },
          ],
        },
        data: { effectiveTo: new Date('2026-08-18T00:00:00.000Z') },
      })
    );
    const policy = await read((tx) =>
      tx.restaurantServiceChargePolicyVersion.create({
        data: {
          branchId: ids.branch,
          rate: '0.100000',
          effectiveFrom: new Date('2026-08-18T00:00:00.000Z'),
          effectiveTo: AT,
          acknowledgedAt: AT,
          acknowledgementRef: 'issue-271',
          idempotencyKey: `service_comp_${suffix}`,
          payloadHash: `service-comp-${suffix}`,
        },
      })
    );
    await read(async (tx) => {
      await tx.restaurantOrderItem.update({
        where: { id: itemIds[0]! },
        data: { unitPrice: '40.00' },
      });
      await tx.restaurantOrderItem.update({
        where: { id: itemIds[1]! },
        data: { unitPrice: '60.00' },
      });
      await tx.restaurantOrder.update({
        where: { id: orderId },
        data: { serviceChargePolicyVersionId: policy.id },
      });
    });

    const { billIds } = await deps.bills.cutBills(db, {
      orderId,
      branchId: ids.branch,
      split: { kind: 'NONE' },
      actor: actor(),
    });
    const billId = billIds[0]!;
    const lines = await read((tx) =>
      tx.restaurantBillLine.findMany({ where: { billId }, orderBy: { lineSubtotal: 'asc' } })
    );

    await deps.bills.compLine(db, {
      billId,
      branchId: ids.branch,
      billLineId: lines[0]!.id,
      reason: 'guest complaint',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
    });
    const partial = await read((tx) =>
      tx.restaurantBill.findUniqueOrThrow({ where: { id: billId } })
    );
    expect({
      service: partial.serviceChargeTotal.toFixed(2),
      basis: partial.serviceChargeBasis.toFixed(2),
      policy: partial.serviceChargePolicyVersionId,
      total: partial.grandTotal.toFixed(2),
    }).toEqual({ service: '6.00', basis: '60.00', policy: policy.id, total: '66.00' });

    await deps.bills.compLine(db, {
      billId,
      branchId: ids.branch,
      billLineId: lines[1]!.id,
      reason: 'guest complaint',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
    });
    const fullyComped = await read((tx) =>
      tx.restaurantBill.findUniqueOrThrow({ where: { id: billId } })
    );
    expect({
      service: fullyComped.serviceChargeTotal.toFixed(2),
      basis: fullyComped.serviceChargeBasis.toFixed(2),
      policy: fullyComped.serviceChargePolicyVersionId,
      rate: fullyComped.serviceChargeRate,
      taxTreatment: fullyComped.serviceChargeTaxTreatment,
      total: fullyComped.grandTotal.toFixed(2),
    }).toEqual({
      service: '0.00',
      basis: '0.00',
      policy: null,
      rate: null,
      taxTreatment: null,
      total: '0.00',
    });
  });

  it('removes a participating zero-allocation line from the basis and reallocates without drift', async () => {
    const { orderId, itemIds, db } = await openWithItems([{}, {}]);
    await read((tx) =>
      tx.restaurantServiceChargePolicyVersion.updateMany({
        where: {
          branchId: ids.branch,
          effectiveFrom: { lt: new Date('2026-08-18T00:00:00.000Z') },
          OR: [
            { effectiveTo: null },
            { effectiveTo: { gt: new Date('2026-08-18T00:00:00.000Z') } },
          ],
        },
        data: { effectiveTo: new Date('2026-08-18T00:00:00.000Z') },
      })
    );
    const policy = await read((tx) =>
      tx.restaurantServiceChargePolicyVersion.create({
        data: {
          branchId: ids.branch,
          rate: '0.100000',
          effectiveFrom: new Date('2026-08-18T00:00:00.000Z'),
          effectiveTo: AT,
          acknowledgedAt: AT,
          acknowledgementRef: 'zero-allocation-regression',
          idempotencyKey: `service_zero_${suffix}`,
          payloadHash: `service-zero-${suffix}`,
        },
      })
    );
    await read(async (tx) => {
      await tx.restaurantOrderItem.update({
        where: { id: itemIds[0]! },
        data: { unitPrice: '0.01' },
      });
      await tx.restaurantOrderItem.update({
        where: { id: itemIds[1]! },
        data: { unitPrice: '0.09' },
      });
      await tx.restaurantOrder.update({
        where: { id: orderId },
        data: { serviceChargePolicyVersionId: policy.id },
      });
    });
    const { billIds } = await deps.bills.cutBills(db, {
      orderId,
      branchId: ids.branch,
      split: { kind: 'NONE' },
      actor: actor(),
    });
    const billId = billIds[0]!;
    const lines = await read((tx) =>
      tx.restaurantBillLine.findMany({ where: { billId }, orderBy: { lineSubtotal: 'asc' } })
    );
    expect(lines.map((line) => line.serviceChargeAmount.toFixed(2))).toEqual(['0.00', '0.01']);

    await deps.bills.compLine(db, {
      billId,
      branchId: ids.branch,
      billLineId: lines[0]!.id,
      reason: 'zero allocation regression',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
    });

    const after = await read((tx) =>
      tx.restaurantBill.findUniqueOrThrow({
        where: { id: billId },
        include: { lines: { orderBy: { lineSubtotal: 'asc' } } },
      })
    );
    expect({
      basis: after.serviceChargeBasis.toFixed(2),
      service: after.serviceChargeTotal.toFixed(2),
      grand: after.grandTotal.toFixed(2),
      allocations: after.lines.map((line) => line.serviceChargeAmount.toFixed(2)),
      lineTotals: after.lines.map((line) => line.lineTotal.toFixed(2)),
    }).toEqual({
      basis: '0.09',
      service: '0.01',
      grand: '0.10',
      allocations: ['0.00', '0.01'],
      lineTotals: ['0.00', '0.10'],
    });
    expect(
      after.lines.reduce((total, line) => total.add(line.serviceChargeAmount), D(0)).toFixed(2)
    ).toBe(after.serviceChargeTotal.toFixed(2));
  });

  it('leaves the zero service-charge sentinel unchanged when comping a non-participating line', async () => {
    const { db, orderId } = await openWithItems([{}]);
    const { billIds } = await deps.bills.cutBills(db, {
      orderId,
      branchId: ids.branch,
      split: { kind: 'NONE' },
      actor: actor(),
    });
    const billId = billIds[0]!;
    const line = await read((tx) => tx.restaurantBillLine.findFirstOrThrow({ where: { billId } }));
    await deps.bills.compLine(db, {
      billId,
      branchId: ids.branch,
      billLineId: line.id,
      reason: 'non-participating regression',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
    });
    const after = await read((tx) =>
      tx.restaurantBill.findUniqueOrThrow({ where: { id: billId } })
    );
    expect({
      basis: after.serviceChargeBasis.toFixed(2),
      service: after.serviceChargeTotal.toFixed(2),
      policy: after.serviceChargePolicyVersionId,
      grand: after.grandTotal.toFixed(2),
    }).toEqual({ basis: '0.00', service: '0.00', policy: null, grand: '0.00' });
  });

  it('re-split guard: blocks without recut, voids-and-recuts with co-auth, locks after tender/settle', async () => {
    const { orderId, db } = await openWithItems([{}, {}]);
    const firstCut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ids.branch,
      split: { kind: 'NONE' },
      actor: actor(),
    });

    // Re-cut without a recut reason is refused.
    await expect(
      deps.bills.cutBills(db, {
        orderId,
        branchId: ids.branch,
        split: { kind: 'FRACTIONAL', weights: [1, 1] },
        actor: actor(),
      })
    ).rejects.toMatchObject({ reason: 'RESPLIT_LOCKED' });

    // With recut (reason + co-auth) the old bills go VOID and a new set is created.
    const recut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ids.branch,
      split: { kind: 'FRACTIONAL', weights: [1, 1] },
      recut: { reason: 'guest wants separate checks', approvingStaffProfileId: ids.manager },
      actor: actor(),
    });
    expect(recut.billIds).toHaveLength(2);
    const oldBill = await read((tx) =>
      tx.restaurantBill.findUnique({
        where: { id: firstCut.billIds[0]! },
        select: { status: true, voidReason: true, voidCoAuthorizationId: true },
      })
    );
    expect(oldBill?.status).toBe('VOID');
    expect(oldBill?.voidReason).toBe('guest wants separate checks');
    expect(oldBill?.voidCoAuthorizationId).not.toBeNull();

    // Settle one of the new bills, then a further re-split is locked.
    await deps.withTenantDb(orgId, (tx) =>
      deps.bills.settleBill(tx, {
        billId: recut.billIds[0]!,
        staffProfileId: ids.operator,
        deviceId,
        at: AT,
      })
    );
    await expect(
      deps.bills.cutBills(db, {
        orderId,
        branchId: ids.branch,
        split: { kind: 'NONE' },
        recut: { reason: 'too late', approvingStaffProfileId: ids.manager },
        actor: actor(),
      })
    ).rejects.toMatchObject({ reason: 'RESPLIT_LOCKED' });
  });

  it('settleBill flips OPEN→SETTLED once and allocates a monotonic receipt number', async () => {
    const a = await openWithItems([{}]);
    const b = await openWithItems([{}]);
    const cutA = await deps.bills.cutBills(a.db, {
      orderId: a.orderId,
      branchId: ids.branch,
      split: { kind: 'NONE' },
      actor: actor(),
    });
    const cutB = await deps.bills.cutBills(b.db, {
      orderId: b.orderId,
      branchId: ids.branch,
      split: { kind: 'NONE' },
      actor: actor(),
    });

    const settleA = await deps.withTenantDb(orgId, (tx) =>
      deps.bills.settleBill(tx, {
        billId: cutA.billIds[0]!,
        staffProfileId: ids.operator,
        deviceId,
        at: AT,
      })
    );
    const settleB = await deps.withTenantDb(orgId, (tx) =>
      deps.bills.settleBill(tx, {
        billId: cutB.billIds[0]!,
        staffProfileId: ids.operator,
        deviceId,
        at: AT,
      })
    );
    expect(settleA.alreadySettled).toBe(false);
    expect(settleB.receiptNumber).toBe(settleA.receiptNumber + 1); // monotonic, same branch/date

    // Re-settle is a no-op that returns the same receipt (exactly-once allocation).
    const again = await deps.withTenantDb(orgId, (tx) =>
      deps.bills.settleBill(tx, {
        billId: cutA.billIds[0]!,
        staffProfileId: ids.operator,
        deviceId,
        at: AT,
      })
    );
    expect(again.alreadySettled).toBe(true);
    expect(again.receiptNumber).toBe(settleA.receiptNumber);
  });

  it('final settlement freezes v1 evidence, consumes promotion and accrues loyalty atomically', async () => {
    const makeBill = async (tag: string) => {
      const opened = await openWithItems([{}]);
      const cut = await deps.bills.cutBills(opened.db, {
        orderId: opened.orderId,
        branchId: ids.branch,
        split: { kind: 'NONE' },
        actor: actor(),
      });
      const billId = cut.billIds[0]!;
      const billLineId = await read(async (tx) =>
        tx.restaurantBillLine
          .findFirstOrThrow({ where: { billId }, select: { id: true } })
          .then((line) => line.id)
      );
      const seeded = await seedFinalSettlementEvidence(opened.orderId, tag);
      return { billId, billLineId, ...seeded };
    };

    const rollback = await makeBill('rollback');
    await expect(
      deps.withTenantDb(orgId, async (tx) => {
        await deps.bills.finalizeBillSettlement(
          tx,
          settlementInput(rollback.billId, rollback.billLineId, rollback.evaluationId, 'rollback')
        );
        throw new Error('injected after final settlement write');
      })
    ).rejects.toThrow('injected after final settlement write');

    const rolledBack = await read(async (tx) => ({
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: rollback.billId } }),
      line: await tx.restaurantBillLine.findUniqueOrThrow({
        where: { id: rollback.billLineId },
      }),
      snapshots: await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM "restaurant_tax_transaction_snapshots"
         WHERE "transactionReference" = ${`tax_settlement_rollback_${suffix}`}
      `,
      reservation: await tx.restaurantPromotionCapReservation.findUniqueOrThrow({
        where: { id: `promo_reservation_rollback_${suffix}` },
      }),
      loyaltyEntries: await tx.loyaltyPointsEntry.count({
        where: { accountId: rollback.accountId },
      }),
    }));
    expect(rolledBack.bill).toMatchObject({ status: 'OPEN', receiptNumber: null });
    expect(rolledBack.bill.taxTotal.toString()).toBe('0');
    expect(rolledBack.line.taxAmount.toString()).toBe('0');
    expect(rolledBack.line.serviceChargeAmount.toString()).toBe('0');
    expect(rolledBack.snapshots[0]?.count).toBe(0);
    expect(rolledBack.reservation.state).toBe('RESERVED');
    expect(rolledBack.loyaltyEntries).toBe(0);

    const wrongBill = await makeBill('wrong_bill');
    const foreignBill = await makeBill('foreign_bill');
    const wrongBillTender = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantTender.create({
        data: {
          billId: foreignBill.billId,
          type: 'CARD',
          amount: D('14.30'),
          businessDate: new Date('2026-08-29T00:00:00.000Z'),
          staffProfileId: ids.operator,
          deviceId,
        },
        select: { id: true },
      })
    );
    const wrongBillInput: FinalizeBillSettlementInput = settlementInput(
      wrongBill.billId,
      wrongBill.billLineId,
      wrongBill.evaluationId,
      'wrong_bill'
    );
    wrongBillInput.tenderTaxAllocations = [
      {
        originalTenderId: wrongBillTender.id,
        paymentCategory: 'CARD',
        bucket: {
          allocationKind: 'MERCHANDISE',
          billLineId: wrongBill.billLineId,
          unitOrdinal: 0,
          ruleVersionId: ids.taxRule,
          paymentCategory: 'CARD',
        },
        cents: 120,
      },
      {
        originalTenderId: wrongBillTender.id,
        paymentCategory: 'CARD',
        bucket: {
          allocationKind: 'SERVICE_CHARGE',
          ruleVersionId: ids.taxRule,
          paymentCategory: 'CARD',
        },
        cents: 10,
      },
    ];
    await expect(
      deps.withTenantDb(orgId, (tx) => deps.bills.finalizeBillSettlement(tx, wrongBillInput))
    ).rejects.toThrow('tender on the bill being settled');
    const rejectedWrites = await read(async (tx) => ({
      snapshots: await tx.restaurantTaxTransactionSnapshot.count({
        where: { transactionReference: `tax_settlement_wrong_bill_${suffix}` },
      }),
      allocations: await tx.restaurantTaxTenderAllocationSnapshot.count({
        where: { billId: wrongBill.billId },
      }),
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: wrongBill.billId } }),
    }));
    expect(rejectedWrites).toMatchObject({ snapshots: 0, allocations: 0 });
    expect(rejectedWrites.bill).toMatchObject({ status: 'OPEN', taxTotal: D('0') });

    const committed = await makeBill('commit');
    await read((tx) =>
      tx.restaurantBill.update({
        where: { id: committed.billId },
        data: { deliveryFeeTotal: D('2.00'), grandTotal: D('14.50') },
      })
    );
    const [tenderA, tenderB] = await deps.withTenantDb(orgId, (tx) =>
      Promise.all([
        tx.restaurantTender.create({
          data: {
            billId: committed.billId,
            type: 'CARD',
            amount: D('8.00'),
            businessDate: new Date('2026-08-29T00:00:00.000Z'),
            staffProfileId: ids.operator,
            deviceId,
          },
          select: { id: true },
        }),
        tx.restaurantTender.create({
          data: {
            billId: committed.billId,
            type: 'CARD',
            amount: D('8.30'),
            businessDate: new Date('2026-08-29T00:00:00.000Z'),
            staffProfileId: ids.operator,
            deviceId,
          },
          select: { id: true },
        }),
      ])
    );
    const committedInput: FinalizeBillSettlementInput = settlementInput(
      committed.billId,
      committed.billLineId,
      committed.evaluationId,
      'commit'
    );
    committedInput.deliveryFeeTotal = D('2.00');
    committedInput.grandTotal = D('16.30');
    committedInput.tenderTaxAllocations = [
      {
        originalTenderId: tenderA.id,
        paymentCategory: 'CARD',
        bucket: {
          allocationKind: 'MERCHANDISE',
          billLineId: committed.billLineId,
          unitOrdinal: 0,
          ruleVersionId: ids.taxRule,
          paymentCategory: 'CARD',
        },
        cents: 70,
      },
      {
        originalTenderId: tenderB.id,
        paymentCategory: 'CARD',
        bucket: {
          allocationKind: 'MERCHANDISE',
          billLineId: committed.billLineId,
          unitOrdinal: 0,
          ruleVersionId: ids.taxRule,
          paymentCategory: 'CARD',
        },
        cents: 50,
      },
      {
        originalTenderId: tenderA.id,
        paymentCategory: 'CARD',
        bucket: {
          allocationKind: 'SERVICE_CHARGE',
          ruleVersionId: ids.taxRule,
          paymentCategory: 'CARD',
        },
        cents: 5,
      },
      {
        originalTenderId: tenderB.id,
        paymentCategory: 'CARD',
        bucket: {
          allocationKind: 'SERVICE_CHARGE',
          ruleVersionId: ids.taxRule,
          paymentCategory: 'CARD',
        },
        cents: 5,
      },
    ];
    const result = await deps.withTenantDb(orgId, (tx) =>
      deps.bills.finalizeBillSettlement(tx, committedInput)
    );
    expect(result).toMatchObject({
      alreadySettled: false,
      consumedReservationCount: 1,
    });
    expect(result.receiptNumber).toBeGreaterThan(0);
    expect(result.loyaltyEntryId).toBeTruthy();

    const frozen = await read(async (tx) => ({
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: committed.billId } }),
      line: await tx.restaurantBillLine.findUniqueOrThrow({
        where: { id: committed.billLineId },
      }),
      snapshot: await tx.restaurantTaxTransactionSnapshot.findUniqueOrThrow({
        where: {
          organizationId_transactionReference: {
            organizationId: orgId,
            transactionReference: `tax_settlement_commit_${suffix}`,
          },
        },
      }),
      buckets: await tx.restaurantTaxRateBucketSnapshot.findMany({
        where: { snapshotId: result.snapshotId },
        orderBy: { allocationKind: 'asc' },
      }),
      tenderAllocations: await tx.restaurantTaxTenderAllocationSnapshot.findMany({
        where: { snapshotId: result.snapshotId },
        orderBy: [{ rateBucketSnapshotId: 'asc' }, { originalTenderId: 'asc' }],
        include: { rateBucket: true },
      }),
      reservation: await tx.restaurantPromotionCapReservation.findUniqueOrThrow({
        where: { id: `promo_reservation_commit_${suffix}` },
      }),
      counter: await tx.restaurantPromotionCapCounter.findUniqueOrThrow({
        where: { id: `promo_counter_commit_${suffix}` },
      }),
      earn: await tx.loyaltyPointsEntry.findUniqueOrThrow({
        where: {
          organizationId_idempotencyKey: {
            organizationId: orgId,
            idempotencyKey: `loyalty:earn:${committed.billId}`,
          },
        },
      }),
    }));
    expect(frozen.bill).toMatchObject({ status: 'SETTLED' });
    expect(frozen.bill.taxTotal.toString()).toBe('1.3');
    expect(frozen.bill.serviceChargeTotal.toString()).toBe('1');
    expect(frozen.bill.discountTotal.toString()).toBe('0.5');
    expect(frozen.bill.deliveryFeeTotal.toString()).toBe('2');
    expect(frozen.bill.grandTotal.toString()).toBe('16.3');
    expect(frozen.line.taxAmount.toString()).toBe('1.3');
    expect(frozen.line.serviceChargeAmount.toString()).toBe('1');
    expect(frozen.line.lineTotal.toString()).toBe('14.3');
    expect(frozen.snapshot.evidenceVersion).toBe(1);
    expect(frozen.snapshot.billId).toBe(committed.billId);
    expect(frozen.buckets).toHaveLength(2);
    expect(frozen.buckets.map((bucket) => bucket.allocationKind)).toEqual([
      'MERCHANDISE',
      'SERVICE_CHARGE',
    ]);
    expect(frozen.buckets[0]).toMatchObject({
      billLineId: committed.billLineId,
      unitOrdinal: 0,
    });
    expect(frozen.buckets[1]).toMatchObject({ billLineId: null, unitOrdinal: null });
    expect(frozen.tenderAllocations).toHaveLength(4);
    expect(frozen.tenderAllocations.reduce((total, row) => total + row.cents, BigInt(0))).toBe(
      BigInt(130)
    );
    expect(new Set(frozen.tenderAllocations.map((row) => row.originalTenderId))).toEqual(
      new Set([tenderA.id, tenderB.id])
    );
    expect(new Set(frozen.tenderAllocations.map((row) => row.rateBucket.allocationKind))).toEqual(
      new Set(['MERCHANDISE', 'SERVICE_CHARGE'])
    );
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        tx.restaurantTaxTenderAllocationSnapshot.update({
          where: { id: frozen.tenderAllocations[0]!.id },
          data: { cents: BigInt(1) },
        })
      )
    ).rejects.toMatchObject({ code: 'P2039' });
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        tx.restaurantTaxTenderAllocationSnapshot.delete({
          where: { id: frozen.tenderAllocations[0]!.id },
        })
      )
    ).rejects.toMatchObject({ code: 'P2039' });
    const firstAllocation = frozen.tenderAllocations[0]!;
    await expect(
      deps.withTenantDb(
        orgId,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "restaurant_tax_tender_allocation_snapshots"
            ("id", "organizationId", "snapshotId", "billId", "rateBucketSnapshotId",
             "originalTenderId", "paymentCategory", "cents")
          VALUES
            (gen_random_uuid()::text, ${orgId}, ${result.snapshotId}, ${committed.billId},
             ${firstAllocation.rateBucketSnapshotId}, ${firstAllocation.originalTenderId},
             ${firstAllocation.paymentCategory}::"RestaurantTenderType", ${firstAllocation.cents})
        `
      )
    ).rejects.toMatchObject({ code: 'P2010' });
    await expect(
      deps.withTenantDb(
        orgId,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "restaurant_tax_tender_allocation_snapshots"
            ("id", "organizationId", "snapshotId", "billId", "rateBucketSnapshotId",
             "originalTenderId", "paymentCategory", "cents")
          VALUES
            (gen_random_uuid()::text, ${orgId}, 'different-snapshot', ${committed.billId},
             ${firstAllocation.rateBucketSnapshotId}, ${firstAllocation.originalTenderId},
             ${firstAllocation.paymentCategory}::"RestaurantTenderType", ${firstAllocation.cents})
        `
      )
    ).rejects.toMatchObject({ code: 'P2010' });
    await expect(
      deps.withTenantDb(
        orgId,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "restaurant_tax_tender_allocation_snapshots"
            ("id", "organizationId", "snapshotId", "billId", "rateBucketSnapshotId",
             "originalTenderId", "paymentCategory", "cents")
          VALUES
            (gen_random_uuid()::text, ${orgId}, ${result.snapshotId}, ${committed.billId},
             ${firstAllocation.rateBucketSnapshotId}, ${wrongBillTender.id},
             'CARD'::"RestaurantTenderType", 1)
        `
      )
    ).rejects.toMatchObject({ code: 'P2010' });
    expect(frozen.reservation.state).toBe('CONSUMED');
    expect(frozen.counter.consumedCount).toBe(1);
    expect(frozen.counter.consumedAmount.toString()).toBe('0.5');
    expect(frozen.earn.points).toBe(14);
  });

  it('settlement predicate: NO_BILLS → BILLS_OPEN → settled once every bill is settled', async () => {
    const { orderId, db } = await openWithItems([{}, {}]);
    const before = await read((tx) => deps.bills.evaluateOrderSettlement(tx, orderId));
    expect(before.settled).toBe(false);
    expect(before.blocker).toBe('NO_BILLS');

    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ids.branch,
      split: { kind: 'FRACTIONAL', weights: [1, 1, 1] },
      actor: actor(),
    });
    await deps.withTenantDb(orgId, async (tx) => {
      const bill = await tx.restaurantBill.findUniqueOrThrow({ where: { id: cut.billIds[0]! } });
      await tx.restaurantBill.update({
        where: { id: bill.id },
        data: {
          discountTotal: bill.discountTotal.plus('0.50'),
          grandTotal: bill.grandTotal.minus('0.50'),
        },
      });
    });
    const open = await read((tx) => deps.bills.evaluateOrderSettlement(tx, orderId));
    expect(open.blocker).toBe('BILLS_OPEN');
    expect(open.accountedTotal.toString()).toBe(open.derivedOrderTotal.toString());

    for (const billId of cut.billIds) {
      await deps.withTenantDb(orgId, (tx) =>
        deps.bills.settleBill(tx, { billId, staffProfileId: ids.operator, deviceId, at: AT })
      );
    }
    const settled = await read((tx) => deps.bills.evaluateOrderSettlement(tx, orderId));
    expect(settled.settled).toBe(true);
    expect(settled.blocker).toBeNull();
  });
});
