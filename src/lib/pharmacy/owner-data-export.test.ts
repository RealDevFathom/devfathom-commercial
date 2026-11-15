// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  putUploadFile: vi.fn(),
  getUploadStream: vi.fn(),
  deleteUpload: vi.fn(),
  uploaded: [] as { path: string; data: Buffer }[],
}));
vi.mock('@/lib/storage', () => ({
  putUploadFile: m.putUploadFile,
  getUploadStream: m.getUploadStream,
  deleteUpload: m.deleteUpload,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: vi.fn() }));

import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { Prisma } from '@/generated/prisma/client';
import { parseDelimitedText } from './migration/source-values';
import {
  OWNER_DATA_EXPORT_BUILD_TIME_LIMIT_MS,
  OWNER_DATA_EXPORT_PAGE_SIZE,
  OWNER_DATA_EXPORT_REQUEST_LIMIT,
  OwnerDataExportTimeLimitError,
  OwnerDataExportTooLargeError,
  basePackUnits,
  loadOwnerDataExportRows,
  parseSalesRange,
  purgeExpiredOwnerDataExports,
  queueOwnerDataExport,
  runPharmacyOwnerDataExportJob,
} from './owner-data-export';
import {
  OWNER_DATA_EXPORT_FILES,
  buildOwnerDataExportZip,
  exportCsv,
} from './owner-data-export-format';

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

beforeEach(() => {
  vi.clearAllMocks();
  m.uploaded = [];
  // The job deletes its temporary file afterwards, so capture the bytes on upload.
  m.putUploadFile.mockImplementation(async (_org: string, _name: string, path: string) => {
    m.uploaded.push({ path, data: await readFile(path) });
  });
});

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
    const [organizationId, filename, , contentType] = m.putUploadFile.mock.calls[0]!;
    expect([organizationId, contentType]).toEqual(['org-a', 'application/zip']);
    // Unguessable: the job id alone does not name the stored archive.
    expect(filename).toMatch(/^owner-data-export-job-7-[0-9a-f]{32}\.zip$/);
    const archive = m.uploaded[0]!.data;
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(result.bytes).toBe(archive.length);
    expect(result).toMatchObject({
      filename,
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
    expect(m.putUploadFile).not.toHaveBeenCalled();
  });

  it('streams the same archive the in-memory builder would make, then deletes its temp file', async () => {
    const now = new Date('2026-11-15T10:00:00.000Z');
    await runPharmacyOwnerDataExportJob(
      fakeDb() as never,
      { id: 'job-8', organizationId: 'org-a' },
      { from: null, to: null },
      () => now
    );
    const rows = await loadOwnerDataExportRows(fakeDb() as never, 'org-a', {
      from: null,
      to: null,
    });
    const expected = buildOwnerDataExportZip(
      { organizationName: 'Shifa Pharmacy', generatedAt: now, salesFrom: null, salesTo: null },
      rows
    );
    expect(m.uploaded[0]!.data.equals(expected)).toBe(true);
    await expect(readFile(m.uploaded[0]!.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails permanently over the size cap, uploads nothing and leaves no temp file', async () => {
    const leftovers = async () =>
      (await readdir(tmpdir())).filter((name) => name.startsWith('owner-data-export-'));
    const before = await leftovers();
    const error = await runPharmacyOwnerDataExportJob(
      fakeDb() as never,
      { id: 'job-9', organizationId: 'org-a' },
      {},
      () => new Date(),
      { maxBytes: 600 }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwnerDataExportTooLargeError);
    expect((error as Error).message).toMatch(/larger than/);
    expect(m.putUploadFile).not.toHaveBeenCalled();
    expect(await leftovers()).toEqual(before);
  });

  it('writes every attempt of a job to the one archive name its payload reserved (DEV-844)', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    const payload = { from: null, to: null, archiveToken: token };
    const job = { id: 'job-10', organizationId: 'org-a' };
    // A first attempt whose upload outlived its transaction, then the retry.
    await runPharmacyOwnerDataExportJob(fakeDb() as never, job, payload);
    const retried = await runPharmacyOwnerDataExportJob(fakeDb() as never, job, payload);
    const names = m.putUploadFile.mock.calls.map(([, name]) => name);
    expect(names).toEqual([
      `owner-data-export-job-10-${token}.zip`,
      `owner-data-export-job-10-${token}.zip`,
    ]);
    expect(retried.filename).toBe(`owner-data-export-job-10-${token}.zip`);
  });

  it('fails permanently past its build time limit, uploads nothing and leaves no temp file (DEV-844)', async () => {
    const leftovers = async () =>
      (await readdir(tmpdir())).filter((name) => name.startsWith('owner-data-export-'));
    const before = await leftovers();
    const error = await runPharmacyOwnerDataExportJob(
      fakeDb() as never,
      { id: 'job-11', organizationId: 'org-a' },
      {},
      () => new Date(),
      { timeLimitMs: 0 }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwnerDataExportTimeLimitError);
    expect((error as Error).message).toMatch(/shorter sales date range/);
    expect(m.putUploadFile).not.toHaveBeenCalled();
    expect(await leftovers()).toEqual(before);
  });

  it('builds within a time limit that leaves room to upload before the 120-second job timeout', () => {
    expect(OWNER_DATA_EXPORT_BUILD_TIME_LIMIT_MS).toBeLessThan(120_000);
  });
});

