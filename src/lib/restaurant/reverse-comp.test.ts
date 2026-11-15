import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { reverseCompLine } from './bills';

const D = (value: string) => new Prisma.Decimal(value);
const input = {
  billId: 'bill',
  branchId: 'branch',
  billLineId: 'comped',
  reason: 'mistaken comp',
  approvingStaffProfileId: 'manager',
  terminalSessionId: 'session',
  actor: { staffProfileId: 'operator', deviceId: 'device', idempotencyKey: 'reverse' },
};

function fixture({ policy = true, fullyComped = false } = {}) {
  const lines = [
    {
      id: 'comped',
      lineSubtotal: D('40'),
      compAmount: D('40'),
      serviceChargeAmount: D('0'),
      compReason: 'original',
      compCoAuthorizationId: 'original-approval',
    },
    {
      id: 'remaining',
      lineSubtotal: D('60'),
      compAmount: D(fullyComped ? '60' : '0'),
      serviceChargeAmount: D(policy && !fullyComped ? '6' : '0'),
    },
  ];
  const bill = {
    id: 'bill',
    orderId: 'order',
    splitKind: 'NONE',
    branchId: 'branch',
    businessDate: new Date('2026-11-15'),
    status: 'OPEN',
    compTotal: D(fullyComped ? '100' : '40'),
    discountTotal: D('0'),
    grandTotal: D(fullyComped ? '0' : policy ? '66' : '60'),
    serviceChargeBasis: D(policy && !fullyComped ? '60' : '0'),
    serviceChargeTotal: D(policy && !fullyComped ? '6' : '0'),
    order: {
      serviceChargePolicyVersion: policy ? { id: 'original-policy', rate: D('0.10') } : null,
    },
    lines,
    tenders: [{ id: 'partial', amount: D('20') }],
  };
  let saved: { commandType: string; resultRef: string } | null = null;
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    restaurantBranch: { findUnique: vi.fn(async () => ({ organizationId: 'org' })) },
    restaurantDailyClose: { findFirst: vi.fn(async () => null as unknown) },
    restaurantBill: {
      findFirst: vi.fn(async () => bill as typeof bill | null),
      findMany: vi.fn(async () => [
        { id: bill.id, lines: bill.lines.map((line) => ({ lineSubtotal: line.lineSubtotal })) },
      ]),
      update: vi.fn(),
    },
    restaurantBillLine: { update: vi.fn() },
    restaurantCoAuthorization: { create: vi.fn(async () => ({ id: 'reversal-approval' })) },
    restaurantMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => saved),
      create: vi.fn(async ({ data }: { data: typeof saved }) => {
        saved = data;
      }),
    },
    restaurantTender: { update: vi.fn(), delete: vi.fn() },
  };
  const db = {
    $transaction: (work: (db: unknown) => Promise<unknown>) => work(tx),
  } as unknown as ScopedDb;
  return { db, tx, bill };
}

