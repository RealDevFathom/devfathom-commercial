import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  acknowledgePharmacyAnomalySignal,
  readPharmacyAnomalyFacts,
  readPharmacyAnomalySignals,
  refreshPharmacyAnomalySignals,
  snoozePharmacyAnomalySignal,
} from './anomaly-signals-operations';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const filters = { branchIds: ['branch_1'], from: '2026-09-04', to: '2026-09-04' };

describe('AI-04 invariant 29 operation boundary', () => {
  it('persists a signal and audit event without mutating stock, orders, or postings', async () => {
    const forbidden = {
      stockMovement: vi.fn(),
      purchaseOrder: vi.fn(),
      financePosting: vi.fn(),
    };
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        {
          countLineId: 'count_line_1',
          branchId: 'branch_1',
          medicineId: 'medicine_1',
          batchId: 'batch_1',
          expectedUnits: 10,
          countedUnits: 4,
          varianceUnits: -6,
          approvedThresholdUnits: 2,
          occurredAt: NOW,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const created = {
      id: 'signal_1',
      branchId: 'branch_1',
      status: 'OPEN',
      severity: 'URGENT',
    };
    const db: Record<string, unknown> = {
      $queryRaw: queryRaw,
      pharmacyAnomalySignal: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
      },
      pharmacyAnomalySignalEvent: { create: vi.fn().mockResolvedValue({ id: 'event_1' }) },
      pharmacyStockMovement: { create: forbidden.stockMovement },
      pharmacyPurchaseOrder: { create: forbidden.purchaseOrder },
      financePosting: { create: forbidden.financePosting },
    };
    db.$transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db));

    await expect(
      refreshPharmacyAnomalySignals(db as never, filters, 'owner_1', NOW)
    ).resolves.toMatchObject({ evaluated: 1 });
    expect(
      (db.pharmacyAnomalySignal as { create: ReturnType<typeof vi.fn> }).create
    ).toHaveBeenCalledOnce();
    expect(
      (db.pharmacyAnomalySignalEvent as { create: ReturnType<typeof vi.fn> }).create
    ).toHaveBeenCalledOnce();
    expect(forbidden.stockMovement).not.toHaveBeenCalled();
    expect(forbidden.purchaseOrder).not.toHaveBeenCalled();
    expect(forbidden.financePosting).not.toHaveBeenCalled();
  });

  it('records acknowledgement and bounded snooze reasons without operational writes', async () => {
    const signal = {
      id: 'signal_1',
      branchId: 'branch_1',
      status: 'OPEN',
      snoozedUntil: null,
    };
    const update = vi.fn().mockResolvedValue(signal);
    const eventCreate = vi.fn().mockResolvedValue({});
    const stockCreate = vi.fn();
    const orderCreate = vi.fn();
    const postingCreate = vi.fn();
    const db: Record<string, unknown> = {
      pharmacyAnomalySignal: { findFirst: vi.fn().mockResolvedValue(signal), update },
      pharmacyAnomalySignalEvent: { create: eventCreate },
      pharmacyStockMovement: { create: stockCreate },
      pharmacyPurchaseOrder: { create: orderCreate },
      financePosting: { create: postingCreate },
    };
    db.$transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db));
    await acknowledgePharmacyAnomalySignal(
      db as never,
      { branchId: 'branch_1', signalId: 'signal_1', actorId: 'owner_1', reason: 'Checked close' },
      NOW
    );
    await snoozePharmacyAnomalySignal(
      db as never,
      {
        branchId: 'branch_1',
        signalId: 'signal_1',
        actorId: 'owner_1',
        reason: 'Awaiting signed count sheet',
        snoozedUntil: new Date('2026-09-05T12:00:00.000Z'),
      },
      NOW
    );
    expect(eventCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'ACKNOWLEDGED', reason: 'Checked close' }),
      })
    );
    expect(eventCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'SNOOZED', reason: 'Awaiting signed count sheet' }),
      })
    );
    expect(stockCreate).not.toHaveBeenCalled();
    expect(orderCreate).not.toHaveBeenCalled();
    expect(postingCreate).not.toHaveBeenCalled();
  });
});

describe('DEV-631 a reopened close is not the standing close', () => {
  it('leaves a close reopened for trading out of the cash variance and tender mismatch reads', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const db: Record<string, unknown> = {
      $queryRaw: queryRaw,
      pharmacyAnomalySignal: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      pharmacyAnomalySignalEvent: { create: vi.fn() },
    };
    db.$transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db));
    await refreshPharmacyAnomalySignals(db as never, filters, 'owner_1', NOW);
    const closeReads = queryRaw.mock.calls
      .map(([query]) => (query as { sql: string }).sql)
      .filter((sql) => sql.includes('FROM "pharmacy_daily_closes" c'));
    // Cash variance and tender mismatch: both skip a close the owner reopened.
    expect(closeReads).toHaveLength(2);
    for (const sql of closeReads)
      expect(sql).toContain(
        'NOT EXISTS (SELECT 1 FROM "pharmacy_day_reopens" reopen WHERE reopen."organizationId"=c."organizationId" AND reopen."closeId"=c."id")'
      );
  });
});

