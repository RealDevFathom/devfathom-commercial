import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyCashCloseCheck } from './cash-close-check-operations';

const scope = { organizationId: 'org_1', branchId: 'branch_1' };
const businessDate = new Date('2026-10-30T00:00:00.000Z');
// A single-lot line's stored gross is quantity × unit price.
const line = (minor: number) => ({
  quantity: 1,
  unitPriceMinor: minor,
  grossMinor: minor,
  discountMinor: 0,
});

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
    organization: {
      findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi', currency: 'USD' }),
    },
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
      // #487: amounts are stated in the organization's currency.
      currency: 'USD',
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
    expect(check.narrative).toContain('USD 47000.00');
    expect(check.narrative).not.toContain('PKR');
    expect(check.findings.map((finding) => finding.explanation).join(' ')).not.toContain('PKR');
  });

  it('DEV-631: does not check a close reopened for trading as the standing close', async () => {
    const { db, scoped } = fixture();
    db.pharmacyDailyClose.findFirst.mockResolvedValue({
      id: 'close_1',
      sequence: 1,
      cashExpectedMinor: 5_000_000,
      cashCountedMinor: 4_700_000,
      cashVarianceMinor: -300_000,
      reason: 'Short at close',
      reopen: { id: 'reopen_1' },
    });
    const check = await readPharmacyCashCloseCheck(scoped, scope, businessDate);
    expect(db.pharmacyDailyClose.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: { reopen: { select: { id: true } } } })
    );
    expect(check).toMatchObject({ closed: false, closeId: null });
    expect(check.narrative).not.toContain('(closed)');
  });

  it('aliases staff before constructing AI prose while preserving owner names and rule evidence', async () => {
    const { db, scoped } = fixture();
    db.pharmacyDrawerSession.findMany.mockResolvedValue([
      {
        id: 'drawer_1',
        openedByActorId: 'user_1',
        openedAt: new Date('2026-10-30T04:00:00Z'),
        countedCashMinor: 2_350_000,
        movements: [{ kind: 'OPENING_FLOAT', amountMinor: 2_500_000 }],
      },
      {
        id: 'drawer_2',
        openedByActorId: 'user_2',
        openedAt: new Date('2026-10-30T05:00:00Z'),
        countedCashMinor: 2_650_000,
        movements: [{ kind: 'OPENING_FLOAT', amountMinor: 2_500_000 }],
      },
    ]);

    const anonymous = await readPharmacyCashCloseCheck(scoped, scope, businessDate, {
      anonymizeStaff: true,
    });
    expect(db.user.findMany).not.toHaveBeenCalled();
    const drawerFindings = anonymous.findings.filter((f) => f.kind === 'DRAWER_VARIANCE');
    expect(drawerFindings).toHaveLength(2);
    // The same actor keeps the same temporary alias in drawer and concentration prose.
    expect(drawerFindings[1].explanation).toContain('opened by team member 1 at 10:00');
    expect(anonymous.findings.find((f) => f.kind === 'ACTOR_CONCENTRATION')).toMatchObject({
      explanation: '4 of 5 refunds and voids (80.00%) were recorded by team member 1.',
    });
    for (const finding of anonymous.findings) {
      expect(anonymous.narrative).toContain(finding.explanation);
      expect(finding.explanation).not.toMatch(/Ayesha|Bilal|user_1|user_2/);
    }
    expect(anonymous.narrative).not.toMatch(/Ayesha|Bilal|user_1|user_2/);

    const owner = await readPharmacyCashCloseCheck(scoped, scope, businessDate);
    expect(owner.narrative).toContain('opened by Ayesha');
    expect(owner.narrative).toContain('opened by Bilal');
    expect(owner.findings.find((f) => f.kind === 'ACTOR_CONCENTRATION')?.explanation).toContain(
      'recorded by Bilal'
    );
    expect(anonymous.totals).toEqual(owner.totals);
    const evidence = (check: typeof owner) =>
      check.findings.map((finding) => ({
        kind: finding.kind,
        severity: finding.severity,
        subject: finding.subject,
        exactNumbers: finding.exactNumbers,
      }));
    expect(evidence(anonymous)).toEqual(evidence(owner));
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

  it('reads voids over exactly the workspace-local day interval', async () => {
    const { db, scoped } = fixture();
    await readPharmacyCashCloseCheck(scoped, scope, businessDate);
    // Karachi (UTC+5): the 30th runs from 2026-10-29T19:00Z to 2026-10-30T19:00Z.
    expect(db.pharmacySaleEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          occurredAt: {
            gte: new Date('2026-10-29T19:00:00.000Z'),
            lt: new Date('2026-10-30T19:00:00.000Z'),
          },
        }),
      })
    );
  });

  it('reads every page of void events so none are silently truncated', async () => {
    const { db, scoped } = fixture();
    db.pharmacyRefund.findMany.mockResolvedValue([]);
    const event = (index: number) => ({
      id: `event_${index}`,
      saleId: `void_${index}`,
      actorId: 'user_1',
      occurredAt: new Date('2026-10-30T05:00:00Z'),
      sale: { lines: [line(10)] },
    });
    const firstPage = Array.from({ length: 1_000 }, (_, index) => event(index));
    db.pharmacySaleEvent.findMany
      .mockReset()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([event(1_000), event(1_001)]);

    const check = await readPharmacyCashCloseCheck(scoped, scope, businessDate);

    expect(db.pharmacySaleEvent.findMany).toHaveBeenCalledTimes(2);
    expect(db.pharmacySaleEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: 'event_999' }, skip: 1 })
    );
    expect(check.totals.voidCount).toBe(1_002);
    expect(check.totals.voidValueMinor).toBe(10_020);
  });

  it('totals mixed-lot lines from the stored line gross, as the Z-report does', async () => {
    const { db, scoped } = fixture();
    // #636: a mixed-lot line charges its stored gross; unitPriceMinor is floor(gross / quantity).
    const mixedLot = { quantity: 3, unitPriceMinor: 333, grossMinor: 1_001, discountMinor: 0 };
    db.pharmacySale.findMany.mockResolvedValue([
      { id: 'sale_1', lines: [line(2_000_000), mixedLot] },
      { id: 'sale_2', lines: [line(2_000_000)] },
    ]);
    db.pharmacySaleEvent.findMany.mockResolvedValue([
      {
        id: 'event_1',
        saleId: 'void_1',
        actorId: 'user_1',
        occurredAt: new Date('2026-10-30T05:00:00Z'),
        sale: { lines: [mixedLot] },
      },
    ]);

    const check = await readPharmacyCashCloseCheck(scoped, scope, businessDate);

    const lines = { select: expect.objectContaining({ grossMinor: true }) };
    expect(db.pharmacySale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ lines }) })
    );
    expect(db.pharmacySaleEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ sale: { select: { lines } } }),
      })
    );
    expect(check.totals.grossSalesMinor).toBe(4_001_001);
    expect(check.totals.voidValueMinor).toBe(1_001);
    expect(check.narrative).toContain('Gross sales USD 40010.01 across 2 sales');
    expect(check.narrative).toContain('1 voids (USD 10.01)');
  });

  it('skips the return lookup when nothing was refunded', async () => {
    const { db, scoped } = fixture();
    db.pharmacyRefund.findMany.mockResolvedValue([]);
    const check = await readPharmacyCashCloseCheck(scoped, scope, businessDate);
    expect(db.pharmacySaleReturn.findMany).not.toHaveBeenCalled();
    expect(check.totals.refundCount).toBe(0);
  });
});