describe('reverseCompLine', () => {
  it('restores a mistaken comp and its pinned service charge after partial tender', async () => {
    const { db, tx, bill } = fixture();
    const tenders = JSON.stringify(bill.tenders);
    expect(await reverseCompLine(db, input)).toEqual({
      billId: 'bill',
      billLineId: 'comped',
      replayed: false,
    });
    const locks = tx.$queryRaw.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][];
    expect(locks[0]![0].join('')).toContain('FOR UPDATE OF o');
    expect(locks[1]![0].join('')).toContain('restaurant_bills');
    const update = tx.restaurantBill.update.mock.calls[0] as unknown as [
      { data: Record<string, Prisma.Decimal> },
    ];
    expect(update[0].data.compTotal!.toFixed(2)).toBe('0.00');
    expect(update[0].data.grandTotal!.toFixed(2)).toBe('110.00');
    expect(update[0].data.serviceChargeTotal!.toFixed(2)).toBe('10.00');
    expect(update[0].data).not.toHaveProperty('discountTotal');
    expect(update[0].data).not.toHaveProperty('taxTotal');
    expect(tx.restaurantBillLine.update).toHaveBeenCalledWith({
      where: { id: 'comped' },
      data: { compAmount: D('0'), serviceChargeAmount: D('4'), lineTotal: D('44') },
    });
    expect(tx.restaurantCoAuthorization.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actingStaffProfileId: 'operator',
        approvingStaffProfileId: 'manager',
        capability: 'orders:complimentary',
        terminalSessionId: 'session',
        targetId: 'comped',
        reason: expect.stringContaining(
          'original approval original-approval; principal 40.00; service delta 4.00: mistaken comp'
        ),
      }),
      select: { id: true },
    });
    expect(JSON.stringify(bill.tenders)).toBe(tenders);
    expect(tx.restaurantTender.update).not.toHaveBeenCalled();
    expect(tx.restaurantTender.delete).not.toHaveBeenCalled();
  });

  it('restores cleared service evidence from the order policy after a full comp', async () => {
    const { db, tx } = fixture({ fullyComped: true });
    await reverseCompLine(db, input);
    expect(tx.restaurantBill.update).toHaveBeenCalledWith({
      where: { id: 'bill' },
      data: expect.objectContaining({
        serviceChargePolicyVersionId: 'original-policy',
        serviceChargeRate: D('0.10'),
        serviceChargeTaxTreatment: 'NON_TAXABLE',
        serviceChargeBasis: D('40'),
        serviceChargeTotal: D('4'),
        grandTotal: D('44'),
      }),
    });
    expect(tx.restaurantBillLine.update).toHaveBeenCalledTimes(1);
  });

  it('does not add a service charge to an order without a pinned policy', async () => {
    const { db, tx } = fixture({ policy: false });
    await reverseCompLine(db, input);
    expect(tx.restaurantBill.update).toHaveBeenCalledWith({
      where: { id: 'bill' },
      data: expect.objectContaining({ serviceChargeTotal: D('0'), grandTotal: D('100') }),
    });
  });

  it('preserves the original split allocation when independent rounding would add a cent', async () => {
    const { db, tx, bill } = fixture();
    bill.splitKind = 'BY_ITEM';
    bill.lines[0]!.lineSubtotal = D('0.01');
    bill.lines[0]!.compAmount = D('0.01');
    bill.lines[1]!.lineSubtotal = D('0.14');
    bill.serviceChargeTotal = D('0.01');
    bill.serviceChargeBasis = D('0.14');
    bill.compTotal = D('0.01');
    bill.grandTotal = D('0.15');
    // 0.03 service over two 0.15 bills: the first receives 0.02, this one 0.01.
    tx.restaurantBill.findMany.mockResolvedValue([
      { id: 'a', lines: [{ lineSubtotal: D('0.15') }] },
      { id: 'bill', lines: bill.lines },
    ]);
    await reverseCompLine(db, input);
    expect(tx.restaurantBill.update).toHaveBeenCalledWith({
      where: { id: 'bill' },
      data: expect.objectContaining({
        serviceChargeTotal: D('0.01'),
        serviceChargeBasis: D('0.15'),
        grandTotal: D('0.16'),
      }),
    });
  });

  it('preserves existing discounts instead of reclaiming returned loyalty points', async () => {
    const { db, tx, bill } = fixture();
    bill.discountTotal = D('5');
    bill.grandTotal = D('61');
    await reverseCompLine(db, input);
    expect(tx.restaurantBill.update).toHaveBeenCalledWith({
      where: { id: 'bill' },
      data: expect.objectContaining({ grandTotal: D('105') }),
    });
    const update = tx.restaurantBill.update.mock.calls[0] as unknown as [{ data: object }];
    expect(update[0].data).not.toHaveProperty('discountTotal');
  });

  it('rejects a key already used by another money command', async () => {
    const { db, tx } = fixture();
    tx.restaurantMoneyIdempotencyKey.findUnique.mockResolvedValue({
      commandType: 'bill.comp',
      resultRef: 'comped|0.00',
    });
    await expect(reverseCompLine(db, input)).rejects.toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    expect(tx.restaurantCoAuthorization.create).not.toHaveBeenCalled();
    expect(tx.restaurantBill.update).not.toHaveBeenCalled();
  });

  it('replays exactly once, including after settlement or day close', async () => {
    const { db, tx, bill } = fixture();
    await reverseCompLine(db, input);
    bill.status = 'SETTLED';
    expect((await reverseCompLine(db, input)).replayed).toBe(true);
    expect(tx.restaurantBill.update).toHaveBeenCalledTimes(1);
    expect(tx.restaurantCoAuthorization.create).toHaveBeenCalledTimes(1);
    expect(tx.restaurantDailyClose.findFirst).toHaveBeenCalledTimes(1);
    await expect(reverseCompLine(db, { ...input, billLineId: 'another' })).rejects.toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(reverseCompLine(db, { ...input, reason: 'changed' })).rejects.toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it.each(['SETTLED', 'VOID'])('rejects a %s bill before writing', async (status) => {
    const { db, tx, bill } = fixture();
    bill.status = status;
    await expect(reverseCompLine(db, input)).rejects.toMatchObject({ reason: 'BILL_NOT_OPEN' });
    expect(tx.restaurantBill.update).not.toHaveBeenCalled();
    expect(tx.restaurantCoAuthorization.create).not.toHaveBeenCalled();
  });

  it('denies a missing or foreign-branch bill before replay lookup', async () => {
    const { db, tx } = fixture();
    tx.restaurantBill.findFirst.mockResolvedValue(null);
    await expect(reverseCompLine(db, input)).rejects.toMatchObject({ reason: 'BILL_NOT_FOUND' });
    expect(tx.restaurantBill.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bill', branchId: 'branch' } })
    );
    expect(tx.restaurantMoneyIdempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  it('requires a comped line belonging to this bill and a nonempty reason', async () => {
    const { db, tx } = fixture();
    await expect(reverseCompLine(db, { ...input, billLineId: 'foreign' })).rejects.toMatchObject({
      reason: 'LINE_NOT_FOUND',
    });
    await expect(reverseCompLine(db, { ...input, billLineId: 'remaining' })).rejects.toMatchObject({
      reason: 'NOT_COMPED',
    });
    await expect(reverseCompLine(db, { ...input, reason: ' ' })).rejects.toMatchObject({
      reason: 'REASON_REQUIRED',
    });
    expect(tx.restaurantCoAuthorization.create).not.toHaveBeenCalled();
    expect(tx.restaurantMoneyIdempotencyKey.create).not.toHaveBeenCalled();
  });

  it('requires approval and rejects self-approval without fresh owner PIN evidence', async () => {
    const { db, tx } = fixture();
    await expect(
      reverseCompLine(db, { ...input, approvingStaffProfileId: 'operator' })
    ).rejects.toThrow(/second identity/);
    expect(tx.restaurantMoneyIdempotencyKey.create).not.toHaveBeenCalled();
    expect(tx.restaurantBillLine.update).not.toHaveBeenCalled();
  });

  it('rejects corrections to a closed business day', async () => {
    const { db, tx } = fixture();
    tx.restaurantDailyClose.findFirst.mockResolvedValue({ id: 'closed' });
    await expect(reverseCompLine(db, input)).rejects.toMatchObject({ reason: 'CLOSE_EXISTS' });
    expect(tx.restaurantCoAuthorization.create).not.toHaveBeenCalled();
    expect(tx.restaurantBill.update).not.toHaveBeenCalled();
  });
});