describe('anomaly signals on the workspace day (DEV-902)', () => {
  // 4 Sep in Karachi runs from 3 Sep 19:00 UTC to 4 Sep 19:00 UTC.
  const karachi = { ...filters, timeZone: 'Asia/Karachi' };
  const localStart = new Date('2026-09-03T19:00:00.000Z');
  const localEnd = new Date('2026-09-04T19:00:00.000Z');
  const dates = (call: unknown[]) =>
    (call[0] as { values: unknown[] }).values
      .filter((value): value is Date => value instanceof Date)
      .map((value) => value.toISOString());

  it('bounds event timestamps by the workspace midnights, so 00:30 local counts as that day', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const result = await readPharmacyAnomalyFacts({ $queryRaw: queryRaw } as never, karachi, NOW);

    expect(result.windowStart).toEqual(localStart);
    expect(result.windowEnd).toEqual(localEnd);
    // Count approvals, sale events and receipt postings: a 00:30 PKT event falls inside.
    const saleAtHalfPastMidnight = new Date('2026-09-03T19:30:00.000Z');
    expect(saleAtHalfPastMidnight >= result.windowStart).toBe(true);
    expect(saleAtHalfPastMidnight < result.windowEnd).toBe(true);
    const shrinkage = dates(queryRaw.mock.calls[0]!);
    expect(shrinkage).toEqual([localStart.toISOString(), localEnd.toISOString()]);
    const staffVoid = dates(queryRaw.mock.calls[3]!);
    expect(staffVoid.slice(0, 2)).toEqual([localStart.toISOString(), localEnd.toISOString()]);
    // Business-date columns still compare calendar dates.
    expect(staffVoid.slice(2)).toEqual(['2026-09-04T00:00:00.000Z', '2026-09-05T00:00:00.000Z']);
    const priceDrift = dates(queryRaw.mock.calls.at(-1)!);
    expect(priceDrift).toEqual([localStart.toISOString(), localEnd.toISOString()]);
  });

  it('reads persisted signals for the same workspace-day window refresh stored', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await readPharmacyAnomalySignals(
      {
        pharmacyAnomalySignal: { findMany },
        medicineStrengthComponent: { findMany: vi.fn() },
      } as never,
      karachi
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dataWindowStart: localStart, dataWindowEnd: localEnd }),
      })
    );
  });
});

describe('anomaly signals across branches on different hours (DEV-958A)', () => {
  it('reads each branch on its own window and keeps one order before the 200-row cut', async () => {
    const signal = (id: string, status: string, severity: string, computedAt: string) => ({
      id,
      status,
      severity,
      computedAt: new Date(computedAt),
      scope: {},
    });
    // The late branch ends its days at 05:00; the other at midnight: two windows, two reads.
    const late = [
      signal('late-notice', 'OPEN', 'NOTICE', '2026-09-04T10:00:00.000Z'),
      signal('late-snoozed', 'SNOOZED', 'URGENT', '2026-09-04T11:00:00.000Z'),
      ...Array.from({ length: 150 }, (_, index) =>
        signal(`late-review-${index}`, 'OPEN', 'REVIEW', '2026-09-04T09:00:00.000Z')
      ),
    ];
    const midnight = [
      signal('midnight-urgent', 'OPEN', 'URGENT', '2026-09-04T08:00:00.000Z'),
      signal('midnight-acknowledged', 'ACKNOWLEDGED', 'URGENT', '2026-09-04T12:00:00.000Z'),
      ...Array.from({ length: 150 }, (_, index) =>
        signal(`midnight-review-${index}`, 'OPEN', 'REVIEW', '2026-09-04T07:00:00.000Z')
      ),
    ];
    const findMany = vi.fn(async ({ where }: { where: { branchId: { in: string[] } } }) =>
      where.branchId.in.includes('branch_late') ? late : midnight
    );
    const rows = await readPharmacyAnomalySignals(
      {
        pharmacyAnomalySignal: { findMany },
        medicineStrengthComponent: { findMany: vi.fn() },
      } as never,
      {
        branchIds: ['branch_late', 'branch_1'],
        from: '2026-09-04',
        to: '2026-09-04',
        timeZone: 'Asia/Karachi',
        dayEnds: { branch_late: [{ from: '2026-01-01', hour: 5 }] },
      }
    );
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(200);
    // Open before acknowledged before snoozed; urgent before review before notice; newest first.
    expect(rows.slice(0, 3).map((row) => row.id)).toEqual([
      'midnight-urgent',
      'late-review-0',
      'late-review-1',
    ]);
    expect(rows.findIndex((row) => row.id === 'midnight-review-0')).toBe(151);
    // The cut drops the lowest-ranked rows, never a whole branch's urgent ones.
    expect(rows.map((row) => row.id)).not.toContain('late-notice');
    expect(rows.map((row) => row.id)).not.toContain('midnight-acknowledged');
    expect(rows.map((row) => row.id)).not.toContain('late-snoozed');
  });
});