describe('owner data export paging', () => {
  it('reads a large table in keyset pages and exports every row once', async () => {
    const total = OWNER_DATA_EXPORT_PAGE_SIZE * 2 + 3;
    const all = Array.from({ length: total }, (_, index) => ({
      id: `c-${String(index).padStart(5, '0')}`,
      displayName: `Customer ${index}`,
      phoneLast4: null,
      creditLimitMinor: 0,
      active: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }));
    const db = fakeDb();
    db.pharmacyCustomer.findMany = vi.fn(
      async (args: { take: number; skip?: number; cursor?: { id: string } }) => {
        const start = args.cursor
          ? all.findIndex((row) => row.id === args.cursor!.id) + (args.skip ?? 0)
          : 0;
        return all.slice(start, start + args.take);
      }
    );
    const rows = await loadOwnerDataExportRows(db as never, 'org-a', { from: null, to: null });
    expect(rows.customers.map((row) => row.code)).toEqual(all.map((row) => row.id));
    const calls = db.pharmacyCustomer.findMany.mock.calls.map(([args]) => args);
    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.take === OWNER_DATA_EXPORT_PAGE_SIZE)).toBe(true);
    expect(calls[0]!.cursor).toBeUndefined();
    expect(calls[1]).toMatchObject({
      cursor: { id: all[OWNER_DATA_EXPORT_PAGE_SIZE - 1]!.id },
      skip: 1,
    });
  });

  it('pages every exported table, ordered so the cursor resumes after the last row', async () => {
    const db = fakeDb();
    await loadOwnerDataExportRows(db as never, 'org-a', { from: null, to: null });
    for (const model of [
      'pharmacyBranch',
      'pharmacyStockLocation',
      'packLevel',
      'pharmacyInventoryLot',
      'pharmacyCustomer',
      'pharmacyFamilyAccount',
      'pharmacyKhataEvent',
      'pharmacySupplier',
      'pharmacySupplierCredit',
      'pharmacySale',
      'pharmacyPurchaseOrder',
      'pharmacyGoodsReceipt',
      'pharmacyControlledRegisterEntry',
    ] as const) {
      for (const [args] of db[model].findMany.mock.calls) {
        expect(args.take).toBe(OWNER_DATA_EXPORT_PAGE_SIZE);
        expect(args.where.organizationId).toBe('org-a');
        const order = [args.orderBy].flat();
        expect(order[order.length - 1]).toEqual({ id: 'asc' });
      }
    }
  });
});

