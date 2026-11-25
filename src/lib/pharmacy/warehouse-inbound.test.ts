import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { completeWarehousePutAway } from './warehouse-inbound';
import { warehouseStockQualityReason } from './warehouse-quality';

vi.mock('./warehouse-quality', () => ({ warehouseStockQualityReason: vi.fn() }));

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'operator' };
const at = new Date('2026-06-01T12:00:00Z');
const input = {
  taskId: 'putaway',
  productScan: 'medicine',
  batchScan: 'B-2',
  destinationCode: 'R-1',
  quantityUnits: 15,
};

function fixture() {
  const line = {
    medicineId: 'medicine',
    packLevelId: 'pack',
    batchNumber: 'B-2',
    inventoryLotId: 'lot',
    stockLocationId: 'dock',
    goodsReceipt: { status: 'POSTED' },
    printedExpiry: new Date('2027-06-01'),
    expiryPrecision: 'MONTH',
    gtin: null,
    serialNumber: null,
  };
  const task = {
    id: 'putaway',
    line,
    completedAt: null as Date | null,
    completedById: null,
    quantityUnits: 15,
    productScan: null as string | null,
    batchScan: null as string | null,
    destinationCode: null as string | null,
  };
  const medicine = { controlled: false, saleable: true };
  const batch = {
    batchNumber: 'B-2',
    medicine,
    medicineId: 'medicine',
    state: 'ACTIVE',
    expiresAt: new Date('2027-06-01') as Date | null,
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ warehouseEnabled: true }]),
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'branch',
        active: true,
        provinceCode: 'PB',
        addressLine: 'One Road',
        city: 'Lahore',
      }),
    },
    branchRegulatoryProfile: {
      findFirst: vi.fn().mockResolvedValue({
        provinceCode: 'PB',
        premises: { addressLine: 'One Road', city: 'Lahore' },
        isPlaceholder: false,
        licenceNumber: '123',
        licenceEvidenceFileRef: 'evidence',
        licenceValidFrom: new Date('2026-01-01'),
        licenceValidTo: new Date('2028-01-01'),
      }),
    },
    pharmacyWarehousePutAway: {
      findFirst: vi.fn(async () => task),
      update: vi.fn(async ({ data }) => Object.assign(task, data)),
    },
    medicineBarcode: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyInventoryLot: {
      findFirst: vi.fn(async () => ({ receivedAt: new Date('2026-01-01'), batch })),
    },
    pharmacyStockLocation: {
      findFirst: vi.fn().mockResolvedValue({ id: 'rack', kind: 'RACK_BIN' }),
    },
    pharmacyStockBalance: {
      findFirst: vi.fn().mockResolvedValue({ onHandUnits: 15, sealedPacks: 1, looseUnits: 5 }),
    },
    pharmacyStockMovement: { create: vi.fn().mockResolvedValue({}) },
  };
  return { db, client: db as unknown as ScopedDb, task, batch };
}

describe('Warehouse put-away', () => {
  beforeEach(() => vi.mocked(warehouseStockQualityReason).mockResolvedValue(null));

  it('preserves sealed and loose quantities, records two ledger legs and returns a retry without posting again', async () => {
    const { db, client } = fixture();
    const result = await completeWarehousePutAway(client, scope, input, at);
    expect(await completeWarehousePutAway(client, scope, input, at)).toEqual(result);
    expect(db.pharmacyStockMovement.create.mock.calls).toEqual([
      [
        {
          data: expect.objectContaining({
            inventoryLotId: 'lot',
            stockLocationId: 'dock',
            disposition: 'WAREHOUSE_RECEIVING',
            quantityUnits: -15,
            sealedPackDelta: -1,
            looseUnitDelta: -5,
          }),
        },
      ],
      [
        {
          data: expect.objectContaining({
            inventoryLotId: 'lot',
            stockLocationId: 'rack',
            disposition: 'AVAILABLE',
            quantityUnits: 15,
            sealedPackDelta: 1,
            looseUnitDelta: 5,
          }),
        },
      ],
    ]);
    expect(db.pharmacyWarehousePutAway.update).toHaveBeenCalledOnce();
    await expect(
      completeWarehousePutAway(client, scope, { ...input, destinationCode: 'R-2' }, at)
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('accepts a matching GS1 month-precision expiry and rejects the same product with a different batch', async () => {
    const { client, task, db } = fixture();
    db.medicineBarcode.findFirst.mockResolvedValue({ id: 'barcode' });
    const gtin = '08961234567894';
    const scan = `(01)${gtin}(17)270600(10)B-2`;
    expect(task.line.expiryPrecision).toBe('MONTH');
    await expect(
      completeWarehousePutAway(
        client,
        scope,
        { ...input, productScan: scan.replace('B-2', 'B-5') },
        at
      )
    ).rejects.toThrow('LABEL_LOT_MISMATCH');
    await expect(
      completeWarehousePutAway(client, scope, { ...input, productScan: scan }, at)
    ).resolves.toMatchObject({ quantityUnits: 15 });
  });

  it.each([
    [{ productScan: 'OTHER' }, 'LABEL_LOT_MISMATCH'],
    [{ batchScan: 'B-3' }, 'LABEL_LOT_MISMATCH'],
    [{ quantityUnits: 14 }, 'INVALID_QUANTITY'],
  ] as const)('rejects an incorrect physical confirmation %#', async (change, reason) => {
    const { client, db } = fixture();
    await expect(
      completeWarehousePutAway(client, scope, { ...input, ...change }, at)
    ).rejects.toThrow(reason);
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('keeps recalled stock, unknown expiry, temperature holds and controlled stock outside a safe blocked', async () => {
    const { client, db, batch } = fixture();
    batch.state = 'RECALLED';
    await expect(completeWarehousePutAway(client, scope, input, at)).rejects.toThrow(
      'BLOCKED_STOCK'
    );
    batch.state = 'ACTIVE';
    batch.expiresAt = null;
    await expect(completeWarehousePutAway(client, scope, input, at)).rejects.toThrow(
      'BLOCKED_STOCK'
    );
    batch.expiresAt = new Date('2027-06-01');
    vi.mocked(warehouseStockQualityReason).mockResolvedValueOnce('Temperature excursion');
    await expect(completeWarehousePutAway(client, scope, input, at)).rejects.toThrow(
      'BLOCKED_STOCK'
    );
    batch.medicine.controlled = true;
    await expect(completeWarehousePutAway(client, scope, input, at)).rejects.toThrow(
      'UNSALEABLE_DESTINATION'
    );
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});
