import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyCashCloseCheck } from './cash-close-check-operations';

const scope = { organizationId: 'org_1', branchId: 'branch_1' };
const businessDate = new Date('2026-10-30T00:00:00.000Z');
const line = (minor: number) => ({ quantity: 1, unitPriceMinor: minor, discountMinor: 0 });

function fixture() {
  const db = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ name: 'Main' }) },
    pharmacyDailyClose: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'close_1',
        sequence: 1,
        cashExpectedMinor: 5_000_000,
        cashCountedMinor: 4_700_000,
        cashVarianceMinor: -300_000,
        reason: 'Short at close',
      }),
      create: vi.fn(),
    },
    pharmacyDrawerSession: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'drawer_1',
          openedByActorId: 'user_1',
          openedAt: new Date('2026-10-30T04:00:00Z'),
          countedCashMinor: 4_700_000,
          movements: [
            { kind: 'OPENING_FLOAT', amountMinor: 1_000_000 },
            { kind: 'CASH_SALE', amountMinor: 4_000_000 },
            { kind: 'CLOSING_COUNT', amountMinor: 4_700_000 },
          ],
        },
      ]),
      update: vi.fn(),
    },
    pharmacySale: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'sale_1', lines: [line(2_000_000)] },
        { id: 'sale_2', lines: [line(2_000_000)] },
      ]),
    },
    pharmacyRefund: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'refund_1', saleId: 'sale_1', actorId: 'user_2', amountMinor: 1_000 },
        { id: 'refund_2', saleId: 'sale_2', actorId: 'user_2', amountMinor: 2_000 },
        { id: 'refund_3', saleId: 'sale_3', actorId: 'user_2', amountMinor: 3_000 },
        { id: 'refund_4', saleId: 'sale_1', actorId: 'user_2', amountMinor: 4_000 },
      ]),
    },
    pharmacySaleReturn: {
      findMany: vi.fn().mockResolvedValue([{ originalSaleId: 'sale_1' }]),
    },
    pharmacySaleEvent: {
      findMany: vi.fn().mockResolvedValue([
        // Karachi is UTC+5: 2026-10-29T20:00Z is already the 30th locally.
        {
          saleId: 'void_1',
          actorId: 'user_1',
          occurredAt: new Date('2026-10-29T20:00:00Z'),
          sale: { lines: [line(500)] },
        },
        // 2026-10-30T19:30Z is the 31st locally: another business day.
        {
          saleId: 'void_2',
          actorId: 'user_1',
          occurredAt: new Date('2026-10-30T19:30:00Z'),
          sale: { lines: [line(700)] },
        },
      ]),
    },
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
    user: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'user_1', name: 'Ayesha' },
        { id: 'user_2', name: 'Bilal' },
      ]),
    },
  };
  return { db, scoped: db as unknown as ScopedDb };
}

describe('readPharmacyCashCloseCheck (#728)', () => {
  it('reads close, refund and void evidence in tenant scope and runs the rules', async () => {
    const { db, scoped } = fixture();
    const check = await readPharmacyCashCloseCheck(scoped, scope, businessDate);

    expect(db.pharmacyDailyClose.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...scope, businessDate } })
    );
    expect(db.pharmacyRefund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...scope, businessDate } })
    );
    expect(db.pharmacySaleEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ...scope, kind: 'VOIDED' }),
      })
    );
    expect(db.pharmacySaleReturn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...scope, originalSaleId: { in: ['sale_1', 'sale_2', 'sale_3'] } },
      })
    );
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org_1' }) })
    );

    expect(check).toMatchObject({
      branchName: 'Main',
      timezone: 'Asia/Karachi',
      businessDate: '2026-10-30',
      closed: true,
      closeId: 'close_1',
      readOnly: true,
      totals: {
        grossSalesMinor: 4_000_000,
        completedSales: 2,
        refundCount: 4,
        refundTotalMinor: 10_000,
        unmatchedRefundCount: 2,
        voidCount: 1,
        voidValueMinor: 500,
        cashExpectedMinor: 5_000_000,
        cashCountedMinor: 4_700_000,
        cashVarianceMinor: -300_000,
      },
    });
    expect(check.findings.map((finding) => finding.kind)).toEqual([
      'CLOSE_VARIANCE',
      'UNMATCHED_REFUNDS',
      'ACTOR_CONCENTRATION',
    ]);
    expect(check.narrative).toContain('Cash-close check for 2026-10-30 (closed)');
  });

  it('is read-only: no day lock, no write of any kind', async () => {
    const { db, scoped } = fixture();
    await readPharmacyCashCloseCheck(scoped, scope, businessDate);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.pharmacyDailyClose.create).not.toHaveBeenCalled();
    expect(db.pharmacyDrawerSession.update).not.toHaveBeenCalled();
  });

  it('refuses a branch outside the tenant before reading close evidence', async () => {
    const { db, scoped } = fixture();
    db.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(readPharmacyCashCloseCheck(scoped, scope, businessDate)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'branch_1', organizationId: 'org_1', active: true } })
    );
    expect(db.pharmacyRefund.findMany).not.toHaveBeenCalled();
  });

  it('skips the return lookup when nothing was refunded', async () => {
    const { db, scoped } = fixture();
    db.pharmacyRefund.findMany.mockResolvedValue([]);
    const check = await readPharmacyCashCloseCheck(scoped, scope, businessDate);
    expect(db.pharmacySaleReturn.findMany).not.toHaveBeenCalled();
    expect(check.totals.refundCount).toBe(0);
  });
});
