import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const postOpeningLedgerEntry = vi.hoisted(() => vi.fn());
vi.mock('../finance-postings', () => ({ postOpeningLedgerEntry }));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  DEFAULT_MATERIALITY_THRESHOLD,
  missingAttributes,
  postOpeningLedger,
  postOpeningSession,
} from './opening-stock';

/** A line with every required attribute present. */
function completeLine() {
  return {
    sourceRef: 'ABZ-000123',
    manufacturingBatchId: 'batch_1',
    batchNumber: 'B-77',
    expiryDate: new Date('2027-06-01T00:00:00.000Z'),
    expiryPrecision: 'MONTH' as const,
    printedMrpMinor: 25_000,
    unitCostMinor: 18_000,
    stockLocationId: 'loc_1',
    packLevelId: 'pack_1',
    unitsPerPack: 10,
    countedUnits: 40,
  };
}

describe('MIG-03 opening line completeness', () => {
  it('raises no exception when every required attribute is present', () => {
    expect(missingAttributes(completeLine())).toEqual([]);
  });

  it.each([
    ['sourceRef', 'MISSING_SOURCE_REF'],
    ['manufacturingBatchId', 'MISSING_BATCH'],
    ['expiryDate', 'MISSING_EXPIRY'],
    ['expiryPrecision', 'MISSING_EXPIRY'],
    ['printedMrpMinor', 'MISSING_MRP'],
    ['unitCostMinor', 'MISSING_COST'],
    ['stockLocationId', 'MISSING_LOCATION'],
    ['packLevelId', 'MISSING_LOCATION'],
    ['unitsPerPack', 'MISSING_LOCATION'],
    ['countedUnits', 'MISSING_COUNT'],
  ] as const)('reports %s missing as %s', (attribute, bucket) => {
    const gaps = missingAttributes({ ...completeLine(), [attribute]: null });
    expect(gaps).toContain(bucket);
  });

  /**
   * MIG-02 acceptance: missing batch/expiry/MRP is never silently defaulted. The
   * pure check is the first of the three guards (service, this, and the CHECK on
   * `pharmacy_opening_stock_lines`).
   */
  it('reports every gap at once rather than stopping at the first', () => {
    const gaps = missingAttributes({
      ...completeLine(),
      batchNumber: null,
      manufacturingBatchId: null,
      expiryDate: null,
      printedMrpMinor: null,
    });
    expect(gaps.sort()).toEqual(['MISSING_BATCH', 'MISSING_EXPIRY', 'MISSING_MRP']);
  });

  /**
   * DEV-853 owner decision: legacy stock has no batch number and no expiry. Both
   * are stored as "not recorded" and the lot is still posted and sellable; only
   * a missing batch row or a half-stated expiry is a gap.
   */
  it('posts a line whose batch number and expiry were never recorded', () => {
    expect(
      missingAttributes({
        ...completeLine(),
        batchNumber: null,
        expiryDate: null,
        expiryPrecision: null,
      })
    ).toEqual([]);
  });

  it('still reports a line with no batch row to hang the lot on', () => {
    expect(
      missingAttributes({ ...completeLine(), batchNumber: null, manufacturingBatchId: null })
    ).toEqual(['MISSING_BATCH']);
  });

  it('treats a blank source reference as absent rather than as a value', () => {
    expect(missingAttributes({ ...completeLine(), sourceRef: '   ' })).toEqual([
      'MISSING_SOURCE_REF',
    ]);
  });

  /** A counted zero is a fact about the shelf, not a missing value. */
  it('accepts a counted quantity of zero as a real count', () => {
    expect(missingAttributes({ ...completeLine(), countedUnits: 0 })).toEqual([]);
  });
});

describe('D05 materiality threshold default', () => {
  it('defaults to zero, so every variance is material until the contract sets one', () => {
    expect(DEFAULT_MATERIALITY_THRESHOLD).toEqual({
      thresholdMinor: BigInt(0),
      thresholdUnits: 0,
    });
  });
});

const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };

function openingDb(precision: 'DAY' | 'MONTH', stored: string) {
  const db = {
    pharmacyOpeningSession: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'session',
        branchId: SCOPE.branchId,
        status: 'COUNTED',
        openingAt: new Date('2026-10-21T00:00:00.000Z'),
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyOpeningStockLine: {
      findMany: vi.fn().mockResolvedValue([
        {
          ...completeLine(),
          id: 'line',
          expiryDate: new Date('2027-06-15T00:00:00.000Z'),
          expiryPrecision: precision,
        },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyManufacturingBatch: {
      findFirst: vi.fn().mockResolvedValue({ expiresAt: new Date(stored) }),
    },
    pharmacyInventoryLot: { create: vi.fn().mockResolvedValue({ id: 'lot' }) },
    pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement' }) },
    pharmacyOpeningTotal: {
      create: vi.fn().mockImplementation(async ({ data }: { data: object }) => data),
    },
  };
  return { db: db as unknown as ScopedDb, models: db };
}

describe('opening stock expiry boundaries', () => {
  it.each([
    ['DAY', '2027-06-16T00:00:00.000Z', '2027-06-15T19:00:00.000Z'],
    ['DAY', '2027-06-15T19:00:00.000Z', '2027-06-15T19:00:00.000Z'],
    ['MONTH', '2027-07-01T00:00:00.000Z', '2027-06-30T19:00:00.000Z'],
    ['MONTH', '2027-06-30T19:00:00.000Z', '2027-06-30T19:00:00.000Z'],
  ] as const)('posts %s stock against an existing batch at %s', async (precision, stored, pkt) => {
    const { db, models } = openingDb(precision, stored);

    const posted = await postOpeningSession(db, SCOPE, {
      sessionId: 'session',
      idempotencyKeyPrefix: 'opening',
    });

    expect(posted.postedLineCount).toBe(1);
    expect(posted.total).toMatchObject({ totalUnits: 40, totalValueMinor: BigInt(720_000) });
    expect(models.pharmacyInventoryLot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        manufacturingBatchId: 'batch_1',
        receivedExpiresAt: new Date(pkt),
        receivedExpiryPrecision: precision,
      }),
    });
    expect(models.pharmacyManufacturingBatch.findFirst).toHaveBeenCalledWith({
      where: { id: 'batch_1', organizationId: SCOPE.organizationId },
      select: { expiresAt: true },
    });
  });

  it.each([
    ['DAY', '2027-06-17T00:00:00.000Z'],
    ['MONTH', '2027-07-02T00:00:00.000Z'],
    ['DAY', '2027-06-15T19:00:00.001Z'],
  ] as const)('refuses a conflicting %s batch expiry at %s', async (precision, stored) => {
    const { db, models } = openingDb(precision, stored);

    await expect(
      postOpeningSession(db, SCOPE, { sessionId: 'session', idempotencyKeyPrefix: 'opening' })
    ).rejects.toMatchObject({ reason: 'BATCH_EXPIRY_CONFLICT' });
    expect(models.pharmacyInventoryLot.create).not.toHaveBeenCalled();
    expect(models.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(models.pharmacyOpeningSession.update).not.toHaveBeenCalled();
  });

  it('posts a lot with no recorded expiry as null, never an invented date (DEV-853)', async () => {
    const { db, models } = openingDb('DAY', '2027-06-16T00:00:00.000Z');
    models.pharmacyOpeningStockLine.findMany.mockResolvedValue([
      {
        ...completeLine(),
        id: 'line',
        batchNumber: null,
        expiryDate: null,
        expiryPrecision: null,
      },
    ]);
    models.pharmacyManufacturingBatch.findFirst.mockResolvedValue({ expiresAt: null });

    const posted = await postOpeningSession(db, SCOPE, {
      sessionId: 'session',
      idempotencyKeyPrefix: 'opening',
    });

    expect(posted.postedLineCount).toBe(1);
    expect(models.pharmacyInventoryLot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        manufacturingBatchId: 'batch_1',
        receivedExpiresAt: null,
        receivedExpiryPrecision: null,
      }),
    });
    expect(models.pharmacyStockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'OPENING',
        disposition: 'AVAILABLE',
        quantityUnits: 40,
      }),
    });
  });

  it('refuses a stated expiry against a batch whose expiry was never recorded', async () => {
    const { db, models } = openingDb('DAY', '2027-06-16T00:00:00.000Z');
    models.pharmacyManufacturingBatch.findFirst.mockResolvedValue({ expiresAt: null });

    await expect(
      postOpeningSession(db, SCOPE, { sessionId: 'session', idempotencyKeyPrefix: 'opening' })
    ).rejects.toMatchObject({ reason: 'BATCH_EXPIRY_CONFLICT' });
    expect(models.pharmacyInventoryLot.create).not.toHaveBeenCalled();
  });

  it('refuses a batch outside the workspace before posting stock', async () => {
    const { db, models } = openingDb('DAY', '2027-06-16T00:00:00.000Z');
    models.pharmacyManufacturingBatch.findFirst.mockResolvedValue(null);

    await expect(
      postOpeningSession(db, SCOPE, { sessionId: 'session', idempotencyKeyPrefix: 'opening' })
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(models.pharmacyInventoryLot.create).not.toHaveBeenCalled();
    expect(models.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});

describe('MIG-03 opening ledger reaches the GL (DEV-131)', () => {
  it('journals every non-zero opening balance in the same transaction', async () => {
    postOpeningLedgerEntry.mockReset().mockResolvedValue({ id: 'entry' });
    const openingAt = new Date('2026-09-01T00:00:00.000Z');
    let created = 0;
    const db = {
      pharmacyOpeningSession: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'session',
          branchId: SCOPE.branchId,
          status: 'POSTED',
          openingAt,
        }),
      },
      pharmacyOpeningLedgerEntry: {
        create: vi
          .fn()
          .mockImplementation(async ({ data }) => ({ id: `opening_${++created}`, ...data })),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    await postOpeningLedger(db as unknown as ScopedDb, SCOPE, {
      sessionId: 'session',
      balances: [
        { account: 'ACCOUNTS_PAYABLE', balanceMinor: BigInt(-45_000), sourceRef: 'ap' },
        { account: 'CASH', balanceMinor: BigInt(0), sourceRef: 'cash' },
        { account: 'BANK', balanceMinor: BigInt(12_000), sourceRef: 'bank' },
      ],
    });

    expect(db.pharmacyOpeningLedgerEntry.create).toHaveBeenCalledTimes(3);
    expect(postOpeningLedgerEntry.mock.calls).toEqual([
      [db, SCOPE, { openingLedgerEntryId: 'opening_1', at: openingAt }],
      [db, SCOPE, { openingLedgerEntryId: 'opening_3', at: openingAt }],
    ]);
  });
});