describe('queueOwnerDataExport', () => {
  const now = new Date('2026-11-15T10:00:00.000Z');
  const input = {
    organizationId: 'org-a',
    userId: 'u-owner',
    range: { from: null, to: null },
    now,
  };
  function platformDb(recent: Date[] = [], pending: unknown = null) {
    return {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      platformJob: {
        findFirst: vi.fn().mockResolvedValue(pending),
        findMany: vi.fn().mockResolvedValue(recent.map((createdAt) => ({ createdAt }))),
        create: vi.fn().mockResolvedValue({ id: 'job-new' }),
      },
    };
  }

  it('takes the workspace lock before checking and queues under the limit', async () => {
    const db = platformDb([new Date(now.getTime() - 60_000)]);
    const result = await queueOwnerDataExport(db as never, input);
    expect(result).toEqual({ kind: 'created', job: { id: 'job-new' } });
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      'owner-data-export:org-a'
    );
    expect(db.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      db.platformJob.findMany.mock.invocationCallOrder[0]!
    );
    expect(db.platformJob.findMany.mock.calls[0]![0].where).toMatchObject({
      organizationId: 'org-a',
      type: 'PHARMACY_OWNER_DATA_EXPORT_V1',
      requestedById: 'u-owner',
      createdAt: { gte: new Date('2026-11-14T10:00:00.000Z') },
    });
    expect(db.platformJob.create.mock.calls[0]![0].data).toMatchObject({
      organizationId: 'org-a',
      requestedById: 'u-owner',
    });
  });

  it('reserves an unguessable archive token on the job when it is queued (DEV-844)', async () => {
    const first = platformDb();
    const second = platformDb();
    await queueOwnerDataExport(first as never, input);
    await queueOwnerDataExport(second as never, input);
    const tokens = [first, second].map(
      (db) => db.platformJob.create.mock.calls[0]![0].data.payload.archiveToken
    );
    expect(tokens[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens[1]).not.toBe(tokens[0]);
  });

  it('refuses the owner once the daily limit is used and says when a slot frees', async () => {
    const recent = Array.from(
      { length: OWNER_DATA_EXPORT_REQUEST_LIMIT },
      (_, index) => new Date(now.getTime() - (20 - index) * 60 * 60_000)
    );
    const db = platformDb(recent);
    expect(await queueOwnerDataExport(db as never, input)).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 4 * 60 * 60,
    });
    expect(db.platformJob.create).not.toHaveBeenCalled();
  });

  it('returns the export already in flight without counting or creating one', async () => {
    const pending = { id: 'job-1', status: 'RUNNING' };
    const db = platformDb([], pending);
    expect(await queueOwnerDataExport(db as never, input)).toEqual({
      kind: 'pending',
      job: pending,
    });
    expect(db.platformJob.create).not.toHaveBeenCalled();
  });
});

describe('purgeExpiredOwnerDataExports', () => {
  it('deletes only archives past their 24-hour link and marks each job purged', async () => {
    const now = new Date('2026-11-15T10:00:00.000Z');
    const findMany = vi.fn().mockResolvedValueOnce([
      {
        id: 'job-old',
        organizationId: 'org-a',
        result: { filename: 'owner-data-export-job-old.zip', rowCounts: { 'customers.csv': 2 } },
      },
    ]);
    findMany.mockResolvedValue([]);
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

  it('deletes the tokenized archive name recorded on the job', async () => {
    const filename = 'owner-data-export-job-new-0123456789abcdef0123456789abcdef.zip';
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'job-new', organizationId: 'org-a', result: { filename } }])
      .mockResolvedValue([]);
    const update = vi.fn().mockResolvedValue({});
    await purgeExpiredOwnerDataExports({ platformJob: { findMany, update } } as never);
    expect(m.deleteUpload).toHaveBeenCalledExactlyOnceWith('org-a', filename);
  });
});

