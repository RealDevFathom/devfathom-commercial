import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn(async () => undefined) }));
vi.mock('./finance-postings', async () => {
  const actual = await vi.importActual<typeof import('./finance-postings')>('./finance-postings');
  return { ...actual, postLoyaltyReleaseEntry: vi.fn(actual.postLoyaltyReleaseEntry) };
});
vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));

import { lockCustomerConsent } from './consent-writer';
import { postLoyaltyReleaseEntry } from './finance-postings';
import { releaseVoidedSaleRedemptions } from './loyalty-void-release';
import { changeSaleStatus } from './sales';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

type Row = Record<string, unknown>;
function ledger(
  tenders: Row[],
  entries: Row[] = [
    { id: 'redeem-a', kind: 'REDEEM', tenderId: 'tender-a', customerId: 'customer-a', points: -20 },
  ]
) {
  const created: Row[] = [];
  const journal: Row[] = [];
  const db = {
    pharmacyTender: {
      findMany: vi.fn(async ({ where }: { where: { type?: unknown } }) =>
        tenders.filter((tender) =>
          where.type === 'LOYALTY'
            ? tender.type === 'LOYALTY'
            : where.type && typeof where.type === 'object'
              ? tender.type !== (where.type as { not: string }).not
              : true
        )
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          tenders.find((tender) => tender.id === where.id) ?? null
      ),
    },
    pharmacyLoyaltyPointsEntry: {
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          [...entries, ...created].find(
            (row) => row.tenderId === where.tenderId && row.kind === where.kind
          ) ?? null
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { organizationId_idempotencyKey: Row } }) =>
          created.find(
            (row) => row.idempotencyKey === where.organizationId_idempotencyKey.idempotencyKey
          ) ?? null
      ),
      aggregate: vi.fn(async ({ where }: { where: Row }) => ({
        _sum: {
          points:
            [...entries, ...created]
              .filter((row) => row.tenderId === where.tenderId && row.kind === where.kind)
              .reduce((sum, row) => sum + Number(row.points), 0) || null,
        },
      })),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `entry-${created.length}`, ...data };
        created.push(row);
        return row;
      }),
    },
    financeJournalEntry: {
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          journal.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `journal-${journal.length}`, ...data, lines: [] as Row[] };
        journal.push(row);
        return row;
      }),
      findFirstOrThrow: vi.fn(async ({ where }: { where: Row }) =>
        journal.find((row) => row.id === where.id)
      ),
    },
    financeJournalLine: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        (journal.find((row) => row.id === data.entryId)!.lines as Row[]).push(data);
        return data;
      }),
    },
  };
  return { db, created, journal };
}

const loyaltyTender = (amountMinor: number, refunds: number[] = []) => ({
  id: 'tender-a',
  type: 'LOYALTY',
  branchId: 'branch-a',
  saleId: 'sale-a',
  amountMinor,
  refunds: refunds.map((value) => ({ amountMinor: value })),
});

beforeEach(() => vi.clearAllMocks());

describe('DEV-764 releasing a redemption when its sale is voided', () => {
  it('gives back every redeemed point and reverses the redemption settlement', async () => {
    const { db, created } = ledger([loyaltyTender(2_000)]);
    const postJournal = vi.mocked(postLoyaltyReleaseEntry);

    await expect(releaseVoidedSaleRedemptions(db as never, scope, 'sale-a')).resolves.toEqual([
      { tenderId: 'tender-a', points: 20, amountMinor: 2_000 },
    ]);
    expect(created).toEqual([
      expect.objectContaining({
        kind: 'REDEMPTION_RELEASE',
        points: 20,
        customerId: 'customer-a',
        saleId: 'sale-a',
        tenderId: 'tender-a',
        branchId: 'branch-a',
        idempotencyKey: 'loyalty:release:tender-a',
      }),
    ]);
    expect(lockCustomerConsent).toHaveBeenCalledWith(db, 'org-a', 'customer-a');
    expect(postJournal).toHaveBeenCalledWith(db, scope, {
      tenderId: 'tender-a',
      amountMinor: 2_000,
      at: expect.any(Date),
    });
  });

  it('releases only what a refund has not already restored, and only once', async () => {
    const { db, created } = ledger(
      [loyaltyTender(2_000, [500])],
      [
        {
          id: 'redeem-a',
          kind: 'REDEEM',
          tenderId: 'tender-a',
          customerId: 'customer-a',
          points: -20,
        },
        {
          id: 'refund-a',
          kind: 'REFUND',
          tenderId: 'tender-a',
          customerId: 'customer-a',
          points: 5,
        },
      ]
    );
    const postJournal = vi.mocked(postLoyaltyReleaseEntry);

    await releaseVoidedSaleRedemptions(db as never, scope, 'sale-a');
    await releaseVoidedSaleRedemptions(db as never, scope, 'sale-a');

    expect(created).toEqual([expect.objectContaining({ kind: 'REDEMPTION_RELEASE', points: 15 })]);
    expect(postJournal).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({ amountMinor: 1_500 })
    );
  });

  it('posts the release as an additive, balanced reversal of the points settlement', async () => {
    const { db, journal } = ledger([loyaltyTender(2_000)]);
    await releaseVoidedSaleRedemptions(db as never, scope, 'sale-a');
    await releaseVoidedSaleRedemptions(db as never, scope, 'sale-a');
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      sourceKind: 'PHARMACY_TENDER',
      sourceId: 'tender-a',
      idempotencyKey: 'finance:PHARMACY_TENDER:tender-a:void-release',
    });
    expect(journal[0]!.lines).toEqual([
      expect.objectContaining({ accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: 2_000 }),
      expect.objectContaining({
        accountCode: 'LOYALTY_REDEMPTION',
        side: 'CREDIT',
        amountMinor: 2_000,
      }),
    ]);
  });

  it('lets a cashier void a bill paid only in points instead of demanding a refund', async () => {
    let status = 'OPEN';
    const { db, created, journal } = ledger([loyaltyTender(2_000)]);
    const voidDb = {
      ...db,
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-a', status, lines: [] }),
        updateMany: async ({ data }: { data: { status: string } }) => {
          status = data.status;
          return { count: 1 };
        },
      },
      pharmacySaleLineAllocation: { findMany: async () => [] },
      pharmacyStockMovement: { findMany: async () => [] },
      pharmacyControlledRegisterEntry: { findMany: async () => [] },
      pharmacySaleEvent: { create: vi.fn(async ({ data }) => data) },
    };

    await changeSaleStatus(voidDb as never, scope, 'sale-a', 'void', 'Customer left');

    expect(status).toBe('VOID');
    expect(created).toEqual([
      expect.objectContaining({ kind: 'REDEMPTION_RELEASE', points: 20, saleId: 'sale-a' }),
    ]);
    expect(journal).toEqual([expect.objectContaining({ sourceId: 'tender-a' })]);
    expect(voidDb.pharmacySaleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'VOIDED' }) })
    );
  });

  it('still refuses a void while money taken on the bill is unrefunded', async () => {
    let status = 'OPEN';
    const { db, created } = ledger([
      loyaltyTender(2_000),
      { id: 'tender-b', type: 'CASH', amountMinor: 500, refunds: [] },
    ]);
    const voidDb = {
      ...db,
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-a', status, lines: [] }),
        updateMany: async ({ data }: { data: { status: string } }) => {
          status = data.status;
          return { count: 1 };
        },
      },
    };
    await expect(changeSaleStatus(voidDb as never, scope, 'sale-a', 'void')).rejects.toThrow(
      'BILL_HAS_PAYMENTS'
    );
    expect(created).toEqual([]);
  });
});
