// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ putUpload: vi.fn(), getUpload: vi.fn(), deleteUpload: vi.fn() }));
vi.mock('@/lib/storage', () => ({
  putUpload: m.putUpload,
  getUpload: m.getUpload,
  deleteUpload: m.deleteUpload,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: vi.fn() }));

import { parseDelimitedText } from './migration/source-values';
import {
  basePackUnits,
  loadOwnerDataExportRows,
  parseSalesRange,
  purgeExpiredOwnerDataExports,
  runPharmacyOwnerDataExportJob,
} from './owner-data-export';
import { OWNER_DATA_EXPORT_FILES, exportCsv } from './owner-data-export-format';

const many = (rows: unknown[] = []) => vi.fn().mockResolvedValue(rows);

function fakeDb() {
  const medicine = {
    id: 'med-1',
    productName: 'Tramadol 50mg',
    brandName: 'Tramal',
    manufacturer: 'Searle',
    drapRegistrationNumber: '012345',
    productFamily: 'MEDICINE',
    rx: true,
    otc: false,
    controlled: true,
    saleable: true,
  };
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    organization: { findUnique: vi.fn().mockResolvedValue({ displayName: 'Shifa Pharmacy' }) },
    pharmacyBranch: { findMany: many([{ id: 'br-1', code: 'RWP' }]) },
    pharmacyStockLocation: { findMany: many([{ id: 'loc-1', code: 'SHELF' }]) },
    packLevel: {
      findMany: many([
        {
          id: 'pk-1',
          level: 'strip',
          unitsPerParent: 10,
          parentPackLevelId: null,
          presentationId: 'pr-1',
          presentation: { presentation: 'capsule', medicine },
        },
      ]),
    },
    medicineBarcode: {
      findMany: many([{ presentationId: 'pr-1', packLevelId: 'pk-1', code: '8961000000017' }]),
    },
    pharmacyInventoryLot: {
      findMany: many([
        {
          id: 'lot-1',
          branchId: 'br-1',
          packLevelId: 'pk-1',
          unitsPerPack: 10,
          supplierName: 'Muller',
          supplierInvoiceRef: 'INV-9',
          unitCostMinor: 1250,
          printedMrpMinor: 15000,
          batch: { batchNumber: 'T-1', expiresAt: new Date('2027-05-31T00:00:00Z'), medicine },
          packLevel: { level: 'strip' },
          balances: [{ stockLocationId: 'loc-1', disposition: 'AVAILABLE', onHandUnits: 40 }],
        },
      ]),
    },
    pharmacyCustomer: {
      findMany: many([
        {
          id: 'c-1',
          displayName: 'Ayesha',
          phoneLast4: '1234',
          creditLimitMinor: 500000,
          active: true,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'c-2',
          displayName: 'Bilal',
          phoneLast4: null,
          creditLimitMinor: 0,
          active: true,
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      ]),
    },
    pharmacyFamilyAccount: {
      findMany: many([{ id: 'fa-1', payerCustomerId: 'c-1', displayName: 'Khan family' }]),
    },
    pharmacyKhataEvent: {
      findMany: many([
        {
          familyAccountId: 'fa-1',
          branchId: 'br-1',
          kind: 'CHARGE',
          amountMinor: 30000,
          occurredAt: new Date('2026-02-01T00:00:00Z'),
          dueAt: null,
          note: null,
        },
        {
          familyAccountId: 'fa-1',
          branchId: 'br-1',
          kind: 'PAYMENT',
          amountMinor: 10000,
          occurredAt: new Date('2026-02-05T00:00:00Z'),
          dueAt: null,
          note: '=cmd',
        },
      ]),
    },
    pharmacySupplier: {
      findMany: many([
        {
          id: 's-1',
          name: 'Muller',
          legalName: null,
          contactName: null,
          contactPhone: null,
          paymentTermsDays: 30,
          creditLimitMinor: 0,
          authorized: true,
          active: true,
        },
      ]),
    },
    pharmacySupplierCredit: { findMany: many([{ supplierId: 's-1', amountMinor: 500 }]) },
    pharmacySale: { findMany: many([]) },
    pharmacyPurchaseOrder: { findMany: many([]) },
    pharmacyGoodsReceipt: {
      findMany: many([
        {
          id: 'grn-1',
          reference: 'GRN-1',
          branchId: 'br-1',
          supplierId: 's-1',
          purchaseOrderId: null,
          supplierInvoiceRef: 'INV-9',
          supplierInvoiceDate: new Date('2026-03-01T00:00:00Z'),
          status: 'POSTED',
          receivedAt: new Date('2026-03-01T00:00:00Z'),
          postedAt: new Date('2026-03-01T00:00:00Z'),
          reversedAt: null,
          freightMinor: 0,
          lines: [
            {
              lineNumber: 1,
              medicineId: 'med-1',
              packLevelId: 'pk-1',
              batchNumber: 'T-1',
              printedExpiry: new Date('2027-05-31T00:00:00Z'),
              printedMrpMinor: 15000,
              receivedPacks: 5,
              bonusPacks: 0,
              acceptedCanonicalUnits: 50,
              rejectedCanonicalUnits: 0,
              invoicedPricePerPackMinor: 12500,
              discountBps: 0,
              taxBps: 0,
              unitCostMinor: 1250,
              inventoryLotId: 'lot-1',
              medicine,
            },
          ],
        },
        {
          id: 'grn-2',
          reference: 'GRN-2',
          branchId: 'br-1',
          supplierId: 's-1',
          purchaseOrderId: null,
          supplierInvoiceRef: 'INV-10',
          supplierInvoiceDate: new Date('2026-03-02T00:00:00Z'),
          status: 'REVERSED',
          receivedAt: new Date('2026-03-02T00:00:00Z'),
          postedAt: new Date('2026-03-02T00:00:00Z'),
          reversedAt: new Date('2026-03-03T00:00:00Z'),
          freightMinor: 0,
          lines: [
            {
              lineNumber: 1,
              medicineId: 'med-1',
              packLevelId: 'pk-1',
              batchNumber: 'T-2',
              printedExpiry: new Date('2027-05-31T00:00:00Z'),
              printedMrpMinor: 15000,
              receivedPacks: 1,
              bonusPacks: 0,
              acceptedCanonicalUnits: 10,
              rejectedCanonicalUnits: 0,
              invoicedPricePerPackMinor: 12500,
              discountBps: 0,
              taxBps: 0,
              unitCostMinor: 1250,
              inventoryLotId: null,
              medicine,
            },
          ],
        },
      ]),
    },
    pharmacyControlledRegisterEntry: {
      findMany: many([
        {
          branchId: 'br-1',
          serial: 1,
          createdAt: new Date('2026-03-01T00:00:00Z'),
          entryKind: 'PURCHASE',
          medicine,
          line: null,
          manufacturer: null,
          batchNumber: 'T-1',
          quantityCanonicalUnits: 50,
          balanceDelta: 50,
          runningBalance: 50,
          patient: null,
          prescriber: null,
          prescriberName: null,
          prescriberRegNo: null,
          counterpartyName: 'Muller',
          rxSerialWritten: false,
          emergency: false,
          correctsEntry: null,
          correctionReason: null,
          recordedByUserId: 'u-1',
          witnessedByUserId: 'u-2',
        },
        {
          branchId: 'br-1',
          serial: 2,
          createdAt: new Date('2026-03-02T00:00:00Z'),
          entryKind: 'SALE',
          medicine: null,
          line: { medicine },
          manufacturer: null,
          batchNumber: 'T-1',
          quantityCanonicalUnits: 10,
          balanceDelta: -10,
          runningBalance: 40,
          patient: { displayName: 'Zara' },
          prescriber: { name: 'Dr Ali', registrationNumber: 'PMDC-1' },
          prescriberName: null,
          prescriberRegNo: null,
          counterpartyName: null,
          rxSerialWritten: true,
          emergency: false,
          correctsEntry: null,
          correctionReason: null,
          recordedByUserId: 'u-1',
          witnessedByUserId: 'u-2',
        },
      ]),
    },
    user: {
      findMany: many([
        { id: 'u-1', name: 'Owner One' },
        { id: 'u-2', name: 'u-2' },
      ]),
    },
    restaurantStaffProfile: { findMany: many([{ userId: 'u-2', displayName: 'Pharmacist Two' }]) },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('parseSalesRange', () => {
  it('accepts empty and valid ranges and rejects malformed or inverted ones', () => {
    expect(parseSalesRange({})).toEqual({ from: null, to: null });
    expect(parseSalesRange({ from: '2026-01-01', to: '2026-01-31' })).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(parseSalesRange({ from: '2026-02-30' })).toBeNull();
    expect(parseSalesRange({ from: '2026-03-01', to: '2026-02-01' })).toBeNull();
    expect(parseSalesRange({ to: 20260101 })).toBeNull();
  });
});

describe('basePackUnits', () => {
  it('counts base units down the current pack chain and leaves an unresolvable level blank', () => {
    const level = (
      id: string,
      parentPackLevelId: string | null,
      unitsPerParent: number,
      effectiveTo: Date | null = null
    ) => ({ id, parentPackLevelId, unitsPerParent, effectiveTo });
    const units = basePackUnits([
      level('box', null, 1),
      level('strip', 'box', 10),
      level('tablet', 'strip', 10),
      level('old-strip', 'box', 6, new Date('2026-01-01T00:00:00Z')),
      level('bottle', null, 120),
      level('kit', null, 1),
      level('kit-a', 'kit', 2),
      level('kit-b', 'kit', 3),
    ]);
    expect(units.get('box')).toBe(100);
    expect(units.get('strip')).toBe(10);
    expect(units.get('tablet')).toBe(1);
    expect(units.get('bottle')).toBe(120);
    expect(units.get('kit')).toBeNull();
  });
});

describe('loadOwnerDataExportRows', () => {
  it('scopes every read to the organization and filters sales by the inclusive date range', async () => {
    const db = fakeDb();
    await loadOwnerDataExportRows(db as never, 'org-a', { from: '2026-01-01', to: '2026-01-31' });
    for (const model of [
      'pharmacyBranch',
      'packLevel',
      'pharmacyInventoryLot',
      'pharmacyCustomer',
      'pharmacyKhataEvent',
      'pharmacySupplier',
      'pharmacySale',
      'pharmacyGoodsReceipt',
      'pharmacyControlledRegisterEntry',
    ] as const) {
      expect(db[model].findMany.mock.calls[0]![0].where.organizationId).toBe('org-a');
    }
    const saleWhere = db.pharmacySale.findMany.mock.calls[0]![0].where;
    expect(saleWhere.completedAt).toMatchObject({
      gte: new Date('2026-01-01T00:00:00.000Z'),
      lt: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(saleWhere.status).toEqual({ in: ['COMPLETED', 'VOID'] });
  });

  it('reads the picked dates on the organization clock, not UTC', async () => {
    const db = fakeDb();
    await loadOwnerDataExportRows(
      db as never,
      'org-a',
      { from: '2026-01-01', to: '2026-01-31' },
      'Asia/Karachi'
    );
    const saleWhere = db.pharmacySale.findMany.mock.calls[0]![0].where;
    expect(saleWhere.completedAt).toMatchObject({
      gte: new Date('2025-12-31T19:00:00.000Z'),
      lt: new Date('2026-01-31T19:00:00.000Z'),
    });
  });

  it('exports balances, stock and the controlled register as the register shows it', async () => {
    const rows = await loadOwnerDataExportRows(fakeDb() as never, 'org-a', {
      from: null,
      to: null,
    });
    expect(rows.customers).toEqual([
      expect.objectContaining({ code: 'c-1', balance: '200.00', credit_limit: '5000.00' }),
      expect.objectContaining({ code: 'c-2', balance: '0.00' }),
    ]);
    expect(rows.stockLots[0]).toMatchObject({
      batch: 'T-1',
      expiry: '2027-05-31',
      mrp: '150.00',
      cost: '12.50',
      quantity: 40,
      branch: 'RWP',
      location: 'SHELF',
    });
    expect(rows.medicines[0]).toMatchObject({
      code: 'pk-1',
      product: 'Tramadol 50mg',
      barcode: '8961000000017',
      pack: '10 units',
      pack_level: 'strip · capsule',
    });
    // Only the posted, unreversed receipt counts toward goods received.
    expect(rows.suppliers[0]).toMatchObject({
      goods_received_value: '625.00',
      supplier_credits: '5.00',
    });
    expect(rows.controlledRegister.map((row) => row.register_serial)).toEqual([1, 2]);
    expect(rows.controlledRegister[1]).toMatchObject({
      medicine_name: 'Tramadol 50mg',
      running_balance: 40,
      balance_change: -10,
      patient: 'Zara',
      prescriber: 'Dr Ali',
      prescriber_reg_no: 'PMDC-1',
      recorded_by: 'Owner One',
      witnessed_by: 'Pharmacist Two',
    });
    const ledger = exportCsv(OWNER_DATA_EXPORT_FILES.khataLedger, rows.khataLedger);
    expect(parseDelimitedText(ledger).rows[1]).toContain("'=cmd");
  });
});

describe('runPharmacyOwnerDataExportJob', () => {
  it('drops to the job tenant scope, stores the ZIP for that tenant and reports a 24-hour expiry', async () => {
    const db = fakeDb();
    const now = new Date('2026-11-15T10:00:00.000Z');
    const result = await runPharmacyOwnerDataExportJob(
      db as never,
      { id: 'job-7', organizationId: 'org-a' },
      { from: null, to: null },
      () => now
    );
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("'app.is_platform_admin', 'false'"),
      'org-a'
    );
    expect(db.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyCustomer.findMany.mock.invocationCallOrder[0]!
    );
    const [organizationId, filename, archive, contentType] = m.putUpload.mock.calls[0]!;
    expect([organizationId, filename, contentType]).toEqual([
      'org-a',
      'owner-data-export-job-7.zip',
      'application/zip',
    ]);
    expect((archive as Buffer).readUInt32LE(0)).toBe(0x04034b50);
    expect(result).toMatchObject({
      filename: 'owner-data-export-job-7.zip',
      expiresAt: '2026-11-16T10:00:00.000Z',
      rowCounts: expect.objectContaining({ 'controlled_register.csv': 2, 'customers.csv': 2 }),
    });
  });

  it('refuses a job with no organization or a bad range', async () => {
    await expect(
      runPharmacyOwnerDataExportJob(fakeDb() as never, { id: 'j', organizationId: null }, {})
    ).rejects.toThrow();
    await expect(
      runPharmacyOwnerDataExportJob(
        fakeDb() as never,
        { id: 'j', organizationId: 'org-a' },
        { from: 'x' }
      )
    ).rejects.toThrow();
    expect(m.putUpload).not.toHaveBeenCalled();
  });
});

describe('purgeExpiredOwnerDataExports', () => {
  it('deletes only archives past their 24-hour link and marks each job purged', async () => {
    const now = new Date('2026-11-15T10:00:00.000Z');
    const findMany = vi
      .fn()
      .mockResolvedValue([
        {
          id: 'job-old',
          organizationId: 'org-a',
          result: { filename: 'owner-data-export-job-old.zip', rowCounts: { 'customers.csv': 2 } },
        },
      ]);
    const update = vi.fn().mockResolvedValue({});
    const purged = await purgeExpiredOwnerDataExports(
      { platformJob: { findMany, update } } as never,
      now
    );
    expect(purged).toBe(1);
    const where = findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      type: 'PHARMACY_OWNER_DATA_EXPORT_V1',
      status: 'SUCCEEDED',
      finishedAt: { lt: new Date('2026-11-14T10:00:00.000Z') },
      result: { path: ['filename'], string_starts_with: 'owner-data-export-' },
    });
    expect(m.deleteUpload).toHaveBeenCalledWith('org-a', 'owner-data-export-job-old.zip');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'job-old' },
      data: {
        result: { filename: null, purgedAt: now.toISOString(), rowCounts: { 'customers.csv': 2 } },
      },
    });
    expect(m.deleteUpload.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]!
    );
  });
});
