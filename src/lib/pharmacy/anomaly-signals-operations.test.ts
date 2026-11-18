import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  acknowledgePharmacyAnomalySignal,
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
