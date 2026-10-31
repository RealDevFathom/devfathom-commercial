// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const storage = vi.hoisted(() => ({
  getUpload: vi.fn(),
  putUpload: vi.fn(async () => undefined),
  deleteUpload: vi.fn(async () => undefined),
}));
vi.mock('@/lib/storage', () => storage);
const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@/server/audit', () => ({ recordAudit: audit.recordAudit }));
const scope = vi.hoisted(() => ({
  withOrganizationDefaults: vi.fn(
    async (db: unknown, _organizationId: string, run: (tx: unknown) => Promise<unknown>) => run(db)
  ),
}));
vi.mock('@/lib/tenancy/scoped-db', () => scope);

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  collectPharmacyDataExport,
  expirePharmacyDataExports,
  parseSalesRange,
  PHARMACY_DATA_EXPORT_DAILY_LIMIT,
  PHARMACY_DATA_EXPORT_LINK_TTL_MS,
  relayPharmacyDataExportJobs,
  requestPharmacyDataExport,
  runPharmacyDataExportJob,
  viewPharmacyDataExport,
} from './data-export';
import { PHARMACY_EXPORT_FILES } from './data-export-format';
import { packConversions } from './pack-conversion';
import { registerPrintTotals } from './register-print';

const NOW = new Date('2026-10-31T07:00:00.000Z');
const RANGE = { from: '2026-10-01', to: '2026-10-30' };

function sqlText(sql: unknown): string {
  const value = sql as { text?: string; strings?: string[]; sql?: string };
  return value.text ?? value.sql ?? value.strings?.join('?') ?? '';
}

const packLevels = [
  {
    id: 'pl-strip',
    level: 'STRIP',
    unitsPerParent: 10,
    parentPackLevelId: null,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
  },
];

