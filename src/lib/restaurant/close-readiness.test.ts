import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  CLOSE_PACKET_MAX_AGE_MS,
  prepareClosePacket,
  type ClosePacketAccess,
} from './close-readiness';

const now = new Date('2026-09-12T12:00:00Z');
const date = new Date('2026-09-11T00:00:00Z');
const input = { branchId: 'b1', businessDate: '2026-09-11', asOf: now.toISOString() };
const access: ClosePacketAccess = {
  organizationId: 'org1',
  financial: true,
  operational: true,
  allowedRoutes: ['bills', 'drawers', 'orders', 'reports', 'closes'],
};
const D = (value: string) => new Prisma.Decimal(value);
function bill(status: 'OPEN' | 'SETTLED' | 'VOID' = 'SETTLED', businessDate = date) {
  return {
    id: 'bill1',
    branchId: 'b1',
    businessDate,
    status,
    subtotal: D('100.10'),
    grandTotal: D('90'),
    deliveryFeeTotal: D('0'),
    taxTotal: D('0'),
    serviceChargeTotal: D('0'),
    compTotal: D('10'),
    discountTotal: D('0.10'),
  };
}
function drawer(countedCash: Prisma.Decimal | null = D('0'), status: 'OPEN' | 'CLOSED' = 'CLOSED') {
  return {
    id: 'drawer1',
    branchId: 'b1',
    businessDate: date,
    status,
    countedCash,
    createdAt: date,
    closedAt: new Date('2026-09-11T22:00:00Z'),
    movements: [{ kind: 'OPENING_FLOAT', amount: D('0') }],
  };
}
function close(id = 'close1', supersedesCloseId: string | null = null) {
  return {
    id,
    supersedesCloseId,
    branchId: 'b1',
    branch: { name: 'One' },
    businessDate: date,
    createdAt: new Date('2026-09-11T23:00:00Z'),
    grossSales: D('250.10'),
    netSales: D('250.10'),
    deliveryFeeSales: D('0'),
    deliveryFeeRefunds: D('0'),
    taxTotal: D('0'),
    serviceChargeTotal: D('0'),
    tipTotal: D('0'),
    compTotal: D('0'),
    discountTotal: D('0'),
    refundTotal: D('0'),
    voidTotal: D('0'),
    cashExpected: D('0'),
    cashCounted: D('0'),
    cashVariance: D('0'),
    tenderTotals: [],
  };
}
function fixture() {
  const state = {
    bills: [] as ReturnType<typeof bill>[],
    drawers: [] as ReturnType<typeof drawer>[],
    closes: [] as ReturnType<typeof close>[],
    tenders: [] as {
      businessDate: Date;
      bill: { businessDate: Date };
      type: 'CASH';
      amount: Prisma.Decimal;
      tipAmount: Prisma.Decimal;
    }[],
    refunds: [] as { amount: Prisma.Decimal; deliveryFeeRefundAmount: Prisma.Decimal }[],
    unbilled: [] as { id: string }[],
  };
  const write = vi.fn(() => {
    throw new Error('Domain write forbidden');
  });
  const db = {
    organization: { findUnique: vi.fn().mockResolvedValue({ currency: 'PKR' }) },
    restaurantBranch: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'b1', timezone: 'Asia/Karachi', businessDayCutoff: '04:00' }),
    },
    restaurantBill: {
      findMany: vi.fn(async (args: Prisma.RestaurantBillFindManyArgs) =>
        state.bills
          .filter(
            (row) =>
              (!args.where?.status || row.status === args.where.status) &&
              (!(args.where?.businessDate instanceof Date) ||
                row.businessDate.getTime() === args.where.businessDate.getTime())
          )
          .slice(0, args.take ?? state.bills.length)
      ),
    },
    restaurantTender: {
      findMany: vi.fn(async (args: Prisma.RestaurantTenderFindManyArgs) =>
        state.tenders.filter(
          (row) => row.businessDate.getTime() === (args.where?.businessDate as Date).getTime()
        )
      ),
    },
    restaurantRefund: { findMany: vi.fn(async () => state.refunds) },
    restaurantDrawerSession: { findMany: vi.fn(async () => state.drawers) },
    restaurantDailyClose: { findMany: vi.fn(async () => state.closes) },
    insightDailyRollup: { findMany: vi.fn().mockResolvedValue([]) },
    restaurantOrder: {
      count: vi.fn(async () => state.unbilled.length),
      findMany: vi.fn(async () => state.unbilled.slice(0, 100)),
    },
    $transaction: write,
  };
  // Any new mutation or unlisted domain dependency fails the test, including jobs.
  const readOnlyDb = new Proxy(db, {
    get(target, key) {
      if (!(key in target)) return write();
      const value = target[key as keyof typeof target];
      if (typeof value !== 'object') return value;
      return new Proxy(value, {
        get(delegate, method) {
          return method in delegate ? delegate[method as keyof typeof delegate] : write;
        },
      });
    },
  }) as unknown as ScopedDb;
  return {
    state,
    db,
    write,
    prepare: (request = input, grants = access) => prepareClosePacket(readOnlyDb, request, grants),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe('read-only close preparation', () => {
  it('separates clear financial guards from unknown terminal synchronization', async () => {
    const f = fixture();
    const packet = await f.prepare();
    expect(packet.financial.status).toBe('READY');
    expect(packet.operational.status).toBe('UNKNOWN');
    expect(packet.status).toBe('UNKNOWN');
    expect(packet.unattendedCloseReady).toBe(false);
    expect(packet.operational.missingEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'TERMINAL_SYNC_UNKNOWN', allowedExistingRoutes: [] }),
      ])
    );
    expect(packet.execution).toMatchObject({ mode: 'READ_ONLY', scheduled: false });
    expect(f.write).not.toHaveBeenCalled();
  });

  it('returns exact source-linked daily-close blockers and only permitted routes', async () => {
    const f = fixture();
    f.state.bills.push(bill('OPEN'));
    f.state.drawers.push(drawer(null, 'OPEN'));
    const packet = await f.prepare(input, { ...access, allowedRoutes: ['drawers'] });
    expect(packet.financial.status).toBe('BLOCKED');
    expect(packet.financial.blockers).toMatchObject([
      {
        code: 'UNSETTLED_BILL',
        recordIds: ['bill1'],
        responsibleRole: 'CASHIER',
        allowedExistingRoutes: [],
        source: 'src/lib/restaurant/daily-close.ts#assertReadyToClose',
      },
      {
        code: 'OPEN_DRAWER',
        recordIds: ['drawer1'],
        allowedExistingRoutes: [{ procedure: 'restaurantCash.listDrawerSessions' }],
      },
    ]);
  });

  it('preserves null cash counts instead of the preview legacy zero', async () => {
    const f = fixture();
    f.state.drawers.push(drawer(null));
    const packet = await f.prepare();
    expect(packet.financial.status).toBe('UNKNOWN');
    expect(packet.financial.data?.amounts.cashCounted.value).toBeNull();
    expect(packet.financial.data?.amounts.cashVariance.value).toBeNull();
    expect(packet.financial.data?.cashCountCoverage).toMatchObject({
      status: 'INCOMPLETE',
      missingCountSessionCount: 1,
    });
  });

  it('treats explicit zero as counted and preserves Decimal sales arithmetic', async () => {
    const f = fixture();
    f.state.drawers.push(drawer(D('0')));
    f.state.bills.push(bill());
    const packet = await f.prepare();
    expect(packet.financial.status).toBe('READY');
    expect(packet.financial.data?.amounts.netSales).toMatchObject({ value: '90' });
    expect(packet.financial.data?.amounts.cashCounted.value).toBe('0');
    expect(packet).toMatchObject({
      scope: { organizationId: 'org1', branchId: 'b1' },
      period: { from: input.businessDate, to: input.businessDate, basis: 'BUSINESS_DATE' },
      financial: { data: { currency: 'PKR', moneyUnit: 'DECIMAL_MAJOR', source: 'closePreview' } },
    });
  });

  it('keeps earlier-day bill collections on tender date without adding sales', async () => {
    const f = fixture();
    const earlier = new Date('2026-09-10T00:00:00Z');
    f.state.bills.push(bill('SETTLED', earlier));
    f.state.tenders.push({
      businessDate: date,
      bill: { businessDate: earlier },
      type: 'CASH',
      amount: D('90.15'),
      tipAmount: D('0.25'),
    });
    const packet = await f.prepare();
    expect(packet.financial.data?.amounts.netSales.value).toBe('0');
    expect(packet.financial.data?.amounts.tipTotal.value).toBe('0.25');
    expect(packet.financial.data?.tenders).toEqual([
      { tenderType: 'CASH', amount: '90.15', tipAmount: '0.25', count: 1 },
    ]);
    expect(f.db.restaurantTender.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessDate: date, bill: { branchId: 'b1' } } })
    );
  });

  it('uses authoritative corrected close amounts and existing coverage/freshness', async () => {
    const f = fixture();
    f.state.closes.push(close(), {
      ...close('corrected', 'close1'),
      grossSales: D('300.25'),
      netSales: D('300.25'),
    });
    f.state.drawers.push(drawer(null));
    const packet = await f.prepare();
    expect(packet.status).toBe('ALREADY_CLOSED');
    expect(packet.financial.data).toMatchObject({
      existingCloseId: 'corrected',
      source: 'readPaymentsReport',
      amounts: {
        netSales: { value: '300.25' },
        cashCounted: { value: null },
        cashVariance: { value: null },
      },
      cashCountCoverage: { status: 'INCOMPLETE' },
      reportFreshness: { status: 'PARTIAL', closedDayCount: 1, unprojectedDayCount: 1 },
    });
    expect(packet.unattendedCloseReady).toBe(false);
  });

  it('does not read finance or currency for an operational-only consumer', async () => {
    const f = fixture();
    const packet = await f.prepare(input, { ...access, financial: false });
    expect(packet.financial).toMatchObject({
      status: 'UNKNOWN',
      data: null,
      missingEvidence: [{ code: 'FINANCIAL_PERMISSION_REQUIRED' }],
    });
    expect(f.db.restaurantBill.findMany).not.toHaveBeenCalled();
    expect(f.db.restaurantTender.findMany).not.toHaveBeenCalled();
    expect(f.db.organization.findUnique).not.toHaveBeenCalled();
  });

  it('withholds amounts when a close correction changes the source during preparation', async () => {
    const f = fixture();
    f.state.closes.push(close(), close('corrected', 'close1'));
    f.db.restaurantDailyClose.findMany.mockResolvedValueOnce([close()]);
    const packet = await f.prepare();
    expect(packet.financial).toMatchObject({
      status: 'UNKNOWN',
      data: null,
      missingEvidence: [
        { code: 'SOURCE_CHANGED', source: 'src/lib/restaurant/daily-close.ts#resolveChainTip' },
      ],
    });
    expect(packet.unattendedCloseReady).toBe(false);
  });

  it('does not read operational records for a financial-only consumer', async () => {
    const f = fixture();
    f.state.unbilled.push({ id: 'private-order' });
    const packet = await f.prepare(input, { ...access, operational: false });
    expect(packet.operational.data).toBeNull();
    expect(f.db.restaurantOrder.count).not.toHaveBeenCalled();
    expect(f.db.restaurantOrder.findMany).not.toHaveBeenCalled();
    expect(packet.financial.data?.closeGuards).not.toHaveProperty('unbilledOrderCount');
    expect(packet.financial.data?.closeGuards.allBillsResolved).toBe(true);
    expect(packet.financial.blockers).toEqual([]);
    expect(packet.financial.status).toBe('UNKNOWN');
    expect(packet.financial.missingEvidence).toEqual([
      expect.objectContaining({ code: 'ORDER_CLOSE_GUARD_UNAVAILABLE', recordIds: [] }),
    ]);
    expect(JSON.stringify(packet)).not.toContain('private-order');
    expect(packet.status).toBe('UNKNOWN');
  });

  it('does not infer a clear order guard from financial-only access even on an empty day', async () => {
    const f = fixture();
    const packet = await f.prepare(input, { ...access, operational: false });
    expect(packet.financial.status).toBe('UNKNOWN');
    expect(packet.financial.data?.closeGuards).not.toHaveProperty('unbilledOrderCount');
    expect(f.db.restaurantOrder.count).not.toHaveBeenCalled();
  });

  it('preserves known blockers and closed status when order evidence is unauthorized', async () => {
    const f = fixture();
    f.state.bills.push(bill('OPEN'));
    expect((await f.prepare(input, { ...access, operational: false })).financial.status).toBe(
      'BLOCKED'
    );
    f.state.closes.push(close());
    expect((await f.prepare(input, { ...access, operational: false })).financial.status).toBe(
      'ALREADY_CLOSED'
    );
  });

  it('blocks financial preparation when authorized order evidence blocks daily close', async () => {
    const f = fixture();
    f.state.unbilled.push({ id: 'order1' });
    const packet = await f.prepare();
    expect(packet.status).toBe('BLOCKED');
    expect(packet.financial.status).toBe('BLOCKED');
    expect(packet.financial.data?.closeGuards).toMatchObject({
      allBillsResolved: false,
      openBillCount: 0,
      unbilledOrderCount: 1,
      openDrawerCount: 0,
    });
    expect(packet.financial.blockers).toMatchObject([
      {
        code: 'UNBILLED_ORDERS',
        source: 'src/lib/restaurant/daily-close.ts#assertReadyToClose',
        allowedExistingRoutes: [{ procedure: 'restaurantOrders.listOrders' }],
      },
    ]);
  });

  it('includes the authoritative guard for active orders without items', async () => {
    const f = fixture();
    // The existing operational handover predicate requires items; the close
    // command also blocks empty active orders. Exercise that distinction.
    f.db.restaurantOrder.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const packet = await f.prepare(input, { ...access, allowedRoutes: [] });
    expect(packet.operational.data?.unbilledOrders.count).toBe(0);
    expect(packet.financial.status).toBe('BLOCKED');
    expect(packet.financial.data?.closeGuards.allBillsResolved).toBe(false);
    expect(packet.financial.blockers[0]).toMatchObject({
      code: 'UNBILLED_ORDERS',
      allowedExistingRoutes: [],
    });
    expect(f.db.restaurantOrder.count).toHaveBeenLastCalledWith({
      where: {
        branchId: 'b1',
        businessDate: date,
        status: { in: ['OPEN', 'SENT', 'IN_PREPARATION', 'READY', 'SERVED', 'PAYMENT_PENDING'] },
        bills: { none: { status: { in: ['OPEN', 'SETTLED'] } } },
      },
    });
  });

  it('proves tenant branch membership before domain reads and rejects missing grants', async () => {
    const f = fixture();
    f.db.restaurantBranch.findFirst.mockResolvedValueOnce(null);
    await expect(f.prepare()).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(f.db.restaurantBranch.findFirst).toHaveBeenCalledWith({
      where: { id: 'b1', organizationId: 'org1' },
      select: { id: true, timezone: true, businessDayCutoff: true },
    });
    expect(f.db.restaurantBill.findMany).not.toHaveBeenCalled();
    await expect(
      f.prepare(input, { ...access, financial: false, operational: false })
    ).rejects.toMatchObject({ reason: 'FORBIDDEN' });
  });

  it('shows real unbilled order evidence with bounded IDs and a precise coverage limit', async () => {
    const f = fixture();
    f.state.unbilled.push(...Array.from({ length: 102 }, (_, i) => ({ id: `order${i}` })));
    const packet = await f.prepare();
    expect(packet.operational.status).toBe('BLOCKED');
    expect(packet.operational.data?.unbilledOrders).toMatchObject({ count: 102, truncated: true });
    expect(packet.operational.blockers[0].recordIds).toHaveLength(100);
    expect(f.db.restaurantOrder.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org1',
        branchId: 'b1',
        businessDate: date,
        status: { not: 'CANCELLED' },
        items: { some: { status: { not: 'VOIDED' } } },
        bills: { none: { status: { not: 'VOID' } } },
      },
    });
    expect(
      packet.operational.missingEvidence.some(
        (item) => item.code === 'PARTIAL_BILL_COVERAGE_UNAVAILABLE'
      )
    ).toBe(true);
  });

  it('distinguishes unavailable operational reads from an observed zero', async () => {
    const f = fixture();
    f.db.restaurantOrder.count.mockRejectedValueOnce(new Error('private database details'));
    const packet = await f.prepare();
    expect(packet.operational).toMatchObject({
      status: 'UNKNOWN',
      data: null,
      missingEvidence: [{ code: 'OPERATIONAL_SOURCE_UNAVAILABLE' }],
    });
    expect(JSON.stringify(packet)).not.toContain('private database details');
    expect(packet.financial.status).toBe('UNKNOWN');
    expect(packet.financial.missingEvidence).toEqual([
      expect.objectContaining({ code: 'ORDER_CLOSE_GUARD_UNAVAILABLE' }),
    ]);
  });

  it('does not label financial guards ready when only the authoritative order count fails', async () => {
    const f = fixture();
    f.db.restaurantOrder.count
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('guard unavailable'));
    const packet = await f.prepare();
    expect(packet.financial.status).toBe('UNKNOWN');
    expect(packet.financial.data?.closeGuards).not.toHaveProperty('unbilledOrderCount');
  });

  it('distinguishes unavailable financial reads and missing currency from zero money', async () => {
    const f = fixture();
    f.db.restaurantTender.findMany.mockRejectedValueOnce(new Error('reader unavailable'));
    expect((await f.prepare()).financial).toMatchObject({ status: 'UNKNOWN', data: null });
    f.db.organization.findUnique.mockResolvedValueOnce({ currency: null });
    const packet = await f.prepare();
    expect(packet.financial.data?.amounts.netSales.value).toBeNull();
    expect(packet.financial.data?.tenders).toBeNull();
    expect(
      packet.financial.missingEvidence.some((item) => item.code === 'CURRENCY_UNAVAILABLE')
    ).toBe(true);
  });

  it.each([-CLOSE_PACKET_MAX_AGE_MS - 1, 1])(
    'rejects stale or future request anchor offset %i without domain reads',
    async (offset) => {
      const f = fixture();
      const packet = await f.prepare({
        ...input,
        asOf: new Date(now.getTime() + offset).toISOString(),
      });
      expect(packet.freshness.status).toBe('UNAVAILABLE');
      expect(packet.financial.data).toBeNull();
      expect(packet.operational.data).toBeNull();
      expect(f.db.restaurantBill.findMany).not.toHaveBeenCalled();
      expect(f.db.restaurantOrder.count).not.toHaveBeenCalled();
    }
  );

  it('expires preparation that crosses its freshness window', async () => {
    const f = fixture();
    f.db.restaurantOrder.findMany.mockImplementationOnce(async () => {
      vi.setSystemTime(now.getTime() + CLOSE_PACKET_MAX_AGE_MS + 1);
      return [];
    });
    const packet = await f.prepare();
    expect(packet.financial.data).toBeNull();
    expect(packet.freshness.status).toBe('UNAVAILABLE');
  });

  it('uses branch cutoff to reject a future business date and validates dates', async () => {
    const f = fixture();
    vi.setSystemTime(new Date('2026-09-11T20:00:00Z'));
    await expect(f.prepare({ ...input, businessDate: '2026-09-12' })).rejects.toMatchObject({
      reason: 'INVALID',
    });
    await expect(f.prepare({ ...input, businessDate: '2026-02-30' })).rejects.toMatchObject({
      reason: 'INVALID',
    });
    await expect(f.prepare({ ...input, asOf: 'nonsense' })).rejects.toMatchObject({
      reason: 'INVALID',
    });
    expect(f.db.restaurantBill.findMany).not.toHaveBeenCalled();
  });

  it('repeated reads have no domain effects and gather fresh preparation again', async () => {
    const f = fixture();
    const before = JSON.stringify(f.state);
    const first = await f.prepare();
    const second = await f.prepare();
    expect(second).toEqual(first);
    expect(JSON.stringify(f.state)).toBe(before);
    expect(f.write).not.toHaveBeenCalled();
    f.state.bills.push(bill('OPEN'));
    vi.setSystemTime(now.getTime() + 1_000);
    const third = await f.prepare({ ...input, asOf: new Date().toISOString() });
    expect(third.financial.status).toBe('BLOCKED');
    expect(third.freshness.completedAt).not.toBe(first.freshness.completedAt);
    expect(f.db.restaurantTender.findMany).toHaveBeenCalledTimes(3);
  });
});
