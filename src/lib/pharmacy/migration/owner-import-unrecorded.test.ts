import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const opening = vi.hoisted(() => ({
  draftLine: vi.fn(),
  explainVariance: vi.fn(),
  postOpeningSession: vi.fn(),
}));
vi.mock('./opening-stock', () => opening);
const postOpeningStockEntry = vi.hoisted(() => vi.fn());
vi.mock('../finance-postings', () => ({ postOpeningStockEntry }));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { commitOwnerImport, previewOwnerImport } from './owner-import';
import type { OwnerImportInput } from './owner-import-input';

/**
 * DEV-853 — committing legacy opening stock with no batch number and/or no
 * expiry stores them as null (never an invented batch or date) and still posts
 * the stock. Each row with no batch number gets its own unrecorded batch, so
 * recording one later never rewrites another row.
 */

const scope = { organizationId: 'org_owner', branchId: 'branch_owner', actorId: 'owner' };
const mapping = {
  sourceRef: 0,
  pack: 1,
  batch: 2,
  expiry: 3,
  mrp: 4,
  cost: 5,
  expected: 6,
  counted: 7,
};
function input(rows: string[]): OwnerImportInput {
  const csv = `Source,Pack,Batch,Expiry,MRP,Cost,Expected,Counted\n${rows.join('\n')}`;
  return {
    fileName: 'legacy.csv',
    content: Buffer.from(csv).toString('base64'),
    branchId: scope.branchId,
    stockLocationId: 'location',
    mapping,
  };
}

function makeDb() {
  let batches = 0;
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: scope.branchId }) },
    pharmacyStockLocation: {
      findFirst: vi.fn().mockResolvedValue({ id: 'location', coldChain: false }),
    },
    pharmacyOpeningSession: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    pharmacyOpeningTotal: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyStockMovement: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
    pharmacyMigrationSource: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    pharmacyManufacturingBatch: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async () => ({ id: `batch_${++batches}` })),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    packLevel: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'pack',
          presentationId: 'presentation',
          presentation: {
            medicineId: 'medicine',
            medicine: { productName: 'Legacy', saleable: true, coldChain: false },
            packLevels: [
              {
                id: 'pack',
                level: 'STRIP',
                unitsPerParent: 10,
                parentPackLevelId: null,
                effectiveFrom: new Date('2020-01-01'),
                effectiveTo: null,
              },
            ],
          },
        },
      ]),
    },
  };
}

let db = makeDb();
beforeEach(() => {
  db = makeDb();
  opening.draftLine.mockReset().mockResolvedValue({ line: { id: 'line' }, gaps: [] });
  opening.explainVariance.mockReset();
  opening.postOpeningSession
    .mockReset()
    .mockResolvedValue({ total: { totalUnits: 30, totalValueMinor: BigInt(3750) } });
  postOpeningStockEntry.mockReset();
});

describe('DEV-853 owner import of legacy stock without batch or expiry', () => {
  it('stores the missing batch number and expiry as null and posts the stock', async () => {
    const value = input([
      'SRC-1,pack,,,25,1.25,10,10',
      'SRC-2,pack,,2099-06,25,1.25,10,10',
      'SRC-3,pack,B7,,25,1.25,10,10',
    ]);
    const scoped = db as unknown as ScopedDb;
    const preview = await previewOwnerImport(scoped, scope, value);
    expect(preview.canCommit).toBe(true);

    const committed = await commitOwnerImport(scoped, scope, {
      ...value,
      previewHash: preview.previewHash,
    });

    expect(committed).toMatchObject({ replayed: false, totalUnits: 30 });
    // One batch per row: no two unrecorded rows share (and later overwrite) a batch.
    expect(db.pharmacyManufacturingBatch.create).toHaveBeenCalledTimes(3);
    const created = db.pharmacyManufacturingBatch.create.mock.calls.map(([args]) => args.data);
    expect(created[0]).toMatchObject({ batchNumber: null, expiresAt: null });
    expect(created[0]).not.toHaveProperty('expiryPrecision');
    expect(created[1]).toMatchObject({ batchNumber: null, expiryPrecision: 'MONTH' });
    expect(created[1].expiresAt).toBeInstanceOf(Date);
    expect(created[2]).toMatchObject({ batchNumber: 'B7', expiresAt: null });

    const drafted = opening.draftLine.mock.calls.map(([, , args]) => args);
    expect(drafted[0]).toMatchObject({
      manufacturingBatchId: 'batch_1',
      batchNumber: null,
      expiryDate: null,
      expiryPrecision: null,
      countedUnits: 10,
    });
    expect(drafted[2]).toMatchObject({
      batchNumber: 'B7',
      expiryDate: null,
      expiryPrecision: null,
    });
    expect(opening.postOpeningSession).toHaveBeenCalledTimes(1);
  });
});