/** A seeded tenant in the shape each Prisma read returns. */
function seededDb() {
  const queries: string[] = [];
  const db = {
    $queryRaw: vi.fn(async (sql: unknown): Promise<unknown[]> => {
      const text = sqlText(sql);
      queries.push(text);
      return text.includes('NULLIF(current_setting') ? [{ branchId: 'prior-branch' }] : [];
    }),
    organization: {
      findUnique: vi.fn(async () => ({ displayName: 'Rawalpindi Pharmacy', legalName: 'RP Ltd' })),
    },
    pharmacyBranch: {
      findMany: vi.fn(async () => [
        { id: 'br-b', code: 'ISB', name: 'Blue Area', city: 'Islamabad', provinceCode: 'IS', active: true },
        { id: 'br-a', code: 'RWP', name: 'Saddar', city: 'Rawalpindi', provinceCode: 'PB', active: true },
      ]),
    },
    medicine: {
      findMany: vi.fn(async () => [
        {
          id: 'med-1',
          productName: 'Panadol 500mg',
          brandName: 'Panadol',
          manufacturer: 'GSK',
          drapRegistrationNumber: '012345',
          productFamily: 'PHARMACEUTICAL',
          rx: false,
          otc: true,
          restricted: false,
          controlled: false,
          highAlert: false,
          lasa: false,
          coldChain: false,
          saleable: true,
          strengths: [{ ingredient: { name: 'Paracetamol' }, value: '500', unit: 'mg' }],
          presentations: [
            {
              id: 'pr-1',
              presentation: 'Tablet',
              dosageForm: 'Tablet',
              route: 'Oral',
              packLevels,
              barcodes: [{ id: 'bc-1', type: 'GTIN', code: '8964000000011', normalizedCode: '8964000000011', packLevelId: 'pl-strip' as string | null }],
            },
          ],
        },
        {
          id: 'med-2',
          productName: 'New medicine',
          brandName: null,
          manufacturer: null,
          drapRegistrationNumber: null,
          productFamily: 'PHARMACEUTICAL',
          rx: true,
          otc: false,
          restricted: false,
          controlled: false,
          highAlert: false,
          lasa: false,
          coldChain: false,
          saleable: false,
          strengths: [],
          presentations: [],
        },
      ]),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn(async () => [
        {
          id: 'lot-1',
          branchId: 'br-a',
          unitsPerPack: 10,
          supplierName: 'Muller & Phipps',
          supplierInvoiceRef: 'INV-1',
          unitCostMinor: 250,
          printedMrpMinor: 3_000,
          receivedExpiresAt: new Date('2027-06-30T18:59:59.999Z'),
          receivedAt: new Date('2026-09-01T05:00:00.000Z'),
          batch: {
            batchNumber: 'B-1',
            state: 'ACTIVE',
            medicine: { id: 'med-1', productName: 'Panadol 500mg' },
          },
          balances: [
            {
              onHandUnits: 115,
              sealedPacks: 11,
              looseUnits: 5,
              disposition: 'AVAILABLE',
              location: { code: 'MAIN', name: 'Main store' },
            },
            {
              onHandUnits: 0,
              sealedPacks: 0,
              looseUnits: 0,
              disposition: 'QUARANTINE',
              location: { code: 'QTN', name: 'Quarantine' },
            },
          ],
        },
        {
          id: 'lot-2',
          branchId: 'br-a',
          unitsPerPack: 10,
          supplierName: 'Muller & Phipps',
          supplierInvoiceRef: 'INV-2',
          unitCostMinor: 260,
          printedMrpMinor: 3_000,
          receivedExpiresAt: new Date('2027-01-31T18:59:59.999Z'),
          receivedAt: null,
          batch: {
            batchNumber: 'B-2',
            state: 'ACTIVE',
            medicine: { id: 'med-1', productName: 'Panadol 500mg' },
          },
          balances: [],
        },
      ]),
    },
    pharmacyCustomer: {
      findMany: vi.fn(async () => [
        {
          id: 'cust-1',
          displayName: 'Ayesha Khan',
          phoneLast4: '4567',
          creditLimitMinor: 500_000,
          active: true,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
        },
        {
          id: 'cust-2',
          displayName: 'Bilal',
          phoneLast4: null,
          creditLimitMinor: 0,
          active: true,
          createdAt: new Date('2026-02-02T00:00:00.000Z'),
        },
      ]),
    },
    pharmacyFamilyAccount: {
      findMany: vi.fn(async (args: { where: { branchId: string } }) =>
        args.where.branchId === 'br-a'
          ? [{ id: 'fam-1', branchId: 'br-a', displayName: 'Khan family', payerCustomerId: 'cust-1' }]
          : []
      ),
    },
    pharmacyKhataEvent: {
      findMany: vi.fn(async (args: { where: { branchId: string } }) =>
        args.where.branchId === 'br-a'
          ? [
              {
                id: 'k-1',
                branchId: 'br-a',
                familyAccountId: 'fam-1',
                kind: 'CHARGE',
                amountMinor: 100_000,
                occurredAt: new Date('2026-10-01T05:00:00.000Z'),
                dueAt: new Date('2026-11-01T05:00:00.000Z'),
                settlesChargeId: null,
                note: null,
              },
              {
                id: 'k-2',
                branchId: 'br-a',
                familyAccountId: 'fam-1',
                kind: 'DISHONOURED_CHEQUE',
                amountMinor: 50_000,
                occurredAt: new Date('2026-10-02T05:00:00.000Z'),
                dueAt: null,
                settlesChargeId: null,
                note: '=cmd',
              },
              {
                id: 'k-3',
                branchId: 'br-a',
                familyAccountId: 'fam-1',
                kind: 'PAYMENT',
                amountMinor: 30_000,
                occurredAt: new Date('2026-10-03T05:00:00.000Z'),
                dueAt: null,
                settlesChargeId: 'k-1',
                note: null,
              },
            ]
          : []
      ),
    },
    pharmacySupplier: {
      findMany: vi.fn(async () => [
        {
          id: 'sup-1',
          name: 'Muller & Phipps',
          legalName: null,
          contactName: null,
          contactPhone: null,
          serviceArea: null,
          paymentTermsDays: 30,
          creditLimitMinor: 0,
          authorized: true,
          active: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]),
    },
    pharmacyPurchaseOrder: {
      findMany: vi.fn(async () => [
        {
          id: 'po-1',
          reference: 'PO-1',
          status: 'RECEIVING',
          branchId: 'br-a',
          supplierId: 'sup-1',
          createdAt: new Date('2026-08-30T00:00:00.000Z'),
          submittedAt: null,
          approvedAt: null,
          sentAt: null,
          expectedDeliveryAt: null,
          freightMinor: 0,
          otherChargesMinor: 0,
          note: null,
          lines: [
            {
              id: 'pol-1',
              lineNumber: 1,
              orderedPacks: 2,
              bonusPacks: 0,
              canonicalUnitsPerPack: 10,
              orderedCanonicalUnits: 20,
              bonusCanonicalUnits: 0,
              listPricePerPackMinor: 1_000,
              discountBps: 0,
              rebateBps: 0,
              taxBps: 0,
              taxCreditable: false,
              medicine: { productName: 'Panadol 500mg' },
            },
          ],
        },
      ]),
    },
    pharmacyGoodsReceipt: {
      findMany: vi.fn(async () =>
        (['POSTED', 'REVERSED'] as const).map((status, index) => ({
          id: `grn-${index + 1}`,
          reference: `GRN-${index + 1}`,
          status,
          branchId: 'br-a',
          supplierId: 'sup-1',
          purchaseOrderId: 'po-1',
          supplierInvoiceRef: `INV-${index + 1}`,
          supplierInvoiceDate: new Date('2026-09-01T00:00:00.000Z'),
          distributorNtn: null,
          distributorStrn: null,
          receivedAt: new Date('2026-09-01T05:00:00.000Z'),
          postedAt: new Date('2026-09-01T06:00:00.000Z'),
          reversedAt: status === 'REVERSED' ? new Date('2026-09-02T06:00:00.000Z') : null,
          reversalReason: null,
          directPurchase: false,
          note: null,
          lines: [
            {
              id: `grl-${index + 1}`,
              lineNumber: 1,
              batchNumber: 'B-1',
              printedExpiry: new Date('2027-06-30T18:59:59.999Z'),
              printedMrpMinor: 3_000,
              canonicalUnitsPerPack: 10,
              receivedPacks: 2,
              bonusPacks: 0,
              receivedCanonicalUnits: 20,
              bonusCanonicalUnits: 0,
              acceptedCanonicalUnits: 20,
              rejectedCanonicalUnits: 0,
              rejectionReason: null,
              invoicedPricePerPackMinor: 1_000,
              discountBps: 1_000,
              taxBps: 0,
              taxCreditable: false,
              unitCostMinor: 90,
              inventoryLotId: 'lot-1',
              gtin: null,
              serialNumber: null,
              medicine: { productName: 'Panadol 500mg' },
            },
          ],
        }))
      ),
    },
    pharmacyBookkeepingAllocation: {
      findMany: vi.fn(async () => [
        { sourceId: 'grn-1', amountMinor: 500 },
        { sourceId: 'unknown-bill', amountMinor: 999 },
      ]),
    },
    pharmacySale: {
      findMany: vi.fn(async () => [
        {
          id: 'sale-1',
          branchId: 'br-a',
          status: 'COMPLETED',
          createdAt: new Date('2026-10-10T05:00:00.000Z'),
          completedAt: new Date('2026-10-10T05:01:00.000Z'),
          businessDate: new Date('2026-10-10T00:00:00.000Z'),
          receiptNumber: 41,
          customerId: 'cust-1',
          lines: [
            {
              id: 'sl-1',
              saleUnit: 'STRIP',
              quantity: 2,
              canonicalUnitsPerSaleUnit: 10,
              canonicalUnits: 20,
              unitPriceMinor: 300,
              unitCostMinor: 25,
              discountKind: 'DISCOUNT',
              discountMinor: 50,
              medicineId: 'med-1',
              packLevelId: 'pl-strip',
              medicine: { productName: 'Panadol 500mg' },
            },
          ],
        },
      ]),
    },
    pharmacyControlledRegisterEntry: {
      findMany: vi.fn(async () => [
        registerEntry({ id: 'cr-a2', branchId: 'br-a', serial: 2, balanceDelta: -10, runningBalance: 90, quantityCanonicalUnits: 10 }),
        registerEntry({
          id: 'cr-a1',
          branchId: 'br-a',
          serial: 1,
          entryKind: 'PURCHASE',
          balanceDelta: 100,
          runningBalance: 100,
          quantityCanonicalUnits: 100,
          patient: null,
          counterpartyName: 'Muller & Phipps',
        }),
        registerEntry({
          id: 'cr-b1',
          branchId: 'br-b',
          serial: 1,
          medicine: null,
          line: { medicine: { productName: 'Tramadol (from Rx line)' } },
          emergency: true,
          refEntry: { serial: 7 },
        }),
      ]),
    },
    user: { findMany: vi.fn(async () => [{ id: 'pharm-1', name: 'Dr. Sana (user)' }]) },
    restaurantStaffProfile: {
      findMany: vi.fn(async () => [{ userId: 'pharm-1', displayName: 'Sana Pharmacist' }]),
    },
  };
  return { db, queries };
}

function registerEntry(extra: Record<string, unknown>) {
  return {
    id: 'cr',
    branchId: 'br-a',
    serial: 1,
    entryKind: 'SALE',
    emergency: false,
    prescriberName: 'Snapshot prescriber',
    prescriberRegNo: 'PMDC-1',
    patientAddress: 'House 1, Saddar',
    manufacturer: null,
    inventoryLotId: 'lot-t',
    batchNumber: 'T-1',
    quantityCanonicalUnits: 10,
    balanceDelta: -10,
    runningBalance: 90,
    witnessedByUserId: 'pharm-1',
    signatureRef: 'pin:1',
    rxSerialWritten: true,
    counterpartyName: null,
    correctionReason: null,
    createdAt: new Date('2026-10-10T05:00:00.000Z'),
    patient: { displayName: 'Patient One', cnic: '37405-1234567-1' },
    prescriber: { name: 'Dr. Prescriber', registrationNumber: 'PMDC-99' },
    prescription: { sourceFileRef: '/api/pharmacy/prescription-files?id=x' },
    medicine: { productName: 'Tramadol 50mg', manufacturer: 'Searle' },
    line: null,
    correctsEntry: null,
    refEntry: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sales range', () => {
  it('maps an inclusive Pakistan business-date range to UTC instants', () => {
    expect(parseSalesRange(RANGE, NOW)).toEqual({
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-30T00:00:00.000Z'),
      startsAt: new Date('2026-09-30T19:00:00.000Z'),
      endsBefore: new Date('2026-10-30T19:00:00.000Z'),
    });
  });

  it.each([
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-10-02', to: '2026-10-01' },
    { from: '2026-10-01', to: '2026-11-01' },
    { from: '2025-10-30', to: '2026-10-31' },
    { from: '01-10-2026', to: '2026-10-31' },
  ])('rejects $from → $to', (range) => {
    expect(() => parseSalesRange(range, NOW)).toThrow('INVALID_RANGE');
  });

  it('accepts exactly 366 days ending today in Pakistan', () => {
    expect(() => parseSalesRange({ from: '2025-10-31', to: '2026-10-31' }, NOW)).not.toThrow();
  });
});

describe('export status view', () => {
  const base = {
    id: 'e',
    status: 'READY' as const,
    salesFrom: new Date('2026-10-01T00:00:00.000Z'),
    salesTo: new Date('2026-10-30T00:00:00.000Z'),
    requestedAt: new Date('2026-10-31T06:00:00.000Z'),
    completedAt: new Date('2026-10-31T06:05:00.000Z'),
    expiresAt: new Date('2026-11-01T06:05:00.000Z'),
    sizeBytes: 1,
    rowCounts: { medicines: 2, ignored: 'x' },
    downloadCount: 0,
    error: null,
  };
  it('offers a READY archive only until its link expires', () => {
    expect(viewPharmacyDataExport(base, NOW)).toMatchObject({
      status: 'READY',
      downloadable: true,
      salesFrom: '2026-10-01',
      rowCounts: { medicines: 2 },
    });
    expect(
      viewPharmacyDataExport(base, new Date(base.expiresAt.getTime() + 1))
    ).toMatchObject({ status: 'EXPIRED', downloadable: false });
  });
  it('reports a request stuck in the queue as failed', () => {
    const queued = { ...base, status: 'QUEUED' as const, expiresAt: null };
    expect(viewPharmacyDataExport(queued, NOW).status).toBe('QUEUED');
    expect(
      viewPharmacyDataExport(queued, new Date(base.requestedAt.getTime() + 7 * 3_600_000))
    ).toMatchObject({ status: 'FAILED', downloadable: false });
  });
});

describe('request', () => {
  function requestDb(pending: unknown, recent: number) {
    const db = {
      $queryRaw: vi.fn(async () => []),
      pharmacyDataExport: {
        findFirst: vi.fn(async () => pending),
        count: vi.fn(async () => recent),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
          id: 'new',
          status: 'QUEUED',
          completedAt: null,
          expiresAt: null,
          sizeBytes: null,
          rowCounts: null,
          downloadCount: 0,
          error: null,
          ...args.data,
        })),
      },
    };
    return Object.assign(db, {
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db)),
    });
  }
  it('returns the pending request instead of queuing a second one', async () => {
    const pending = {
      id: 'pending',
      status: 'QUEUED',
      salesFrom: new Date('2026-10-01T00:00:00.000Z'),
      salesTo: new Date('2026-10-30T00:00:00.000Z'),
      requestedAt: new Date('2026-10-31T06:50:00.000Z'),
      completedAt: null,
      expiresAt: null,
      sizeBytes: null,
      rowCounts: null,
      downloadCount: 0,
      error: null,
    };
    const db = requestDb(pending, 1);
    const result = await requestPharmacyDataExport(
      db as unknown as ScopedDb,
      { organizationId: 'org-a', actorId: 'owner', range: RANGE },
      NOW
    );
    expect(result).toMatchObject({ created: false, export: { id: 'pending' } });
    expect(db.pharmacyDataExport.create).not.toHaveBeenCalled();
  });
  it('limits requests per rolling day', async () => {
    const db = requestDb(null, PHARMACY_DATA_EXPORT_DAILY_LIMIT);
    await expect(
      requestPharmacyDataExport(
        db as unknown as ScopedDb,
        { organizationId: 'org-a', actorId: 'owner', range: RANGE },
        NOW
      )
    ).rejects.toThrow('RATE_LIMITED');
    expect(db.pharmacyDataExport.create).not.toHaveBeenCalled();
  });
});

