import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { postOpeningLedgerEntry, postOpeningStockEntry } from '../finance-postings';
import {
  DEFAULT_MATERIALITY_THRESHOLD,
  missingAttributes,
  postOpeningLedger,
  postOpeningSession,
} from './opening-stock';

vi.mock('../finance-postings', () => ({
  postOpeningLedgerEntry: vi.fn(),
  postOpeningStockEntry: vi.fn(),
}));

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
    ['batchNumber', 'MISSING_BATCH'],
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

describe('opening journal effective date', () => {
  const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
  const openingAt = new Date('2026-09-01T00:00:00Z');
  const session = { id: 'session', branchId: scope.branchId, status: 'DRAFT', openingAt };

  it('recognizes opening inventory at openingAt even when imported later', async () => {
    const db = {
      pharmacyOpeningSession: {
        findFirst: vi.fn().mockResolvedValue(session),
        update: vi.fn(),
      },
      pharmacyOpeningStockLine: {
        findMany: vi.fn().mockResolvedValue([{ ...completeLine(), id: 'line' }]),
        update: vi.fn(),
      },
      pharmacyInventoryLot: { create: vi.fn().mockResolvedValue({ id: 'lot' }) },
      pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement' }) },
      pharmacyOpeningTotal: { create: vi.fn().mockResolvedValue({ id: 'total' }) },
    };
    await postOpeningSession(db as unknown as ScopedDb, scope, {
      sessionId: session.id,
      idempotencyKeyPrefix: 'opening',
    });
    expect(postOpeningStockEntry).toHaveBeenCalledWith(db, scope, {
      sessionId: session.id,
      at: openingAt,
    });
  });

  it('recognizes signed opening balances at openingAt and preserves zero balances', async () => {
    const db = {
      pharmacyOpeningSession: { findFirst: vi.fn().mockResolvedValue(session) },
      pharmacyOpeningLedgerEntry: {
        create: vi.fn().mockResolvedValueOnce({ id: 'cash' }).mockResolvedValueOnce({ id: 'bank' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    await postOpeningLedger(db as unknown as ScopedDb, scope, {
      sessionId: session.id,
      balances: [
        { account: 'CASH', balanceMinor: BigInt(50), sourceRef: 'cash' },
        { account: 'BANK', balanceMinor: BigInt(0), sourceRef: 'bank' },
      ],
    });
    expect(db.pharmacyOpeningLedgerEntry.create).toHaveBeenCalledTimes(2);
    expect(postOpeningLedgerEntry).toHaveBeenCalledExactlyOnceWith(db, scope, {
      openingLedgerEntryId: 'cash',
      at: openingAt,
    });
  });
});
