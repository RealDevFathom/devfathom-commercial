import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const hasModule = vi.fn<(view: { enabledModules: string[] }, key: string) => boolean>();
  hasModule.mockReturnValue(true);
  return { hasModule };
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyPurchasingRouter } from './pharmacy-purchasing';
import type { TRPCContext } from '../trpc';
import { moduleForProcedure } from '@/lib/module-catalog';

const FUTURE = new Date('2030-01-01T00:00:00.000Z');
const PAST = new Date('2020-01-01T00:00:00.000Z');

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
    update: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
  };
}

function makeDb() {
  const db = {
    medicine: model(),
    packLevel: model(),
    pharmacySupplier: model(),
    pharmacySupplierLicence: model(),
    pharmacyRequisition: model(),
    pharmacyRequisitionLine: model(),
    pharmacyQuote: model(),
    pharmacyQuoteLine: model(),
    pharmacyPurchaseOrder: model(),
    pharmacyPurchaseOrderLine: model(),
    pharmacyPurchaseOrderApproval: model(),
    pharmacyGoodsReceipt: model(),
    pharmacyGoodsReceiptLine: model(),
    pharmacyReceivingException: model(),
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
  });
}

let db = makeDb();

function caller(userId = 'user_a', enabledModules = ['pharmacy-procurement']) {
  return pharmacyPurchasingRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules,
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: { expires: 'later', user: { id: userId, role: 'ADMIN', status: 'ACTIVE' } },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

/** An authorized supplier holding one unexpired verified licence. */
function orderableSupplier() {
  db.pharmacySupplier.findFirst.mockResolvedValue({
    id: 'supplier_a',
    authorized: true,
    licences: [{ expiresAt: FUTURE, verifiedAt: PAST }],
  });
}

function resolvableCatalog() {
  db.medicine.findFirst.mockResolvedValue({ id: 'medicine_a' });
  db.packLevel.findFirst.mockResolvedValue({ id: 'pack_a' });
}

const ORDER_LINE = {
  medicineId: 'medicine_a',
  packLevelId: 'pack_a',
  orderedPacks: 10,
  canonicalUnitsPerPack: 10,
  listPricePerPackMinor: 10_000,
};

beforeEach(() => {
  db = makeDb();
  mocks.hasModule.mockImplementation((view, key) => view.enabledModules.includes(key));
});

describe('PUR-01 a purchase order needs a licensed, authorized supplier', () => {
  it('refuses an order for an unauthorized supplier', async () => {
    resolvableCatalog();
    db.pharmacySupplier.findFirst.mockResolvedValue({
      id: 'supplier_a',
      authorized: false,
      licences: [{ expiresAt: FUTURE, verifiedAt: PAST }],
    });
    await expect(
      caller().createPurchaseOrder({
        reference: 'PO-1',
        supplierId: 'supplier_a',
        lines: [ORDER_LINE],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SUPPLIER_NOT_AUTHORIZED' });
    expect(db.pharmacyPurchaseOrder.create).not.toHaveBeenCalled();
  });

  it('refuses an order for a supplier whose licence has expired', async () => {
    resolvableCatalog();
    db.pharmacySupplier.findFirst.mockResolvedValue({
      id: 'supplier_a',
      authorized: true,
      licences: [{ expiresAt: PAST, verifiedAt: PAST }],
    });
    await expect(
      caller().createPurchaseOrder({
        reference: 'PO-1',
        supplierId: 'supplier_a',
        lines: [ORDER_LINE],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SUPPLIER_LICENCE_EXPIRED' });
    expect(db.pharmacyPurchaseOrder.create).not.toHaveBeenCalled();
  });

  it('refuses to send an approved order whose supplier has since been de-authorized', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      status: 'APPROVED',
      supplierId: 'supplier_a',
    });
    db.pharmacySupplier.findFirst.mockResolvedValue({
      id: 'supplier_a',
      authorized: false,
      licences: [{ expiresAt: FUTURE, verifiedAt: PAST }],
    });
    await expect(caller().sendPurchaseOrder({ purchaseOrderId: 'po_a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'SUPPLIER_NOT_AUTHORIZED',
    });
    expect(db.pharmacyPurchaseOrder.update).not.toHaveBeenCalled();
  });

  it('creates the order and mirrors packs into integer canonical units', async () => {
    resolvableCatalog();
    orderableSupplier();
    await caller().createPurchaseOrder({
      reference: 'PO-1',
      supplierId: 'supplier_a',
      lines: [{ ...ORDER_LINE, bonusPacks: 2 }],
    });
    const { data } = db.pharmacyPurchaseOrder.create.mock.calls[0]![0];
    expect(data.createdByUserId).toBe('user_a');
    expect(data.lines.create).toEqual([
      {
        ...ORDER_LINE,
        bonusPacks: 2,
        discountBps: 0,
        rebateBps: 0,
        taxBps: 0,
        taxCreditable: false,
        lineNumber: 1,
        orderedCanonicalUnits: 100,
        bonusCanonicalUnits: 20,
      },
    ]);
  });
});

describe('PUR-02 approval', () => {
  beforeEach(() => {
    orderableSupplier();
  });

  it('refuses approval by the person who drafted the order', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      status: 'SUBMITTED',
      supplierId: 'supplier_a',
      createdByUserId: 'user_a',
      requisition: null,
    });
    await expect(
      caller('user_a').approvePurchaseOrder({ purchaseOrderId: 'po_a', decision: 'APPROVED' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SELF_APPROVAL' });
    expect(db.pharmacyPurchaseOrderApproval.create).not.toHaveBeenCalled();
    expect(db.pharmacyPurchaseOrder.update).not.toHaveBeenCalled();
  });

  it('refuses approval by the person who raised the requisition', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      status: 'SUBMITTED',
      supplierId: 'supplier_a',
      createdByUserId: 'user_a',
      requisition: { requestedByUserId: 'user_b' },
    });
    await expect(
      caller('user_b').approvePurchaseOrder({ purchaseOrderId: 'po_a', decision: 'APPROVED' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SELF_APPROVAL' });
    expect(db.pharmacyPurchaseOrderApproval.create).not.toHaveBeenCalled();
  });

  it('records the approval event with its actor and policy', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      status: 'SUBMITTED',
      supplierId: 'supplier_a',
      createdByUserId: 'user_a',
      requisition: { requestedByUserId: 'user_b' },
    });
    await caller('user_c').approvePurchaseOrder({
      purchaseOrderId: 'po_a',
      decision: 'APPROVED',
    });
    expect(db.pharmacyPurchaseOrderApproval.create.mock.calls[0]![0].data).toMatchObject({
      purchaseOrderId: 'po_a',
      actorUserId: 'user_c',
      policy: 'PUR-02:SEGREGATION_OF_DUTIES',
      decision: 'APPROVED',
      fromStatus: 'SUBMITTED',
      toStatus: 'APPROVED',
    });
    expect(db.pharmacyPurchaseOrder.update.mock.calls[0]![0].data).toMatchObject({
      status: 'APPROVED',
      approvedByUserId: 'user_c',
    });
  });

  it('records a rejection and returns the order to DRAFT', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      status: 'SUBMITTED',
      supplierId: 'supplier_a',
      createdByUserId: 'user_a',
      requisition: null,
    });
    await caller('user_c').approvePurchaseOrder({
      purchaseOrderId: 'po_a',
      decision: 'REJECTED',
      reason: 'Price above the last landed cost.',
    });
    expect(db.pharmacyPurchaseOrderApproval.create.mock.calls[0]![0].data).toMatchObject({
      decision: 'REJECTED',
      toStatus: 'DRAFT',
      reason: 'Price above the last landed cost.',
    });
    expect(db.pharmacyPurchaseOrder.update.mock.calls[0]![0].data).toEqual({ status: 'DRAFT' });
  });

  it('refuses to approve an order that was never submitted', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      status: 'DRAFT',
      supplierId: 'supplier_a',
      createdByUserId: 'user_a',
      requisition: null,
    });
    await expect(
      caller('user_c').approvePurchaseOrder({ purchaseOrderId: 'po_a', decision: 'APPROVED' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'INVALID_TRANSITION' });
  });
});