describe('purging archives of exports that never succeeded (DEV-844)', () => {
  const now = new Date('2026-11-15T10:00:00.000Z');
  const token = 'fedcba9876543210fedcba9876543210';
  const UNRECORDED = {
    type: 'PHARMACY_OWNER_DATA_EXPORT_V1',
    status: { in: ['FAILED', 'CANCELLED'] },
    finishedAt: { lt: new Date('2026-11-14T10:00:00.000Z') },
    // Only jobs no result names an archive for: a recorded archive is never touched here.
    result: { equals: Prisma.AnyNull },
  };
  const MARKER = { result: { filename: null, purgedAt: now.toISOString() } };

  function platformDb(abandoned: unknown[], claims: number[] = []) {
    const findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(abandoned);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    for (const count of claims) updateMany.mockResolvedValueOnce({ count });
    const update = vi.fn().mockResolvedValue({});
    return { platformJob: { findMany, updateMany, update } };
  }

  it('claims, then deletes, the reserved archive of a failed or cancelled job 24 hours after it ended', async () => {
    const db = platformDb([
      { id: 'job-failed', organizationId: 'org-a', payload: { archiveToken: token } },
      { id: 'job-cancelled', organizationId: 'org-b', payload: { archiveToken: token } },
    ]);
    const purged = await purgeExpiredOwnerDataExports(db as never, now);
    expect(purged).toBe(2);
    expect(db.platformJob.findMany.mock.calls[1]![0].where).toEqual(UNRECORDED);
    // Each claim re-checks every condition on that one row, under its row lock.
    expect(db.platformJob.updateMany.mock.calls).toEqual([
      [{ where: { ...UNRECORDED, id: 'job-failed' }, data: MARKER }],
      [{ where: { ...UNRECORDED, id: 'job-cancelled' }, data: MARKER }],
    ]);
    expect(m.deleteUpload.mock.calls).toEqual([
      ['org-a', `owner-data-export-job-failed-${token}.zip`],
      ['org-b', `owner-data-export-job-cancelled-${token}.zip`],
    ]);
    // Purge first: the claim is taken before anything is deleted.
    expect(db.platformJob.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      m.deleteUpload.mock.invocationCallOrder[0]!
    );
    expect(db.platformJob.updateMany.mock.invocationCallOrder[1]).toBeLessThan(
      m.deleteUpload.mock.invocationCallOrder[1]!
    );
    expect(db.platformJob.update).not.toHaveBeenCalled();
  });

  it('deletes nothing and overwrites nothing when a platform retry got there first', async () => {
    // Read as failed, then retried (and perhaps rebuilt) before the claim: it matches no row.
    const db = platformDb(
      [
        { id: 'job-retried', organizationId: 'org-a', payload: { archiveToken: token } },
        { id: 'job-failed', organizationId: 'org-a', payload: { archiveToken: token } },
      ],
      [0, 1]
    );
    const purged = await purgeExpiredOwnerDataExports(db as never, now);
    expect(purged).toBe(1);
    expect(m.deleteUpload).toHaveBeenCalledExactlyOnceWith(
      'org-a',
      `owner-data-export-job-failed-${token}.zip`
    );
    expect(db.platformJob.update).not.toHaveBeenCalled();
  });

  it('stops before deleting anything else when a delete fails, so its claim rolls back', async () => {
    const db = platformDb([
      { id: 'job-a', organizationId: 'org-a', payload: { archiveToken: token } },
      { id: 'job-b', organizationId: 'org-a', payload: { archiveToken: token } },
    ]);
    m.deleteUpload.mockRejectedValueOnce(new Error('storage down'));
    await expect(purgeExpiredOwnerDataExports(db as never, now)).rejects.toThrow('storage down');
    expect(m.deleteUpload).toHaveBeenCalledOnce();
    expect(db.platformJob.updateMany).toHaveBeenCalledOnce();
  });

  it('marks a job without a reserved token swept without deleting anything', async () => {
    const db = platformDb([
      { id: 'job-legacy', organizationId: 'org-a', payload: { from: null } },
      { id: 'job-bad', organizationId: 'org-a', payload: { archiveToken: '../../x' } },
    ]);
    const purged = await purgeExpiredOwnerDataExports(db as never, now);
    expect(purged).toBe(0);
    expect(m.deleteUpload).not.toHaveBeenCalled();
    expect(db.platformJob.updateMany).toHaveBeenCalledTimes(2);
  });
});