describe('collection', () => {
  it('preserves strengths and every barcode with its medicine, presentation and pack relationship', async () => {
    const { db } = seededDb();
    const medicines = await db.medicine.findMany();
    const presentation = medicines[0]!.presentations[0]!;
    presentation.barcodes.push(
      { id: 'bc-2', type: 'MANUFACTURER', code: '+second', normalizedCode: 'second', packLevelId: 'pl-strip' },
      { id: 'bc-3', type: 'INTERNAL', code: '@presentation', normalizedCode: 'presentation', packLevelId: null },
      { id: 'bc-4', type: 'GTIN', code: 'retired', normalizedCode: 'retired', packLevelId: 'retired-pack' },
    );
    db.medicine.findMany.mockResolvedValueOnce(medicines);
    const { dataset } = await collectPharmacyDataExport(db as unknown as ScopedDb, 'org-a', RANGE, NOW);
    expect(JSON.parse(String(dataset.medicines[0]!.strength_components))).toEqual([
      { ingredient: 'Paracetamol', value: '500', unit: 'mg' },
    ]);
    expect(JSON.parse(String(dataset.medicines[0]!.pack_barcodes))).toEqual([
      { code: '8964000000011', type: 'GTIN', normalized_code: '8964000000011' },
      { code: '+second', type: 'MANUFACTURER', normalized_code: 'second' },
    ]);
    expect(JSON.parse(String(dataset.medicines[0]!.presentation_barcodes))).toEqual([
      { code: '@presentation', type: 'INTERNAL', normalized_code: 'presentation' },
    ]);
    expect(dataset.medicineBarcodes).toEqual(presentation.barcodes.map((barcode) => ({
      code: barcode.id, medicine_code: 'med-1', presentation_code: 'pr-1',
      pack_level_code: barcode.packLevelId, barcode_value: barcode.code,
      barcode_type: barcode.type, normalized_code: barcode.normalizedCode,
    })));
  });

  it.each(['SUPPLIER_PAYMENT', 'CHEQUE', 'VOUCHER'])(
    'includes posted %s settlements and excludes reversed ones',
    async (kind) => {
      const { db } = seededDb();
      const allocations = [
        { sourceId: 'grn-1', amountMinor: 1_800, kind, status: 'POSTED' },
        { sourceId: 'grn-1', amountMinor: 900, kind, status: 'REVERSED' },
      ];
      db.pharmacyBookkeepingAllocation.findMany.mockImplementation(async (...args: unknown[]) => {
        const query = args[0] as {
          where: { transaction: { kind: string | { in: string[] }; status: string } };
        };
        const filter = query.where.transaction;
        return allocations.filter((row) =>
          (typeof filter.kind === 'string' ? filter.kind === row.kind : filter.kind.in.includes(row.kind)) &&
          row.status === filter.status
        );
      });
      const { dataset } = await collectPharmacyDataExport(db as unknown as ScopedDb, 'org-a', RANGE, NOW);
      expect(dataset.suppliers[0]).toMatchObject({
        purchased_total: '18.00', paid_total: '18.00', balance: '0.00',
      });
    }
  );

  it('builds every file from the tenant, scoped to the organization', async () => {
    const { db, queries } = seededDb();
    const { dataset, organizationName } = await collectPharmacyDataExport(
      db as unknown as ScopedDb,
      'org-a',
      RANGE,
      NOW
    );
    expect(organizationName).toBe('Rawalpindi Pharmacy');
    for (const model of [
      db.pharmacyBranch,
      db.medicine,
      db.pharmacyInventoryLot,
      db.pharmacyCustomer,
      db.pharmacySupplier,
      db.pharmacyPurchaseOrder,
      db.pharmacyGoodsReceipt,
      db.pharmacySale,
      db.pharmacyControlledRegisterEntry,
    ]) {
      expect(model.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-a' }) })
      );
    }

    // Medicines: one row per effective pack, plus a row for a medicine with none.
    const [conversion] = packConversions(packLevels, NOW);
    expect(dataset.medicines).toEqual([
      expect.objectContaining({
        code: 'pl-strip',
        product: 'Panadol 500mg',
        pack: conversion!.canonicalUnitsPerPack,
        pack_level: 'STRIP',
        barcode: '8964000000011',
      }),
      expect.objectContaining({ code: 'med-2', product: 'New medicine' }),
    ]);

    // Stock: held balances only, and an empty lot still appears once.
    expect(dataset.stockLots).toEqual([
      expect.objectContaining({
        code: 'lot-1:MAIN:AVAILABLE',
        batch: 'B-1',
        expiry: '2027-06-30',
        quantity: 115,
        cost: '2.50',
        mrp: '30.00',
        branch_code: 'RWP',
      }),
      expect.objectContaining({ code: 'lot-2', quantity: 0 }),
    ]);

    // Khata: charge + dishonoured cheque − payment, read under each branch context.
    expect(dataset.customers).toEqual([
      expect.objectContaining({ code: 'cust-1', balance: '1200.00', khata_accounts: 1 }),
      expect.objectContaining({ code: 'cust-2', balance: '0.00', khata_accounts: 0 }),
    ]);
    expect(dataset.khataLedger.map((row) => [row.code, row.customer, row.amount])).toEqual([
      ['k-1', 'Ayesha Khan', '1000.00'],
      ['k-2', 'Ayesha Khan', '500.00'],
      ['k-3', 'Ayesha Khan', '300.00'],
    ]);
    expect(queries.filter((text) => text.includes("set_config('app.current_branch_id'"))).toHaveLength(3);
    expect(db.$queryRaw.mock.calls.at(-1)![0]).toMatchObject({ values: ['prior-branch'] });

    // Suppliers: posted, unreversed bills (2 × 10.00 less 10%) less allocated payments.
    expect(dataset.suppliers).toEqual([
      expect.objectContaining({
        code: 'sup-1',
        purchased_total: '18.00',
        paid_total: '5.00',
        balance: '13.00',
      }),
    ]);
    expect(db.pharmacyBookkeepingAllocation.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        sourceKind: 'PURCHASE_INVOICE',
        transaction: {
          organizationId: 'org-a',
          kind: { in: ['SUPPLIER_PAYMENT', 'CHEQUE', 'VOUCHER'] },
          status: 'POSTED',
        },
      },
      select: { sourceId: true, amountMinor: true },
    });
    expect(dataset.goodsReceipts.map((row) => [row.code, row.payable, row.po_reference])).toEqual([
      ['grn-1', '18.00', 'PO-1'],
      ['grn-2', '18.00', 'PO-1'],
    ]);
    expect(dataset.goodsReceiptLines).toHaveLength(2);
    expect(dataset.purchaseOrderLines).toEqual([
      expect.objectContaining({ po_reference: 'PO-1', quantity: 20, supplier: 'Muller & Phipps' }),
    ]);

    // Sales: range filter by business date, falling back to Pakistan creation time.
    expect(db.pharmacySale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          OR: [
            {
              businessDate: {
                gte: new Date('2026-10-01T00:00:00.000Z'),
                lte: new Date('2026-10-30T00:00:00.000Z'),
              },
            },
            {
              businessDate: null,
              createdAt: {
                gte: new Date('2026-09-30T19:00:00.000Z'),
                lt: new Date('2026-10-30T19:00:00.000Z'),
              },
            },
          ],
        },
      })
    );
    expect(dataset.sales).toEqual([
      expect.objectContaining({
        code: 'sale-1',
        sale_date: '2026-10-10',
        customer: 'Ayesha Khan',
        gross: '6.00',
        discount: '0.50',
        net: '5.50',
        line_count: 1,
      }),
    ]);
    expect(dataset.saleLines).toEqual([
      expect.objectContaining({ sale_code: 'sale-1', quantity: 20, sale_quantity: 2, net: '5.50' }),
    ]);
    // Sales store unitCostMinor per sale unit; the column must export it unchanged and say so.
    expect(dataset.saleLines[0]).toMatchObject({ sale_unit: 'STRIP', pack: 10, cost: '0.25' });
    const costColumn = PHARMACY_EXPORT_FILES.saleLines.columns.find((c) => c.header === 'cost');
    expect(costColumn?.description).toMatch(/one sale unit \(not one canonical unit\)/);
  });

  it('exports the controlled register exactly as the printed register shows it', async () => {
    const { db } = seededDb();
    const { dataset } = await collectPharmacyDataExport(
      db as unknown as ScopedDb,
      'org-a',
      RANGE,
      NOW
    );
    // Print order: per branch, by serial.
    expect(dataset.controlledRegister.map((row) => [row.branch_code, row.serial_no])).toEqual([
      ['ISB', 1],
      ['RWP', 1],
      ['RWP', 2],
    ]);
    const [isb, purchase, sale] = dataset.controlledRegister;
    expect(sale).toMatchObject({
      entry_type: 'Sale',
      prescriber: 'Dr. Prescriber',
      prescriber_reg_no: 'PMDC-99',
      patient: 'Patient One',
      patient_cnic: '*********5671',
      product: 'Tramadol 50mg',
      manufacturer: 'Searle',
      quantity: 10,
      batch: 'T-1',
      qualified_person: 'Sana Pharmacist',
      pin_witnessed: true,
      running_balance: 90,
    });
    expect(purchase).toMatchObject({ entry_type: 'Purchase', patient: 'Muller & Phipps' });
    expect(isb).toMatchObject({
      entry_type: 'Emergency sale · repeats 7',
      product: 'Tramadol (from Rx line)',
    });
    const rwp = dataset.controlledRegister.filter((row) => row.branch_code === 'RWP');
    expect(
      registerPrintTotals(
        rwp.map((row) => ({
          inventoryLotId: String(row.lot_code),
          batchNumber: String(row.batch),
          balanceDelta: Number(row.balance_delta),
          runningBalance: Number(row.running_balance),
          serial: Number(row.serial_no),
        }))
      )
    ).toEqual({
      rows: 2,
      unitsIn: 100,
      unitsOut: 10,
      closing: [{ batchNumber: 'T-1', runningBalance: 90, serial: 2 }],
    });
  });
});