describe('PUR-02 tenant boundaries', () => {
  it('rejects a cross-tenant medicine ID substitution on a requisition', async () => {
    db.packLevel.findFirst.mockResolvedValue({ id: 'pack_a' });
    await expect(
      caller().createRequisition({
        reference: 'REQ-1',
        lines: [
          {
            medicineId: 'medicine_from_org_b',
            packLevelId: 'pack_a',
            quantityPacks: 1,
            canonicalUnitsPerPack: 10,
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyRequisition.create).not.toHaveBeenCalled();
  });

  it('rejects a quote line pointing at another requisition’s line', async () => {
    db.pharmacySupplier.findFirst.mockResolvedValue({ id: 'supplier_a' });
    db.pharmacyRequisition.findFirst.mockResolvedValue({
      id: 'req_a',
      lines: [{ id: 'reqline_a' }],
    });
    await expect(
      caller().recordQuote({
        requisitionId: 'req_a',
        supplierId: 'supplier_a',
        quotedAt: PAST,
        validUntil: FUTURE,
        lines: [
          {
            requisitionLineId: 'reqline_from_another_requisition',
            pricePerPackMinor: 100,
            canonicalUnitsPerPack: 10,
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyQuote.create).not.toHaveBeenCalled();
  });

  it('rejects a purchase order quoting another supplier’s quote', async () => {
    resolvableCatalog();
    orderableSupplier();
    db.pharmacyQuote.findFirst.mockResolvedValue(null);
    await expect(
      caller().createPurchaseOrder({
        reference: 'PO-1',
        supplierId: 'supplier_a',
        quoteId: 'quote_from_supplier_b',
        lines: [ORDER_LINE],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyPurchaseOrder.create).not.toHaveBeenCalled();
  });

  it('maps the public router prefix to the pharmacy-procurement entitlement', () => {
    // PUR-01..05 are licensed as Pharmacy Procurement — the registry key from
    // vertical-catalog — and not as the mandatory Core module that carries
    // medicine identity.
    expect(moduleForProcedure('pharmacyPurchasing.createPurchaseOrder')).toBe(
      'pharmacy-procurement'
    );
    expect(moduleForProcedure('pharmacyPurchasing.postGoodsReceipt')).toBe('pharmacy-procurement');
    expect(moduleForProcedure('pharmacyMedicine.createIngredient')).toBe('pharmacy-core');
  });
});

describe('PUR-02/PUR-03 comparison and landed cost over stored rows', () => {
  it('ranks the stored quotes for a requisition line and awards nothing', async () => {
    db.pharmacyRequisitionLine.findFirst.mockResolvedValue({
      id: 'reqline_a',
      quantityPacks: 10,
    });
    const supplier = (id: string, name: string, authorized: boolean) => ({
      supplierId: id,
      supplier: {
        id,
        name,
        authorized,
        licences: [{ expiresAt: FUTURE, verifiedAt: PAST }],
      },
      validUntil: FUTURE,
    });
    db.pharmacyQuoteLine.findMany.mockResolvedValue([
      {
        quoteId: 'quote_dear',
        quote: supplier('supplier_a', 'Dear', true),
        pricePerPackMinor: 10_000,
        canonicalUnitsPerPack: 10,
        schemeBuyPacks: 0,
        schemeFreePacks: 0,
        discountBps: 0,
        moqPacks: 1,
        leadTimeDays: 3,
        minimumExpiryDays: 365,
      },
      {
        quoteId: 'quote_cheap_unauthorized',
        quote: supplier('supplier_b', 'Cheap but unauthorized', false),
        pricePerPackMinor: 1_000,
        canonicalUnitsPerPack: 10,
        schemeBuyPacks: 0,
        schemeFreePacks: 0,
        discountBps: 0,
        moqPacks: 1,
        leadTimeDays: 3,
        minimumExpiryDays: 365,
      },
    ]);

    const result = await caller().compareQuotes({ requisitionLineId: 'reqline_a' });
    expect(result.requiredPacks).toBe(10);
    expect(result.ranking.map((row) => row.quoteId)).toEqual([
      'quote_dear',
      'quote_cheap_unauthorized',
    ]);
    expect(result.ranking[1]!.comparable).toBe(false);
    expect(result.ranking[1]!.reasons).toContainEqual(
      'Supplier is not authorized to supply this pharmacy.'
    );
  });

  it('costs a stored order so bonus packs lower the unit cost without adding revenue', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      freightMinor: 0,
      otherChargesMinor: 0,
      lines: [
        {
          id: 'poline_a',
          medicineId: 'medicine_a',
          orderedPacks: 10,
          bonusPacks: 2,
          canonicalUnitsPerPack: 10,
          listPricePerPackMinor: 10_000,
          discountBps: 0,
          rebateBps: 0,
          taxBps: 0,
          taxCreditable: false,
        },
      ],
    });
    const costed = await caller().landedCost({ purchaseOrderId: 'po_a' });
    expect(costed.landedCostMinor).toBe(100_000);
    expect(costed.canonicalUnits).toBe(120);
    expect(costed.lines[0]!.landedCostPerCanonicalUnitMicroMinor).toBe(833_333_333);
    expect(costed.lines[0]!.purchaseOrderLineId).toBe('poline_a');
  });
});

describe('PUR-02 receiving / PUR-05 — drafting a goods receipt', () => {
  const RECEIVED_AT = new Date('2026-09-02T09:00:00.000Z');
  const EXPIRY = new Date('2027-06-01T00:00:00.000Z');

  const RECEIPT_LINE = {
    purchaseOrderLineId: 'poline_a',
    medicineId: 'medicine_a',
    packLevelId: 'pack_a',
    batchNumber: 'B-2291',
    printedExpiry: EXPIRY,
    expiryPrecision: 'DAY' as const,
    printedMrpMinor: 25_000,
    canonicalUnitsPerPack: 10,
    receivedPacks: 10,
    bonusPacks: 2,
    invoicedPricePerPackMinor: 10_000,
    stockLocationId: 'loc_store',
  };

  const RECEIPT = {
    reference: 'GRN-1',
    branchId: 'branch_a',
    supplierId: 'supplier_a',
    purchaseOrderId: 'po_a',
    supplierInvoiceRef: 'INV-8841',
    supplierInvoiceDate: RECEIVED_AT,
    warrantyEvidenceRef: 'WARRANTY-8841',
    receivedAt: RECEIVED_AT,
    lines: [RECEIPT_LINE],
  };

  /** The same receipt with the purchase order stripped: the PUR-05 shape. */
  function withoutOrder() {
    const { purchaseOrderId, ...rest } = RECEIPT;
    void purchaseOrderId;
    return { ...rest, lines: [{ ...RECEIPT_LINE, purchaseOrderLineId: undefined }] };
  }

  /** A resolvable purchase order whose one line the receipt may name. */
  function resolvableOrder() {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({ id: 'po_a', supplierId: 'supplier_a' });
    db.pharmacyPurchaseOrderLine.findMany.mockResolvedValue([{ id: 'poline_a' }]);
  }

  beforeEach(() => {
    orderableSupplier();
    resolvableCatalog();
    resolvableOrder();
  });

  it('derives canonical units and the landed unit cost instead of trusting the payload', async () => {
    await caller().createGoodsReceipt(RECEIPT);
    const line = db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data.lines.create[0];
    // 10 paid packs + 2 free at 10 units each, and 100_000 minor over 120 units.
    expect(line).toMatchObject({
      receivedCanonicalUnits: 100,
      bonusCanonicalUnits: 20,
      acceptedCanonicalUnits: 120,
      rejectedCanonicalUnits: 0,
      unitCostMinor: 833,
    });
    // The tenant and branch are not repeated on the nested line: they travel in
    // the composite key of the header.
    expect(line).not.toHaveProperty('organizationId');
  });

  it('takes the receiver from the session, never from the payload', async () => {
    await caller('user_counter').createGoodsReceipt(RECEIPT);
    expect(db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data).toMatchObject({
      organizationId: 'org_a',
      branchId: 'branch_a',
      receivedByUserId: 'user_counter',
      directPurchase: false,
      bypassReason: null,
    });
  });

  it('refuses a receipt that names both a purchase order and a bypass', async () => {
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        directPurchase: { reason: 'Emergency.', approvedByUserId: 'user_manager' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses a receipt that names neither a purchase order nor a bypass', async () => {
    await expect(caller().createGoodsReceipt(withoutOrder())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('records a direct purchase with its bypass reason and approver (PUR-05)', async () => {
    await caller('user_counter').createGoodsReceipt({
      ...withoutOrder(),
      directPurchase: { reason: 'Emergency insulin.', approvedByUserId: 'user_manager' },
    });
    expect(db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data).toMatchObject({
      purchaseOrderId: null,
      directPurchase: true,
      bypassReason: 'Emergency insulin.',
      bypassApprovedByUserId: 'user_manager',
    });
  });

  it('refuses a bypass the receiver approved for themselves', async () => {
    await expect(
      caller('user_counter').createGoodsReceipt({
        ...withoutOrder(),
        directPurchase: { reason: 'Emergency insulin.', approvedByUserId: 'user_counter' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses a receipt from a supplier whose licence has lapsed', async () => {
    db.pharmacySupplier.findFirst.mockResolvedValue({
      id: 'supplier_a',
      authorized: true,
      licences: [{ expiresAt: PAST, verifiedAt: PAST }],
    });
    await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses a cross-tenant medicine on a receipt line', async () => {
    db.medicine.findFirst.mockResolvedValue(null);
    await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses an ordered line borrowed from another purchase order', async () => {
    // Matching the goods against a line they were never ordered on would make
    // the PUR-04 three-way match compare two unrelated things.
    db.pharmacyPurchaseOrderLine.findMany.mockResolvedValue([{ id: 'poline_other' }]);
    await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses rejected units with no quarantine destination or reason (PUR-04)', async () => {
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [{ ...RECEIPT_LINE, rejectedCanonicalUnits: 20 }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('splits accepted and rejected units without losing one', async () => {
    await caller().createGoodsReceipt({
      ...RECEIPT,
      lines: [
        {
          ...RECEIPT_LINE,
          rejectedCanonicalUnits: 20,
          rejectionReason: 'Crushed blisters',
          quarantineLocationId: 'loc_quarantine',
        },
      ],
    });
    expect(db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data.lines.create[0]).toMatchObject({
      acceptedCanonicalUnits: 100,
      rejectedCanonicalUnits: 20,
      quarantineLocationId: 'loc_quarantine',
      rejectionReason: 'Crushed blisters',
    });
  });

  it('refuses to resolve an exception with a blank note', async () => {
    await expect(
      caller().resolveReceivingException({
        branchId: 'branch_a',
        receivingExceptionId: 'rex_a',
        resolutionNote: '   ',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyReceivingException.update).not.toHaveBeenCalled();
  });

  it('reads the open exception queue for the session tenant and branch', async () => {
    await caller().receivingExceptions({ branchId: 'branch_a' });
    expect(db.pharmacyReceivingException.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_a',
          branchId: 'branch_a',
          status: 'OPEN',
        }),
      })
    );
  });
});
