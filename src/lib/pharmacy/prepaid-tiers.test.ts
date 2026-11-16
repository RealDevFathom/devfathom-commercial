import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import {
  movePrepaid,
  prepaidTierSettings,
  publishPrepaidSettings,
  qualifyingTier,
} from './prepaid-tiers';
import { pricePrepaidSale, prepaidLineDiscount } from './prepaid-discount';
import { saleAllocationMoney, priceReturn } from './sale-line-money';
import { receiptTierLines } from './counter-receipt';
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' };
const bronze = { name: 'Bronze', upfrontMinor: 10000, discountBasisPoints: 200 };
function fixture(balance = 0, refundable = 0) {
  let account = {
    id: 'account-a',
    organizationId: 'org-a',
    customerId: 'customer-a',
    balanceMinor: balance,
    refundableMinor: refundable,
    qualifyingMinor: balance,
    tierName: balance ? 'Bronze' : null,
    discountBasisPoints: balance ? 200 : 0,
    tierVersionId: balance ? 'version-a' : null,
  };
  const entries: Array<Record<string, unknown>> = [];
  const db = {
    $queryRaw: vi.fn(async () => []),
    pharmacyCustomer: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; organizationId: string } }) =>
        where.id === 'customer-a' && where.organizationId === 'org-a'
          ? { id: 'customer-a', prepaidAccount: { ...account } }
          : null
      ),
    },
    pharmacyBranch: { findFirst: vi.fn(async () => ({ id: 'branch-a' })) },
    pharmacyPrepaidTierVersion: {
      findFirst: vi.fn(async () => ({ actorId: 'owner-a' })),
      findMany: vi.fn(async () => [
        { id: 'version-a', version: 1, tiers: [bronze], refundable: true },
      ]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
    pharmacyPrepaidAccount: {
      upsert: vi.fn(async () => ({ ...account })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { balanceMinor: number; refundableMinor: number };
          data: Partial<typeof account>;
        }) => {
          if (
            account.balanceMinor !== where.balanceMinor ||
            account.refundableMinor !== where.refundableMinor
          )
            return { count: 0 };
          account = { ...account, ...data };
          return { count: 1 };
        }
      ),
    },
    pharmacyPrepaidEntry: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId_idempotencyKey: { idempotencyKey: string } };
        }) => {
          const entry = entries.find(
            (e) => e.idempotencyKey === where.organizationId_idempotencyKey.idempotencyKey
          );
          return entry ? { ...entry, account } : null;
        }
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `entry-${entries.length}`,
          createdAt: new Date(),
          ...data,
          tenderId: data.tenderId ?? null,
          refundId: data.refundId ?? null,
        };
        entries.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { kind: string; tenderId?: string } }) =>
          entries.find((e) => e.kind === where.kind && e.tenderId === where.tenderId)
      ),
      aggregate: vi.fn(async () => ({ _sum: { amountMinor: 0, refundableDeltaMinor: 0 } })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    pharmacySaleLine: { update: vi.fn(async () => ({})) },
    pharmacySaleLineAllocation: { update: vi.fn() },
  };
  return { db, entries, account: () => account };
}
const payment = {
  customerId: 'customer-a',
  kind: 'PAYMENT' as const,
  amountMinor: 10000,
  idempotencyKey: 'payment-1',
};
describe('prepaid customer money', () => {
  it('requires owner-authored settings; empty settings seed no tier or rate', async () => {
    expect(qualifyingTier([], 1000000)).toBeNull();
    const f = fixture();
    f.db.pharmacyPrepaidTierVersion.findMany.mockResolvedValueOnce([]);
    await expect(movePrepaid(f.db as never, scope, payment)).rejects.toThrow(
      'save prepaid settings'
    );
    expect(f.entries).toHaveLength(0);
  });
  it('validates tier names, thresholds and discount rates', () => {
    for (const tiers of [
      [bronze, { ...bronze, name: 'bronze', upfrontMinor: 20000 }],
      [bronze, { ...bronze, name: 'Silver' }],
      [{ ...bronze, discountBasisPoints: 10001 }],
      [{ ...bronze, upfrontMinor: 0 }],
    ])
      expect(prepaidTierSettings.safeParse({ refundable: true, tiers }).success).toBe(false);
  });
  it('publishes a dated version without rewriting the prior one', async () => {
    const f = fixture();
    await publishPrepaidSettings(f.db as never, scope, { refundable: false, tiers: [bronze] });
    expect(f.db.pharmacyPrepaidTierVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 2, refundable: false, tiers: [bronze] }),
    });
  });
  it('qualifies by cumulative upfront payments, loses tier at zero and restarts qualification', async () => {
    const f = fixture();
    await movePrepaid(f.db as never, scope, { ...payment, amountMinor: 5000 });
    expect(f.account().tierName).toBeNull();
    await movePrepaid(f.db as never, scope, {
      ...payment,
      amountMinor: 5000,
      idempotencyKey: 'payment-2',
    });
    expect(f.account()).toMatchObject({ balanceMinor: 10000, tierName: 'Bronze' });
    await movePrepaid(f.db as never, scope, {
      ...payment,
      kind: 'SPEND',
      amountMinor: 10000,
      tenderId: 'tender-a',
      idempotencyKey: 'spend-1',
    });
    expect(f.account()).toMatchObject({ balanceMinor: 0, tierName: null, qualifyingMinor: 0 });
    expect(f.entries[2]).toMatchObject({
      amountMinor: -10000,
      tierBefore: 'Bronze',
      tierAfter: null,
    });
    await movePrepaid(f.db as never, scope, {
      ...payment,
      amountMinor: 100,
      idempotencyKey: 'payment-3',
    });
    expect(f.account().tierName).toBeNull();
    expect(f.db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'pharmacy.prepaid.tierChanged',
          metadata: expect.objectContaining({ before: 'Bronze', after: null }),
        }),
      })
    );
  });
  it('records refundable terms and rejects cash refunds of non-refundable funds', async () => {
    const f = fixture();
    f.db.pharmacyPrepaidTierVersion.findMany.mockResolvedValue([
      { id: 'version-a', version: 1, tiers: [bronze], refundable: false },
    ]);
    const entry = await movePrepaid(f.db as never, scope, payment);
    expect(entry).toMatchObject({ refundable: false, balanceAfterMinor: 10000 });
    await expect(
      movePrepaid(f.db as never, scope, { ...payment, kind: 'REFUND', idempotencyKey: 'refund-1' })
    ).rejects.toThrow('not refundable');
    expect(f.entries).toHaveLength(1);
  });
  it('spends non-refundable funds first and restores the original refundability on a return', async () => {
    const f = fixture(10000, 4000);
    await movePrepaid(f.db as never, scope, {
      ...payment,
      kind: 'SPEND',
      amountMinor: 8000,
      tenderId: 'tender-a',
    });
    expect(f.account()).toMatchObject({ balanceMinor: 2000, refundableMinor: 2000 });
    await movePrepaid(f.db as never, scope, {
      ...payment,
      kind: 'RESTORE',
      amountMinor: 4000,
      tenderId: 'tender-a',
      refundId: 'refund-a',
      idempotencyKey: 'restore-a',
    });
    expect(f.account()).toMatchObject({ balanceMinor: 6000, refundableMinor: 3000 });
  });
  it('replays the same payment once and rejects changed details or foreign customers', async () => {
    const f = fixture();
    await movePrepaid(f.db as never, scope, payment);
    await expect(movePrepaid(f.db as never, scope, payment)).resolves.toMatchObject({
      replayed: true,
    });
    expect(f.entries).toHaveLength(1);
    await expect(
      movePrepaid(f.db as never, scope, { ...payment, amountMinor: 10001 })
    ).rejects.toThrow('different details');
    await expect(
      movePrepaid(f.db as never, scope, {
        ...payment,
        customerId: 'other',
        idempotencyKey: 'other-key',
      })
    ).rejects.toThrow('unavailable');
  });
  it('two concurrent sales cannot both spend the same balance even if both read it before either writes', async () => {
    const f = fixture(10000, 10000);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.db.pharmacyPrepaidAccount.upsert.mockImplementation(async () => {
      const snapshot = { ...f.account() };
      if (++arrivals === 2) release();
      await barrier;
      return snapshot;
    });
    const results = await Promise.allSettled(
      ['a', 'b'].map((id) =>
        movePrepaid(f.db as never, scope, {
          ...payment,
          kind: 'SPEND',
          amountMinor: 8000,
          tenderId: `tender-${id}`,
          idempotencyKey: `spend-${id}`,
        })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(f.account().balanceMinor).toBe(2000);
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]!.amountMinor).toBe(-8000);
  });
});
const line = {
  id: 'line-a',
  grossMinor: 10000,
  discountMinor: 0,
  quantity: 2,
  unitPriceMinor: 5000,
  canonicalUnits: 2,
  medicine: { rx: false, restricted: false, controlled: false },
  allocations: [
    {
      id: 'cheap',
      canonicalUnits: 1,
      grossMinor: 5000,
      discountMinor: 0,
      lot: { unitCostMinor: 1000 },
    },
    {
      id: 'floor',
      canonicalUnits: 1,
      grossMinor: 5000,
      discountMinor: 0,
      lot: { unitCostMinor: 5000 },
    },
  ],
};
describe('prepaid discount and receipts', () => {
  it('applies the bill percentage while preserving every lot floor and all regulated-line restrictions', () => {
    expect(prepaidLineDiscount(line, 200)).toEqual({ amountMinor: 200, allocations: [200, 0] });
    expect(prepaidLineDiscount(line, 10000)).toEqual({ amountMinor: 4000, allocations: [4000, 0] });
    for (const flag of ['rx', 'restricted', 'controlled'])
      expect(
        prepaidLineDiscount({ ...line, medicine: { ...line.medicine, [flag]: true } }, 200)
          .amountMinor
      ).toBe(0);
  });
  it('does not price a legacy mixed allocation whose charged money is unavailable', () => {
    expect(
      prepaidLineDiscount(
        {
          ...line,
          allocations: [
            line.allocations[0]!,
            { ...line.allocations[1]!, grossMinor: null, discountMinor: null },
          ],
        },
        200
      ).amountMinor
    ).toBe(0);
  });
  it('freezes the quote on first tender, retains immutable allocation evidence and prices returns exactly', async () => {
    const f = fixture(10000, 10000);
    const sale = {
      id: 'sale-a',
      organizationId: 'org-a',
      customerId: 'customer-a',
      status: 'OPEN',
      tenders: [],
      lines: [line],
    };
    const quote = await pricePrepaidSale(f.db as never, sale);
    expect(quote.lines[0]!.discountMinor).toBe(200);
    expect(f.db.pharmacySaleLine.update).not.toHaveBeenCalled();
    const priced = await pricePrepaidSale(f.db as never, sale, true);
    expect(f.db.pharmacySaleLineAllocation.update).not.toHaveBeenCalled();
    const allocation = saleAllocationMoney(priced.lines[0]!);
    expect(allocation.map((a) => a.discountMinor)).toEqual([200, 0]);
    expect(priceReturn(priced.lines[0]!, 1, allocation[0])).toEqual({
      grossMinor: 5000,
      discountMinor: 200,
    });
    const frozen = await pricePrepaidSale(f.db as never, { ...priced, tenders: [{}] }, true);
    expect(frozen.lines[0]!.discountMinor).toBe(200);
  });
  it('prints a separate tier line without subtracting savings a second time', () => {
    expect(
      receiptTierLines(
        {
          lines: [
            { tierName: 'Bronze', tierDiscountMinor: 200 },
            { tierName: 'Bronze', tierDiscountMinor: 100 },
          ] as never,
        },
        'en'
      )
    ).toEqual(['Prepaid tier discount · Bronze: -3.00']);
  });
});