describe('worker', () => {
  function jobDb(status = 'QUEUED') {
    const { db } = seededDb();
    return Object.assign(db, {
      pharmacyDataExport: {
        findFirst: vi.fn(async () => ({
          id: 'exp-1',
          status,
          salesFrom: new Date('2026-10-01T00:00:00.000Z'),
          salesTo: new Date('2026-10-30T00:00:00.000Z'),
          requestedByUserId: 'owner-1',
          requestedAt: NOW,
        })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      platformJob: { createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })) },
    });
  }
  const job = { id: 'job-1', organizationId: 'org-a', attempts: 1, maxAttempts: 3 };

  it('builds the archive under the tenant scope, stores it privately and audits it', async () => {
    const db = jobDb();
    const result = await runPharmacyDataExportJob(
      db as unknown as ScopedDb,
      job,
      { exportId: 'exp-1' },
      { now: NOW }
    );
    expect(scope.withOrganizationDefaults).toHaveBeenCalledWith(db, 'org-a', expect.any(Function));
    expect(storage.putUpload).toHaveBeenCalledWith(
      'org-a/pharmacy-data-exports',
      'exp-1.zip',
      expect.any(Buffer),
      'application/zip'
    );
    const zip = (storage.putUpload.mock.calls[0] as unknown as [string, string, Buffer])[2];
    expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
    expect(db.pharmacyDataExport.update).toHaveBeenCalledWith({
      where: { id: 'exp-1' },
      data: expect.objectContaining({
        status: 'READY',
        storageKey: 'exp-1.zip',
        fileName: 'devfathom-pharmacy-export-2026-10-31-exp-1.zip',
        sizeBytes: zip.length,
        completedAt: NOW,
        expiresAt: new Date(NOW.getTime() + PHARMACY_DATA_EXPORT_LINK_TTL_MS),
        rowCounts: expect.objectContaining({ medicines: 2, controlledRegister: 3, sales: 1 }),
      }),
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        actorType: 'SYSTEM',
        action: 'pharmacy.dataExport.generated',
        targetId: 'exp-1',
        metadata: expect.objectContaining({ requestedByUserId: 'owner-1' }),
      }),
      db
    );
    expect(result).toMatchObject({ exportId: 'exp-1', sizeBytes: zip.length });
  });

  it('does nothing for a request that is no longer queued', async () => {
    const db = jobDb('READY');
    await expect(
      runPharmacyDataExportJob(db as unknown as ScopedDb, job, { exportId: 'exp-1' }, { now: NOW })
    ).resolves.toEqual({ exportId: 'exp-1', skipped: 'READY' });
    expect(storage.putUpload).not.toHaveBeenCalled();
  });

  it('never uploads a stale request even before the retention sweep runs', async () => {
    const db = jobDb();
    await expect(runPharmacyDataExportJob(db as unknown as ScopedDb, job, { exportId: 'exp-1' }, {
      now: new Date(NOW.getTime() + 7 * 3_600_000),
    })).resolves.toMatchObject({ skipped: 'stale' });
    expect(storage.putUpload).not.toHaveBeenCalled();
  });

  it('retries a storage failure, then marks the request failed on the last attempt', async () => {
    storage.putUpload.mockRejectedValue(new Error('bucket down'));
    const db = jobDb();
    await expect(
      runPharmacyDataExportJob(db as unknown as ScopedDb, job, { exportId: 'exp-1' }, { now: NOW })
    ).rejects.toThrow('bucket down');
    expect(db.pharmacyDataExport.update).not.toHaveBeenCalled();
    await expect(
      runPharmacyDataExportJob(
        db as unknown as ScopedDb,
        { ...job, attempts: 3 },
        { exportId: 'exp-1' },
        { now: NOW }
      )
    ).resolves.toEqual({ exportId: 'exp-1', failed: true });
    expect(db.pharmacyDataExport.update).toHaveBeenCalledWith({
      where: { id: 'exp-1' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILURE', targetId: 'exp-1' }),
      db
    );
    storage.putUpload.mockResolvedValue(undefined);
  });

  it('requires an organization and an export id', async () => {
    const db = jobDb();
    await expect(
      runPharmacyDataExportJob(db as unknown as ScopedDb, { ...job, organizationId: null }, {})
    ).rejects.toThrow('requires an organization');
    await expect(runPharmacyDataExportJob(db as unknown as ScopedDb, job, {})).rejects.toThrow(
      'exportId'
    );
  });

  it('relays queued requests to keyed jobs and skips the insert when none are waiting', async () => {
    const db = jobDb();
    db.$queryRaw.mockResolvedValueOnce([
      { id: 'exp-1', organizationId: 'org-a' },
      { id: 'exp-2', organizationId: 'org-b' },
    ]);
    await expect(relayPharmacyDataExportJobs(db as unknown as ScopedDb)).resolves.toBe(2);
    expect(db.platformJob.createMany).toHaveBeenCalledWith({
      data: [
        {
          organizationId: 'org-a',
          type: 'PHARMACY_DATA_EXPORT_V1',
          payload: { exportId: 'exp-1' },
          idempotencyKey: 'pharmacy.data.export.v1:exp-1',
        },
        {
          organizationId: 'org-b',
          type: 'PHARMACY_DATA_EXPORT_V1',
          payload: { exportId: 'exp-2' },
          idempotencyKey: 'pharmacy.data.export.v1:exp-2',
        },
      ],
      skipDuplicates: true,
    });
    db.$queryRaw.mockResolvedValueOnce([]);
    db.platformJob.createMany.mockClear();
    await expect(relayPharmacyDataExportJobs(db as unknown as ScopedDb)).resolves.toBe(0);
    expect(db.platformJob.createMany).not.toHaveBeenCalled();
  });

  it('deletes lapsed archives and keeps the row as EXPIRED history', async () => {
    const db = jobDb();
    db.$queryRaw.mockResolvedValueOnce([
      { id: 'exp-1', organizationId: 'org-a', storageKey: 'exp-1.zip' },
      { id: 'exp-2', organizationId: 'org-b', storageKey: 'exp-2.zip' },
    ]);
    storage.deleteUpload
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('storage down'));
    await expect(expirePharmacyDataExports(db as unknown as ScopedDb, NOW)).resolves.toBe(1);
    expect(storage.deleteUpload).toHaveBeenCalledWith('org-a/pharmacy-data-exports', 'exp-1.zip');
    expect(db.pharmacyDataExport.updateMany).toHaveBeenCalledTimes(1);
    expect(db.pharmacyDataExport.updateMany).toHaveBeenCalledWith({
      where: { id: 'exp-1', organizationId: 'org-a', status: { in: ['READY', 'FAILED', 'QUEUED'] } },
      data: { status: 'EXPIRED', storageKey: null },
    });
  });
});
