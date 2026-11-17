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
type Account = {
  id: string;
  organizationId: string;
  customerId: string;
  balanceMinor: number;
  refundableMinor: number;
  qualifyingMinor: number;
  tierName: string | null;
  discountBasisPoints: number;
  tierVersionId: string | null;
};
type Entry = {
  id: string;
  createdAt: Date;
  sequence: number;
  kind: string;
  amountMinor: number;
  refundableDeltaMinor: number;
  balanceAfterMinor: number;
  refundableAfterMinor: number;
  qualifyingAfterMinor: number;
  discountBasisPointsAfter: number;
  tierBefore: string | null;
  tierAfter: string | null;
  tierVersionId: string | null;
  tierVersionAfterId: string | null;
  branchId: string;
  idempotencyKey: string;
  tenderId: string | null;
  refundId: string | null;
};
type EntryData = Omit<Entry, 'id' | 'createdAt' | 'tenderId' | 'refundId'> & {
  tenderId?: string;
  refundId?: string;
};
type TierVersion = { id: string; version: number; tiers: unknown; refundable: boolean };
function fixture(balance = 0, refundable = 0) {
  let account: Account = {
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
  const entries: Entry[] = [];
  const db = {
    $queryRaw: vi.fn(async (): Promise<unknown[]> => []),
    $executeRaw: vi.fn(async () => 0),
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
      findMany: vi.fn(async (): Promise<TierVersion[]> => [
        { id: 'version-a', version: 1, tiers: [bronze], refundable: true },
      ]),
      create: vi.fn(async ({ data }: { data: Omit<TierVersion, 'id'> }) => data),
    },
    pharmacyPrepaidAccount: {
      upsert: vi.fn(async (): Promise<Account> => ({ ...account })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { balanceMinor: number; refundableMinor: number };
          data: Partial<Account>;
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
      create: vi.fn(async ({ data }: { data: EntryData }) => {
        const row: Entry = {
          id: `entry-${entries.length}`,
          createdAt: new Date(),
          ...data,
          tenderId: data.tenderId ?? null,
          refundId: data.refundId ?? null,
        };
        entries.push(row);
        return row;
      }),
      // The newest entry by sequence, or the original SPEND a RESTORE reverses.
      findFirst: vi.fn(async ({ where }: { where: { kind?: string; tenderId?: string } }) =>
        where.kind
          ? entries.find((e) => e.kind === where.kind && e.tenderId === where.tenderId)
          : entries.at(-1)
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
  it('numbers every entry and records the post-movement state the database reconciles', async () => {
    const f = fixture();
    await movePrepaid(f.db as never, scope, payment);
    await movePrepaid(f.db as never, scope, {
      ...payment,
      kind: 'SPEND',
      amountMinor: 2500,
      tenderId: 'tender-a',
      idempotencyKey: 'spend-seq',
    });
    expect(f.entries.map((e) => e.sequence)).toEqual([1, 2]);
    expect(f.entries[1]).toMatchObject({
      balanceAfterMinor: 7500,
      refundableAfterMinor: 7500,
      qualifyingAfterMinor: 10000,
      discountBasisPointsAfter: 200,
      tierBefore: 'Bronze',
      tierAfter: 'Bronze',
      tierVersionAfterId: 'version-a',
    });
    expect(f.account()).toMatchObject({
      balanceMinor: 7500,
      refundableMinor: 7500,
      qualifyingMinor: 10000,
      tierName: 'Bronze',
      discountBasisPoints: 200,
      tierVersionId: 'version-a',
    });
  });
});
const line = {
  id: 'line-a',
  createdAt: new Date('2026-11-17T08:00:00Z'),
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
    const frozen = await pricePrepaidSale(
      f.db as never,
      { ...priced, tenders: [{ createdAt: new Date('2026-11-17T08:05:00Z') }] },
      true
    );
    expect(frozen.lines[0]!.discountMinor).toBe(200);
    expect(f.db.pharmacySaleLine.update).toHaveBeenCalledTimes(1);
  });
  it('prices a line added after a partial payment and never reprices a line already paid for', async () => {
    const f = fixture(10000, 10000);
    const paidAt = new Date('2026-11-17T08:05:00Z');
    const eligible = {
      ...line,
      grossMinor: 1000,
      allocations: [
        {
          id: 'a1',
          canonicalUnits: 1,
          grossMinor: 1000,
          discountMinor: 0,
          lot: { unitCostMinor: 100 },
        },
      ],
    };
    const first = await pricePrepaidSale(
      f.db as never,
      {
        id: 'sale-b',
        organizationId: 'org-a',
        customerId: 'customer-a',
        status: 'OPEN',
        tenders: [],
        lines: [{ ...eligible, id: 'first' }],
      },
      true
    );
    // A second identical line arrives after 100 was paid from the prepaid balance.
    const added = {
      ...eligible,
      id: 'second',
      createdAt: new Date('2026-11-17T08:06:00Z'),
      allocations: [{ ...eligible.allocations[0]!, id: 'a2' }],
    };
    // A line already on the bill when the payment was taken but left unpriced stays as charged.
    const earlier = {
      ...eligible,
      id: 'earlier',
      allocations: [{ ...eligible.allocations[0]!, id: 'a0' }],
    };
    const sale = {
      ...first,
      tenders: [{ createdAt: paidAt }],
      lines: [...first.lines, earlier, added],
    };
    const quote = await pricePrepaidSale(f.db as never, sale);
    expect(
      quote.lines.map((l) => (l as { tierDiscountMinor?: number }).tierDiscountMinor ?? 0)
    ).toEqual([20, 0, 20]);
    expect(quote.lines.reduce((n, l) => n + l.grossMinor - l.discountMinor, 0)).toBe(2960);
    const priced = await pricePrepaidSale(f.db as never, sale, true);
    expect(f.db.pharmacySaleLine.update).toHaveBeenCalledTimes(2);
    expect(f.db.pharmacySaleLine.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { organizationId_id: { organizationId: 'org-a', id: 'second' } },
        data: expect.objectContaining({
          tierDiscountMinor: 20,
          tierAllocationDiscounts: { a2: 20 },
        }),
      })
    );
    const second = priced.lines[2]!;
    expect(saleAllocationMoney(second).map((a) => a.discountMinor)).toEqual([20]);
    expect(priceReturn(second, 1, saleAllocationMoney(second)[0])).toEqual({
      grossMinor: 1000,
      discountMinor: 20,
    });
    expect(
      receiptTierLines({ lines: priced.lines as never }, 'en').some(
        (text) => text.includes('Bronze') && text.includes('0.40')
      )
    ).toBe(true);
  });
  it('leaves a sale without an active funded tier undiscounted', async () => {
    const f = fixture();
    const sale = {
      id: 'sale-c',
      organizationId: 'org-a',
      customerId: 'customer-a',
      status: 'OPEN',
      tenders: [],
      lines: [line],
    };
    expect((await pricePrepaidSale(f.db as never, sale)).lines[0]!.discountMinor).toBe(0);
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
    ).toEqual([expect.stringMatching(/Bronze.*-3\.00/)]);
  });
});
