import { hashSync } from 'bcryptjs';
const APPROVER_HASH = hashSync('1234', 4);
import { beforeEach, describe, expect, it, vi } from 'vitest';
import superjson from 'superjson';

const mocks = vi.hoisted(() => {
  const hasModule = vi.fn<(view: { enabledModules: string[] }, key: string) => boolean>();
  hasModule.mockReturnValue(true);
  return { hasModule, can: vi.fn() };
});
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withTenantDb: vi.fn(async (_org: string, run: (tx: unknown) => unknown) => run(db)),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
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
    findUnique: vi.fn().mockResolvedValue(null),
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
    pharmacyPurchaseReturn: model(),
    pharmacyDebitNote: model(),
    pharmacySupplierCredit: model(),
    pharmacyBranch: model(),
    pharmacyBranchAssignment: model(),
    pharmacyCentralPurchasingAccess: model(),
    user: { ...model(), count: vi.fn().mockResolvedValue(1) },
    restaurantOperatorCredential: model(),
    restaurantStaffProfile: model(),
    auditLog: model(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    medicineBarcode: model(),
    pharmacyStockLocation: model(),
  };
  return Object.assign(db, {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'po_a' }]),
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
    session: {
      expires: 'later',
      user: { id: userId, role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_a' },
    },
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

const RETURN_LINE = {
  inventoryLotId: 'lot_a',
  stockLocationId: 'location_a',
  quantityUnits: 1,
  reason: 'Damaged pack',
  returnWindowEndsAt: FUTURE,
  expectedCreditMinor: 100,
};

beforeEach(async () => {
  db = makeDb();
  const abac = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  mocks.can
    .mockReset()
    .mockImplementation((subject, action, resource, options) =>
      abac.can(abac.subjectFromSession(subject), action, resource, options)
    );
  db.user.findUnique.mockResolvedValue({
    status: 'ACTIVE',
    organizationRole: {
      permissions: [
        'pharmacy:procurement',
        'pharmacy:procurement-approve',
        'reports:financial',
      ].map((capability) => ({ capability, effect: 'ALLOW' })),
    },
    permissionOverrides: [],
  });
  db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch_a' }]);
  db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch_a' });
  // #979, PR J: the caller is assigned to the branch it names.
  db.pharmacyBranchAssignment.findFirst.mockImplementation(async ({ where }) =>
    where.branchId === 'branch_a' ? { id: 'assignment_a' } : null
  );
  // Most fixtures use organization-wide (branchless) orders; the default buyer is
  // an organization-wide central purchaser. Branch-only buyers are tested below.
  db.pharmacyCentralPurchasingAccess.findMany.mockResolvedValue([{ branchId: null }]);
  db.pharmacyStockLocation.findFirst.mockResolvedValue({ branchId: 'branch_a' });
  mocks.hasModule.mockImplementation((view, key) => view.enabledModules.includes(key));
});

describe('procurement write authorization', () => {
  it.each([
    {
      procedure: 'createSupplier',
      act: () => caller('counter_user').createSupplier({ name: 'Unapproved supplier' }),
    },
    {
      procedure: 'recordSupplierLicence',
      act: () =>
        caller('counter_user').recordSupplierLicence({
          supplierId: 'supplier_a',
          licenceType: 'wholesale',
          licenceNumber: 'LIC-1',
          issuingAuthority: 'Regulator',
          issuedAt: PAST,
          expiresAt: FUTURE,
          verified: true,
        }),
    },
    {
      procedure: 'setSupplierAuthorization',
      act: () =>
        caller('counter_user').setSupplierAuthorization({
          supplierId: 'supplier_a',
          authorized: true,
        }),
    },
    {
      procedure: 'createRequisition',
      act: () =>
        caller('counter_user').createRequisition({
          reference: 'REQ-NO-PERMISSION',
          lines: [
            {
              medicineId: 'medicine_a',
              packLevelId: 'pack_a',
              quantityPacks: 1,
              canonicalUnitsPerPack: 10,
            },
          ],
        }),
    },
    {
      procedure: 'submitRequisition',
      act: () => caller('counter_user').submitRequisition({ requisitionId: 'req_a' }),
    },
    {
      procedure: 'recordQuote',
      act: () =>
        caller('counter_user').recordQuote({
          requisitionId: 'req_a',
          supplierId: 'supplier_a',
          quotedAt: PAST,
          validUntil: FUTURE,
          lines: [
            {
              requisitionLineId: 'req_line_a',
              pricePerPackMinor: 100,
              forecastSellThroughPacks: 8,
              canonicalUnitsPerPack: 10,
            },
          ],
        }),
    },
    {
      procedure: 'createPurchaseOrder',
      act: () =>
        caller('counter_user').createPurchaseOrder({
          reference: 'PO-NO-PERMISSION',
          supplierId: 'supplier_a',
          lines: [ORDER_LINE],
        }),
    },
    {
      procedure: 'submitPurchaseOrder',
      act: () => caller('counter_user').submitPurchaseOrder({ purchaseOrderId: 'po_a' }),
    },
    {
      procedure: 'approvePurchaseOrder',
      act: () =>
        caller('counter_user').approvePurchaseOrder({
          purchaseOrderId: 'po_a',
          decision: 'APPROVED',
        }),
    },
    {
      procedure: 'sendPurchaseOrder',
      act: () => caller('counter_user').sendPurchaseOrder({ purchaseOrderId: 'po_a' }),
    },
    {
      procedure: 'createGoodsReceipt',
      act: () =>
        caller('counter_user').createGoodsReceipt({
          reference: 'GRN-1',
          branchId: 'branch_a',
          supplierId: 'supplier_a',
          supplierInvoiceRef: 'INV-1',
          supplierInvoiceDate: PAST,
          warrantyEvidenceRef: 'evidence-1',
          receivedAt: PAST,
          directPurchase: { reason: 'Urgent', approvedByUserId: 'approver_a', pin: '1234' },
          lines: [
            {
              medicineId: 'medicine_a',
              packLevelId: 'pack_a',
              batchNumber: 'batch-a',
              printedExpiry: FUTURE,
              expiryPrecision: 'DAY',
              printedMrpMinor: 100,
              canonicalUnitsPerPack: 10,
              receivedPacks: 1,
              invoicedPricePerPackMinor: 80,
              stockLocationId: 'location_a',
            },
          ],
        }),
    },
    {
      procedure: 'postGoodsReceipt',
      act: () =>
        caller('counter_user').postGoodsReceipt({
          branchId: 'branch_a',
          goodsReceiptId: 'receipt_a',
        }),
    },
    {
      procedure: 'reverseGoodsReceipt',
      act: () =>
        caller('counter_user').reverseGoodsReceipt({
          branchId: 'branch_a',
          goodsReceiptId: 'receipt_a',
          reason: 'Correction',
        }),
    },
    {
      procedure: 'resolveReceivingException',
      act: () =>
        caller('counter_user').resolveReceivingException({
          branchId: 'branch_a',
          receivingExceptionId: 'exception_a',
          resolutionNote: 'Reviewed',
        }),
    },
    {
      procedure: 'createPurchaseReturn',
      act: () =>
        caller('counter_user').createPurchaseReturn({
          branchId: 'branch_a',
          supplierId: 'supplier_a',
          kind: 'PURCHASE_RETURN',
          reference: 'RETURN-1',
          lines: [RETURN_LINE],
        }),
    },
    {
      procedure: 'submitPurchaseReturn',
      act: () =>
        caller('counter_user').submitPurchaseReturn({
          branchId: 'branch_a',
          purchaseReturnId: 'return_a',
        }),
    },
    {
      procedure: 'dispatchPurchaseReturn',
      act: () =>
        caller('counter_user').dispatchPurchaseReturn({
          branchId: 'branch_a',
          purchaseReturnId: 'return_a',
          idempotencyKey: 'dispatch-1',
        }),
    },
    {
      procedure: 'issueDebitNote',
      act: () =>
        caller('counter_user').issueDebitNote({
          branchId: 'branch_a',
          purchaseReturnId: 'return_a',
          reference: 'DN-1',
        }),
    },
    {
      procedure: 'recordSupplierCredit',
      act: () =>
        caller('counter_user').recordSupplierCredit({
          branchId: 'branch_a',
          supplierId: 'supplier_a',
          reference: 'CREDIT-1',
          amountMinor: 100,
          receivedAt: PAST,
        }),
    },
    {
      procedure: 'allocateSupplierCredit',
      act: () =>
        caller('counter_user').allocateSupplierCredit({
          branchId: 'branch_a',
          supplierCreditId: 'credit_a',
          debitNoteId: 'debit_a',
          amountMinor: 100,
        }),
    },
    {
      procedure: 'authenticatePack',
      act: () => caller('counter_user').authenticatePack({ branchId: 'branch_a', payload: 'scan' }),
    },
    {
      procedure: 'createCentralPurchaseOrder',
      act: () =>
        caller('counter_user').createCentralPurchaseOrder({
          reference: 'CENTRAL-PO-1',
          supplierId: 'supplier_a',
          receivingBranchId: 'branch_a',
          lines: [ORDER_LINE],
        }),
    },
    {
      procedure: 'allocateCentralReceipt',
      act: () =>
        caller('counter_user').allocateCentralReceipt({
          goodsReceiptId: 'receipt_a',
          allocations: [
            {
              goodsReceiptLineId: 'receipt_line_a',
              destinationBranchId: 'branch_a',
              destinationStockLocationId: 'location_a',
              quantityUnits: 1,
            },
          ],
        }),
    },
  ])(
    'denies $procedure to a same-tenant member with only an unrelated capability',
    async ({ act }) => {
      db.user.findUnique.mockResolvedValue({
        organizationRole: {
          permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      });

      await expect(act()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'You do not have permission for this action.',
      });
      expect(db.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'counter_user' }) })
      );
      expect(db.pharmacySupplier.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacySupplier.create).not.toHaveBeenCalled();
      expect(db.pharmacySupplier.update).not.toHaveBeenCalled();
      expect(db.medicine.findFirst).not.toHaveBeenCalled();
      expect(db.packLevel.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyPurchaseOrder.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyPurchaseOrder.create).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
      db.user.findUnique.mockResolvedValue({
        organizationRole: {
          permissions: [{ capability: 'pharmacy:receiving-view', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      });
      await expect(act()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.pharmacySupplier.create).not.toHaveBeenCalled();
    }
  );

  it.each([
    () => caller('deleted_user').createSupplier({ name: 'Unapproved supplier' }),
    () =>
      caller('deleted_user').setSupplierAuthorization({
        supplierId: 'supplier_a',
        authorized: true,
      }),
    () =>
      caller('deleted_user').createPurchaseOrder({
        reference: 'PO-DELETED-ACTOR',
        supplierId: 'supplier_a',
        lines: [ORDER_LINE],
      }),
    () =>
      caller('deleted_user').approvePurchaseOrder({
        purchaseOrderId: 'po_a',
        decision: 'APPROVED',
      }),
  ])('fails closed when the session actor no longer exists', async (act) => {
    db.user.findUnique.mockResolvedValue(null);

    await expect(act()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(db.pharmacySupplier.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacySupplier.create).not.toHaveBeenCalled();
    expect(db.pharmacySupplier.update).not.toHaveBeenCalled();
    expect(db.medicine.findFirst).not.toHaveBeenCalled();
    expect(db.packLevel.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyPurchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyPurchaseOrder.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed before a database lookup when the session actor id is missing', async () => {
    await expect(caller('').createSupplier({ name: 'Unapproved supplier' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.pharmacySupplier.create).not.toHaveBeenCalled();
  });

  it.each([
    () => caller('inactive_user').createSupplier({ name: 'Unapproved supplier' }),
    () =>
      caller('inactive_user').setSupplierAuthorization({
        supplierId: 'supplier_a',
        authorized: true,
      }),
    () =>
      caller('inactive_user').createPurchaseOrder({
        reference: 'PO-INACTIVE-ACTOR',
        supplierId: 'supplier_a',
        lines: [ORDER_LINE],
      }),
    () =>
      caller('inactive_user').approvePurchaseOrder({
        purchaseOrderId: 'po_a',
        decision: 'APPROVED',
      }),
  ])('fails closed when the session actor is no longer active', async (act) => {
    db.user.findUnique.mockResolvedValue(null);

    await expect(act()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'inactive_user' }) })
    );
    expect(db.pharmacySupplier.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacySupplier.create).not.toHaveBeenCalled();
    expect(db.pharmacySupplier.update).not.toHaveBeenCalled();
    expect(db.medicine.findFirst).not.toHaveBeenCalled();
    expect(db.packLevel.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyPurchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyPurchaseOrder.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe.each(['purchaseReturns', 'supplierCredits'] as const)(
  '%s live read contract',
  (endpoint) => {
    const source = () =>
      endpoint === 'purchaseReturns' ? db.pharmacyPurchaseReturn : db.pharmacySupplierCredit;
    const dateBasis = endpoint === 'purchaseReturns' ? 'createdAt' : 'receivedAt';
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-09-03T23:59:59.999Z');

    it('returns the real bounded envelope with serializable metadata and source predicates', async () => {
      source().findMany.mockResolvedValue(
        ['b', 'a'].map((id) => ({
          id,
          createdAt: from,
          receivedAt: from,
          lines: [],
          debitNotes: [],
          allocations: [],
        }))
      );
      const result = await caller()[endpoint]({
        branchId: 'branch_a',
        from,
        to,
        page: { limit: 1 },
      });
      expect(source().findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org_a',
            branchId: 'branch_a',
            [dateBasis]: { gte: from, lte: to },
          },
          orderBy: [{ [dateBasis]: 'desc' }, { id: 'desc' }],
          take: 2,
        })
      );
      expect(result).toMatchObject({
        rows: [{ id: 'b' }],
        coverage: 'partial',
        truncated: true,
        nextCursor: { at: from, id: 'b' },
        cap: { limit: 1, max: 100 },
        snapshot: 'live',
      });
      expect(
        superjson.deserialize(JSON.parse(JSON.stringify(superjson.serialize(result))))
      ).toEqual(result);
      expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
        where: { organizationId: 'org_a', id: 'branch_a', active: true },
        select: { id: true },
      });
      expect(mocks.can).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user_a' }),
        'reports:financial',
        undefined,
        expect.objectContaining({ db, source: 'TRPC' })
      );
      expect(mocks.can.mock.invocationCallOrder[0]).toBeLessThan(
        db.pharmacyBranch.findFirst.mock.invocationCallOrder[0]!
      );
      expect(db.pharmacyBranch.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
        source().findMany.mock.invocationCallOrder[0]!
      );
    });

    it('preserves legacy unpaginated array calls', async () => {
      const result = await caller()[endpoint]({ branchId: 'branch_a' });
      expect(result).toEqual([]);
      expect(result.map((row) => row.id)).toEqual([]);
      expect(source().findMany.mock.lastCall![0]).not.toHaveProperty('take');
    });

    it.each(['permission', 'branch', 'module', 'actor', 'inactive'])(
      'denies %s before source reads for both modes',
      async (reason) => {
        if (reason === 'permission') mocks.can.mockResolvedValue(false);
        if (reason === 'branch') db.pharmacyBranch.findFirst.mockResolvedValue(null);
        if (reason === 'inactive') db.user.findUnique.mockResolvedValue(null);
        const reader = caller(
          reason === 'actor' ? '' : 'user_a',
          reason === 'module' ? [] : ['pharmacy-procurement']
        );
        for (const page of [undefined, { limit: 5 }]) {
          await expect(reader[endpoint]({ branchId: 'branch_a', page })).rejects.toMatchObject({
            // Empty session.user.id is refused in assertCapabilities before any DB lookup.
            code: 'FORBIDDEN',
          });
        }
        expect(source().findMany).not.toHaveBeenCalled();
        if (reason !== 'branch') expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
      }
    );

    it('allows assigned Finance readers without a purchasing grant', async () => {
      db.user.findUnique.mockResolvedValue({
        id: 'user_a',
        organizationRole: { permissions: [{ capability: 'reports:financial', effect: 'ALLOW' }] },
        permissionOverrides: [],
      });
      await expect(caller()[endpoint]({ branchId: 'branch_a' })).resolves.toEqual([]);
      expect(source().findMany).toHaveBeenCalled();
    });

    it('rechecks deactivation and assignment removal on a reused financial caller', async () => {
      const reader = caller();
      await reader[endpoint]({ branchId: 'branch_a' });
      source().findMany.mockClear();
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
      db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
      await expect(reader[endpoint]({ branchId: 'branch_a' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch_a' }]);
      db.user.findUnique.mockResolvedValue(null);
      await expect(reader[endpoint]({ branchId: 'branch_a' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(source().findMany).not.toHaveBeenCalled();
    });

    it.each([
      { organizationId: 'org_other' },
      { branchId: '' },
      { from: to, to: from },
      { from: new Date('invalid') },
      { page: { limit: 101 } },
      { page: { after: { at: from, id: '' } } },
      { asOf: from },
    ])(
      'rejects malformed, injected or historical inputs before financial reads: %j',
      async (input) => {
        await expect(
          caller()[endpoint]({ branchId: 'branch_a', ...input } as never)
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(source().findMany).not.toHaveBeenCalled();
        expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
      }
    );
  }
);

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

describe('PUR-02 order-line comparison assumptions', () => {
  it('copies forecast, shelf life and lead time from the stored quote line, not the client', async () => {
    resolvableCatalog();
    orderableSupplier();
    db.pharmacyRequisition.findFirst.mockResolvedValue({ id: 'req_a' });
    db.pharmacyQuote.findFirst.mockResolvedValue({ id: 'quote_a', supplierId: 'supplier_a' });
    db.pharmacyQuoteLine.findMany.mockResolvedValue([
      {
        forecastSellThroughPacks: 8,
        minimumExpiryDays: 180,
        leadTimeDays: 4,
        requisitionLine: { medicineId: 'medicine_a' },
      },
    ]);
    await caller().createPurchaseOrder({
      reference: 'PO-1',
      supplierId: 'supplier_a',
      requisitionId: 'req_a',
      quoteId: 'quote_a',
      lines: [
        { ...ORDER_LINE, forecastSellThroughPacks: 999, minimumExpiryDays: 9999, leadTimeDays: 0 },
      ],
    });
    expect(db.pharmacyQuoteLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { quoteId: 'quote_a', requisitionLine: { requisitionId: 'req_a' } },
      })
    );
    const { data } = db.pharmacyPurchaseOrder.create.mock.calls[0]![0];
    expect(data.lines.create[0]).toMatchObject({
      forecastSellThroughPacks: 8,
      minimumExpiryDays: 180,
      leadTimeDays: 4,
    });
  });

  it('drops client-sent assumptions when the order is not raised from a quote', async () => {
    resolvableCatalog();
    orderableSupplier();
    await caller().createPurchaseOrder({
      reference: 'PO-1',
      supplierId: 'supplier_a',
      lines: [{ ...ORDER_LINE, forecastSellThroughPacks: 999, minimumExpiryDays: 30 }],
    });
    expect(db.pharmacyQuoteLine.findMany).not.toHaveBeenCalled();
    const { data } = db.pharmacyPurchaseOrder.create.mock.calls[0]![0];
    expect(data.lines.create[0].forecastSellThroughPacks).toBeUndefined();
    expect(data.lines.create[0].minimumExpiryDays).toBeUndefined();
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

  it('does not record an event when another decision wins the conditional update', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      status: 'SUBMITTED',
      supplierId: 'supplier_a',
      createdByUserId: 'user_a',
      requisition: null,
    });
    db.pharmacyPurchaseOrder.update.mockRejectedValue(
      Object.assign(new Error('Record to update not found.'), { code: 'P2025' })
    );

    await expect(
      caller('user_c').approvePurchaseOrder({ purchaseOrderId: 'po_a', decision: 'APPROVED' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Purchase order has already been reviewed.',
    });
    expect(db.pharmacyPurchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'po_a', status: 'SUBMITTED' } })
    );
    expect(db.pharmacyPurchaseOrderApproval.create).not.toHaveBeenCalled();
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

  it('rejects oversized requisitions before catalog lookups', async () => {
    await expect(
      caller().createRequisition({
        reference: 'REQ-OVERSIZED',
        lines: Array.from({ length: 101 }, () => ({
          medicineId: 'medicine_a',
          packLevelId: 'pack_a',
          quantityPacks: 1,
          canonicalUnitsPerPack: 1,
        })),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.medicine.findFirst).not.toHaveBeenCalled();
    expect(db.packLevel.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyRequisition.create).not.toHaveBeenCalled();
  });

  it('accepts requisitions and IDs at their limits', async () => {
    const medicineId = 'm'.repeat(200);
    resolvableCatalog();
    // #979: the caller is assigned to the branch it names, even at the ID limit.
    db.pharmacyBranchAssignment.findFirst.mockImplementation(async ({ where }) =>
      where.branchId === 'b'.repeat(200) ? { id: 'assignment_limit' } : null
    );
    await expect(
      caller().createRequisition({
        reference: 'REQ-AT-LIMIT',
        branchId: 'b'.repeat(200),
        lines: Array.from({ length: 100 }, () => ({
          medicineId,
          packLevelId: 'p'.repeat(200),
          quantityPacks: 1,
          canonicalUnitsPerPack: 1,
        })),
      })
    ).resolves.toMatchObject({ id: 'new' });
    expect(db.medicine.findFirst).toHaveBeenCalledWith({
      where: { id: medicineId, saleable: true },
    });
    expect(db.packLevel.findFirst).toHaveBeenCalledTimes(100);
    expect(db.pharmacyRequisition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        branchId: 'b'.repeat(200),
        lines: {
          create: Array.from({ length: 100 }, (_, index) => ({
            medicineId,
            packLevelId: 'p'.repeat(200),
            quantityPacks: 1,
            canonicalUnitsPerPack: 1,
            canonicalUnits: 1,
            lineNumber: index + 1,
          })),
        },
      }),
      include: { lines: true },
    });
  });

  it('rejects oversized requisition IDs before catalog lookups', async () => {
    const oversizedId = 'x'.repeat(201);
    const line = {
      medicineId: 'medicine_a',
      packLevelId: 'pack_a',
      quantityPacks: 1,
      canonicalUnitsPerPack: 1,
    };

    await expect(
      caller().createRequisition({ reference: 'REQ-BRANCH', branchId: oversizedId, lines: [line] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().createRequisition({
        reference: 'REQ-MEDICINE',
        lines: [{ ...line, medicineId: oversizedId }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().createRequisition({
        reference: 'REQ-PACK',
        lines: [{ ...line, packLevelId: oversizedId }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(db.medicine.findFirst).not.toHaveBeenCalled();
    expect(db.packLevel.findFirst).not.toHaveBeenCalled();
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
            forecastSellThroughPacks: 10,
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

  /** GS1 AI(21) names one pack: a serialized line is always exactly one pack. */
  const SERIAL_LINE = { ...RECEIPT_LINE, receivedPacks: 1, bonusPacks: 0 };

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
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      supplierId: 'supplier_a',
      branchId: 'branch_a',
      status: 'SENT',
    });
    db.pharmacyPurchaseOrderLine.findMany.mockResolvedValue([
      { id: 'poline_a', medicineId: 'medicine_a', packLevelId: 'pack_a' },
    ]);
  }

  beforeEach(() => {
    orderableSupplier();
    resolvableCatalog();
    resolvableOrder();
    db.user.findUnique.mockResolvedValue({
      organizationRole: {
        permissions: [
          { capability: 'pharmacy:procurement', effect: 'ALLOW' },
          { capability: 'pharmacy:procurement-approve', effect: 'ALLOW' },
        ],
      },
      permissionOverrides: [],
    });
    db.medicineBarcode.findFirst.mockResolvedValue({
      presentation: { medicineId: 'medicine_a' },
    });
  });

  const CASHIER = {
    organizationRole: {
      permissions: [
        { capability: 'pharmacy.counter', effect: 'ALLOW' },
        { capability: 'pharmacy:orders', effect: 'ALLOW' },
      ],
    },
    permissionOverrides: [],
  };

  it('refuses to draft a receipt at an unassigned branch', async () => {
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'other_branch' }]);
    await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses an assigned receipt that references an unassigned order branch', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      supplierId: 'supplier_a',
      branchId: 'branch_b',
    });
    await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it.each([
    ['branch_a', 'allow'],
    ['branch_b', 'refuse'],
    [null, 'allow'],
  ] as const)(
    'aligns goods-receipt order fixture with branch boundary (stored order branch %s → %s)',
    async (orderBranch, outcome) => {
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment' });
      db.pharmacyBranchAssignment.findMany.mockResolvedValue([
        { branchId: 'branch_a' },
        { branchId: 'branch_b' },
      ]);
      // lockReceivablePurchaseOrder requires SENT|RECEIVING and then refuses when a
      // non-null stored order branch ≠ the receipt branch (CROSS_BRANCH_REFERENCE).
      db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
        id: 'po_a',
        supplierId: 'supplier_a',
        branchId: orderBranch,
        status: 'SENT',
        requisitionId: null,
      });
      if (outcome === 'refuse') {
        await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'CROSS_BRANCH_REFERENCE',
        });
        expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
      } else {
        await caller().createGoodsReceipt(RECEIPT);
        expect(db.pharmacyPurchaseOrder.findFirst).toHaveBeenCalledWith({
          where: {
            id: 'po_a',
            organizationId: 'org_a',
            supplierId: 'supplier_a',
          },
        });
        expect(db.pharmacyGoodsReceipt.create).toHaveBeenCalled();
      }
    }
  );

  it('refuses an existing draft referencing an unassigned order before posting or witness side effects', async () => {
    db.pharmacyGoodsReceipt.findFirst.mockResolvedValue({
      purchaseOrder: { branchId: 'branch_b' },
    });
    await expect(
      caller().postGoodsReceipt({
        branchId: 'branch_a',
        goodsReceiptId: 'receipt',
        approvalPin: '1234',
        staffProfileId: 'staff_a',
        pin: '1234',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Supplied PINs change nothing: the branch refusal comes before the witness
    // PIN transaction and the posting transaction.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.pharmacyPurchaseOrder.update).not.toHaveBeenCalled();
    expect(db.pharmacyGoodsReceipt.update).not.toHaveBeenCalled();
  });

  it('lets a tenant admin without an organization role create a goods receipt (#375)', async () => {
    db.user.findUnique.mockResolvedValue({
      role: 'ADMIN',
      organizationRole: null,
      permissionOverrides: [],
    });
    await caller().createGoodsReceipt(RECEIPT);
    expect(db.pharmacyGoodsReceipt.create).toHaveBeenCalledOnce();
  });

  it.each(['pharmacy:procurement', 'pharmacy:*', '*'])(
    'keeps a %s DENY effective for a tenant admin without a role',
    async (capability) => {
      db.user.findUnique.mockResolvedValue({
        role: 'ADMIN',
        organizationRole: null,
        permissionOverrides: [{ capability, effect: 'DENY' }],
      });
      await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
    }
  );

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

  it('DEV-77: spreads receipt freight into the landed unit cost and records each share', async () => {
    await caller().createGoodsReceipt({ ...RECEIPT, freightMinor: 20_000 });
    const data = db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data;
    // (100_000 invoice + 20_000 freight) over 100 paid + 20 bonus units.
    expect(data.freightMinor).toBe(20_000);
    expect(data.lines.create[0]).toMatchObject({
      allocatedFreightMinor: 20_000,
      unitCostMinor: 1_000,
    });
  });

  it('DEV-77: a receipt without freight keeps its landed unit cost unchanged', async () => {
    await caller().createGoodsReceipt(RECEIPT);
    const data = db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data;
    expect(data.freightMinor).toBe(0);
    expect(data.lines.create[0]).toMatchObject({ allocatedFreightMinor: 0, unitCostMinor: 833 });
  });

  it('DEV-77: refuses negative freight before anything is drafted', async () => {
    await expect(
      caller().createGoodsReceipt({ ...RECEIPT, freightMinor: -1 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('locks the purchase order in the receipt transaction until the draft is created', async () => {
    await caller().createGoodsReceipt(RECEIPT);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // The order lock first; then DEV-753's owner policy read, share-locked in the same
    // transaction. The mocked row is not a policy row, so the checks stay enforced.
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    const lockSql = (db.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(lockSql).toContain('pharmacy_purchase_orders');
    expect(lockSql).toContain('FOR UPDATE');
    const policySql = (db.$queryRaw.mock.calls[1]![0] as { sql: string }).sql;
    expect(policySql).toContain('pharmacy_owner_policies');
    expect(policySql).toContain('FOR SHARE');
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyPurchaseOrder.findFirst.mock.invocationCallOrder[0]!
    );
    expect(db.pharmacyPurchaseOrder.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacySupplier.findFirst.mock.invocationCallOrder[0]!
    );
    expect(db.pharmacyPurchaseOrder.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyGoodsReceipt.create.mock.invocationCallOrder[0]!
    );
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
        directPurchase: { reason: 'Emergency.', approvedByUserId: 'user_manager', pin: '1234' },
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

  it('rejects an ID-only bypass before reading or writing receipt data', async () => {
    await expect(
      caller().createGoodsReceipt({
        ...withoutOrder(),
        directPurchase: { reason: 'Urgent', approvedByUserId: 'user_manager' },
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });
  it.each(['wrong-pin', 'locked', 'missing-credential', 'cashier', 'unassigned'] as const)(
    'refuses a direct approver with %s',
    async (mode) => {
      db.restaurantOperatorCredential.findFirst.mockResolvedValue(
        mode === 'missing-credential'
          ? null
          : {
              id: 'credential',
              credentialHash: APPROVER_HASH,
              failedAttempts: 0,
              lockedUntil: mode === 'locked' ? new Date(Date.now() + 60000) : null,
            }
      );
      const standard = {
        organizationRole: {
          permissions: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      };
      if (mode === 'cashier')
        db.user.findUnique.mockImplementation(async ({ where }) =>
          where.id === 'user_manager'
            ? {
                organizationRole: {
                  permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
                },
                permissionOverrides: [],
              }
            : standard
        );
      if (mode === 'unassigned')
        db.pharmacyBranchAssignment.findMany.mockImplementation(async ({ where }) =>
          where.userId === 'user_manager' ? [] : [{ branchId: 'branch_a' }]
        );
      const result = await caller().createGoodsReceipt({
        ...withoutOrder(),
        directPurchase: {
          reason: 'Urgent',
          approvedByUserId: 'user_manager',
          pin: mode === 'wrong-pin' ? '9999' : '1234',
        },
      });
      expect(result).toHaveProperty('blocked');
      expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
      // Another person's guesses are throttled separately; they never add strikes
      // to the approver's shared operator credential (which would lock them out
      // of unrelated workflows).
      if (mode === 'wrong-pin')
        expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
    }
  );
  it('bounds guesses at another approver PIN without locking their shared credential', async () => {
    db.restaurantOperatorCredential.findFirst.mockResolvedValue({
      id: 'credential',
      credentialHash: APPROVER_HASH,
      failedAttempts: 0,
      lockedUntil: null,
    });
    const attempt = (pin: string) =>
      caller().createGoodsReceipt({
        ...withoutOrder(),
        directPurchase: { reason: 'Urgent', approvedByUserId: 'user_throttled', pin },
      });
    for (let guess = 0; guess < 5; guess++) {
      expect(await attempt('9999')).toHaveProperty('blocked');
    }
    expect(db.restaurantOperatorCredential.findFirst).toHaveBeenCalledTimes(5);
    // The budget is spent: even the correct PIN is refused without being checked.
    expect(await attempt('1234')).toHaveProperty('blocked');
    expect(db.restaurantOperatorCredential.findFirst).toHaveBeenCalledTimes(5);
    expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });
  it('lets a solo owner authorize a direct purchase with PIN and preserves true receiver attribution', async () => {
    installedOwner();
    const result = await caller().createGoodsReceipt({
      ...withoutOrder(),
      directPurchase: { reason: 'Urgent', approvedByUserId: 'user_a', pin: '1234' },
    });
    expect(result).toMatchObject({
      receivedByUserId: 'user_a',
      bypassApprovedByUserId: 'user_a',
      directPurchase: true,
    });
    expect(db.$queryRaw).toHaveBeenCalledWith(expect.anything(), 'user_a');
    db.pharmacyGoodsReceipt.create.mockClear();
    db.user.count.mockResolvedValue(1);
    await expect(
      caller().createGoodsReceipt({
        ...withoutOrder(),
        directPurchase: { reason: 'Urgent', approvedByUserId: 'user_a', pin: '1234' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('records a direct purchase with its bypass reason and PIN-verified approver (PUR-05)', async () => {
    db.restaurantOperatorCredential.findFirst.mockResolvedValue({
      id: 'credential',
      credentialHash: APPROVER_HASH,
      failedAttempts: 0,
      lockedUntil: null,
    });
    await caller('user_counter').createGoodsReceipt({
      ...withoutOrder(),
      directPurchase: {
        reason: 'Emergency insulin.',
        approvedByUserId: 'user_manager',
        pin: '1234',
      },
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
        directPurchase: {
          reason: 'Emergency insulin.',
          approvedByUserId: 'user_counter',
          pin: '1234',
        },
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

  it('refuses a receipt for a different branch than its purchase order', async () => {
    db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch_b' });
    // The actor may receive at both branches; only the order/branch mismatch refuses.
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue({ id: 'assignment' });
    db.pharmacyBranchAssignment.findMany.mockResolvedValue([
      { branchId: 'branch_a' },
      { branchId: 'branch_b' },
    ]);
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      supplierId: 'supplier_a',
      branchId: 'branch_a',
      status: 'SENT',
    });

    await expect(
      caller().createGoodsReceipt({ ...RECEIPT, branchId: 'branch_b' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CROSS_BRANCH_REFERENCE' });
    expect(db.pharmacyPurchaseOrder.findFirst).toHaveBeenCalledWith({
      where: { id: 'po_a', organizationId: 'org_a', supplierId: 'supplier_a' },
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

  it('refuses a receipt against a purchase order that has not been sent', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      supplierId: 'supplier_a',
      branchId: 'branch_a',
      status: 'APPROVED',
    });
    await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'INVALID_TRANSITION',
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it.each(['SENT', 'RECEIVING'])(
    'drafts a branch receipt against a %s organization-wide order',
    async (status) => {
      db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
        id: 'po_a',
        supplierId: 'supplier_a',
        branchId: null,
        status,
      });

      await expect(caller().createGoodsReceipt(RECEIPT)).resolves.toBeDefined();
      expect(db.pharmacyGoodsReceipt.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ branchId: 'branch_a' }) })
      );
    }
  );

  it('allows another receipt while the purchase order is receiving', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      supplierId: 'supplier_a',
      branchId: 'branch_a',
      status: 'RECEIVING',
    });

    await expect(caller().createGoodsReceipt(RECEIPT)).resolves.toBeDefined();
    expect(db.pharmacyGoodsReceipt.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a receipt when the purchase order belongs to another supplier', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue(null);
    await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'CROSS_TENANT_REFERENCE',
    });
    expect(db.pharmacyPurchaseOrder.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'po_a',
        organizationId: 'org_a',
        supplierId: 'supplier_a',
      },
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it("refuses a receipt against another branch's purchase order", async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      supplierId: 'supplier_a',
      branchId: 'branch_b',
      status: 'SENT',
    });
    await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'CROSS_BRANCH_REFERENCE',
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses a medicine that does not match the referenced purchase order line', async () => {
    db.medicine.findFirst.mockResolvedValue({ id: 'medicine_b' });
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [{ ...RECEIPT_LINE, medicineId: 'medicine_b' }],
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'PURCHASE_ORDER_LINE_ITEM_MISMATCH',
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses a pack that does not match the referenced purchase order line', async () => {
    db.packLevel.findFirst.mockResolvedValue({ id: 'pack_b' });
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [{ ...RECEIPT_LINE, packLevelId: 'pack_b' }],
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'PURCHASE_ORDER_LINE_ITEM_MISMATCH',
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it.each([
    ['medicine', { medicineId: 'medicine_b' }],
    ['pack', { packLevelId: 'pack_b' }],
  ])('refuses a receipt whose later line has a mismatched %s', async (_, mismatch) => {
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [RECEIPT_LINE, { ...RECEIPT_LINE, ...mismatch }],
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'PURCHASE_ORDER_LINE_ITEM_MISMATCH',
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

  it('stores a scanned GTIN and serial without changing their case', async () => {
    await caller().createGoodsReceipt({
      ...RECEIPT,
      lines: [
        {
          ...SERIAL_LINE,
          gtin: '08961234567894',
          serialNumber: 'a3f09c1e77b2',
          gs1Warnings: ['SERIAL_FORMAT'],
        },
      ],
    });
    expect(db.pharmacyGoodsReceiptLine.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        gtin: '08961234567894',
        serialKey: 'A3F09C1E77B2',
      },
      select: { id: true },
    });
    expect(db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data.lines.create[0]).toMatchObject({
      gtin: '08961234567894',
      serialNumber: 'a3f09c1e77b2',
      serialKey: 'A3F09C1E77B2',
      gs1Warnings: ['SERIAL_FORMAT'],
    });
  });

  it('rejects a serial already stocked in for this organization', async () => {
    db.pharmacyGoodsReceiptLine.findFirst.mockResolvedValue({ id: 'line_old' });
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [{ ...SERIAL_LINE, gtin: '08961234567894', serialNumber: 'A3F09C1E77B2' }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'DUPLICATE_SERIAL' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('rejects the same serial twice on one receipt', async () => {
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [
          { ...SERIAL_LINE, gtin: '08961234567894', serialNumber: 'A3F09C1E77B2' },
          { ...SERIAL_LINE, gtin: '08961234567894', serialNumber: 'a3f09c1e77b2' },
        ],
      })
    ).rejects.toMatchObject({ message: 'DUPLICATE_SERIAL' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  // DEV-752: one serial is one pack. A photographed or scanned AI(21) serial
  // may never be multiplied into a same-lot count.
  it.each([
    ['received packs', { receivedPacks: 3, bonusPacks: 0 }],
    ['a bonus pack', { receivedPacks: 1, bonusPacks: 1 }],
  ])('refuses a serialized line counted as several packs via %s', async (_, quantity) => {
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [
          { ...RECEIPT_LINE, ...quantity, gtin: '08961234567894', serialNumber: 'A3F09C1E77B2' },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'SERIALIZED_PACK_QUANTITY' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses a scanned serial payload counted as several packs', async () => {
    db.medicineBarcode.findFirst.mockResolvedValue({ presentation: { medicineId: 'medicine_a' } });
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [
          {
            ...RECEIPT_LINE,
            receivedPacks: 6,
            gs1Payload: ']d201089612345678941727123110ABCD1234|21A3F09C1E77B2',
          },
        ],
      })
    ).rejects.toMatchObject({ message: 'SERIALIZED_PACK_QUANTITY' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  // DEV-92: a GS1-128 logistic label (AI 00 + 02 + 37) states its pack count.
  it('refuses a GS1-128 carton received as a different number of packs', async () => {
    db.medicineBarcode.findFirst.mockResolvedValue({ presentation: { medicineId: 'medicine_a' } });
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [
          {
            ...RECEIPT_LINE,
            receivedPacks: 6,
            bonusPacks: 0,
            gs1Payload: ']C100008961234000001233020896123456789417271231|10ABCD1234|3724',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'CARTON_PACK_COUNT' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('drafts a mixed-lot delivery as separate lines against one order line', async () => {
    await caller().createGoodsReceipt({
      ...RECEIPT,
      lines: [
        { ...RECEIPT_LINE, batchNumber: 'SYN-A1', receivedPacks: 6, bonusPacks: 0 },
        {
          ...RECEIPT_LINE,
          batchNumber: 'SYN-A2',
          printedExpiry: new Date('2028-07-31T00:00:00.000Z'),
          receivedPacks: 4,
          bonusPacks: 0,
        },
      ],
    });
    const created = db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data.lines.create;
    expect(created).toHaveLength(2);
    expect(
      created.map((line: { purchaseOrderLineId: string }) => line.purchaseOrderLineId)
    ).toEqual(['poline_a', 'poline_a']);
    expect(
      created.map((line: { receivedCanonicalUnits: number }) => line.receivedCanonicalUnits)
    ).toEqual([60, 40]);
  });

  it('checks the receiving shelf against the session tenant and branch at draft time', async () => {
    await caller().createGoodsReceipt(RECEIPT);
    expect(db.pharmacyStockLocation.findFirst).toHaveBeenCalledWith({
      where: { id: 'loc_store', organizationId: 'org_a' },
      select: { branchId: true },
    });
  });

  it.each([
    ['another branch', { branchId: 'branch_b' }, 'CROSS_BRANCH_REFERENCE'],
    ['another tenant', null, 'CROSS_TENANT_REFERENCE'],
  ])('refuses a receiving shelf of %s', async (_, location, reason) => {
    db.pharmacyStockLocation.findFirst.mockResolvedValue(location);
    await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: reason,
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses a quarantine shelf of another branch', async () => {
    db.pharmacyStockLocation.findFirst.mockImplementation(async ({ where }) =>
      where.id === 'loc_quarantine' ? { branchId: 'branch_b' } : { branchId: 'branch_a' }
    );
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [
          {
            ...RECEIPT_LINE,
            rejectedCanonicalUnits: 20,
            rejectionReason: 'Crushed blisters',
            quarantineLocationId: 'loc_quarantine',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CROSS_BRANCH_REFERENCE' });
  });

  it('refuses goods-in when the actor only holds the cashier grants', async () => {
    db.user.findUnique.mockResolvedValue(CASHIER);
    await expect(caller().createGoodsReceipt(RECEIPT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    await expect(
      caller().postGoodsReceipt({ branchId: 'branch_a', goodsReceiptId: 'gr_a' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    await expect(
      caller().reverseGoodsReceipt({
        branchId: 'branch_a',
        goodsReceiptId: 'gr_a',
        reason: 'Posted in error',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('stores the server parse of a scan and ignores a conflicting client serial', async () => {
    await caller().createGoodsReceipt({
      ...RECEIPT,
      receivedAt: new Date('2026-10-21T00:00:00.000Z'),
      lines: [
        {
          ...SERIAL_LINE,
          batchNumber: 'CLIENT-BATCH',
          printedExpiry: new Date('2028-01-01T00:00:00.000Z'),
          gtin: '08961234567894',
          serialNumber: 'FFFFFFFFFFFF',
          gs1Payload: ']d201089612345678941727123110ABCD1234|21A3F09C1E77B2',
        },
      ],
    });
    expect(db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data.lines.create[0]).toMatchObject({
      gtin: '08961234567894',
      serialNumber: 'A3F09C1E77B2',
      serialKey: 'A3F09C1E77B2',
      batchNumber: 'ABCD1234',
      printedExpiry: new Date('2027-12-31T00:00:00.000Z'),
      expiryPrecision: 'DAY',
    });
  });

  it('keeps an invoice correction for batch and expiry', async () => {
    await caller().createGoodsReceipt({
      ...RECEIPT,
      receivedAt: new Date('2026-10-21T00:00:00.000Z'),
      lines: [
        {
          ...SERIAL_LINE,
          batchNumber: 'INV-1',
          printedExpiry: new Date('2028-01-15T00:00:00.000Z'),
          expiryPrecision: 'DAY',
          invoiceCorrection: true,
          gs1Payload: ']d201089612345678941727123110ABCD1234|21A3F09C1E77B2',
        },
      ],
    });
    expect(db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data.lines.create[0]).toMatchObject({
      batchNumber: 'INV-1',
      printedExpiry: new Date('2028-01-15T00:00:00.000Z'),
      serialNumber: 'A3F09C1E77B2',
      gtin: '08961234567894',
    });
  });

  it('refuses a GTIN that is not this medicine', async () => {
    db.medicineBarcode.findFirst.mockResolvedValue({ presentation: { medicineId: 'medicine_b' } });
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [{ ...SERIAL_LINE, gtin: '08961234567894', serialNumber: 'A3F09C1E77B2' }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'GTIN_MEDICINE_MISMATCH' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses a GTIN whose check digit does not match', async () => {
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [{ ...RECEIPT_LINE, gtin: '08961234567895' }],
      })
    ).rejects.toMatchObject({ message: 'GS1_INVALID' });
    expect(db.pharmacyGoodsReceipt.create).not.toHaveBeenCalled();
  });

  it('refuses accepted units of an expired pack and warns on a near-expiry pack', async () => {
    const receivedAt = new Date('2026-10-21T00:00:00.000Z');
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        receivedAt,
        lines: [
          {
            ...SERIAL_LINE,
            gs1Payload: ']d201089612345678941725123110EXP-OLD-1|21B1B1B1B1B1B1',
          },
        ],
      })
    ).rejects.toMatchObject({ message: 'EXPIRED_PACK' });

    await caller().createGoodsReceipt({
      ...RECEIPT,
      receivedAt,
      lines: [
        {
          ...RECEIPT_LINE,
          receivedPacks: 1,
          bonusPacks: 0,
          gs1Payload: ']d201089612345678941726113010EXP-NEAR-1|21C2C2C2C2C2C2',
        },
      ],
    });
    expect(db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data.lines.create[0]).toMatchObject({
      acceptedCanonicalUnits: 10,
      gs1Warnings: expect.arrayContaining(['NEAR_EXPIRY']),
      printedExpiry: new Date('2026-11-30T00:00:00.000Z'),
    });
  });

  it('lets a fully rejected expired pack be drafted for quarantine', async () => {
    await caller().createGoodsReceipt({
      ...RECEIPT,
      receivedAt: new Date('2026-10-21T00:00:00.000Z'),
      lines: [
        {
          ...RECEIPT_LINE,
          receivedPacks: 1,
          bonusPacks: 0,
          printedExpiry: new Date('2025-12-31T00:00:00.000Z'),
          rejectedCanonicalUnits: 10,
          rejectionReason: 'Expired on the carton',
          quarantineLocationId: 'loc_quarantine',
        },
      ],
    });
    expect(db.pharmacyGoodsReceipt.create.mock.calls[0]![0].data.lines.create[0]).toMatchObject({
      acceptedCanonicalUnits: 0,
      rejectedCanonicalUnits: 10,
      gs1Warnings: [],
    });
  });

  it('maps a GTIN serial unique violation to the duplicate-serial conflict', async () => {
    db.pharmacyGoodsReceipt.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: 'pharmacy_grl_org_gtin_serial_key' },
      })
    );
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [{ ...SERIAL_LINE, gtin: '08961234567894', serialNumber: 'A3F09C1E77B2' }],
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DUPLICATE_SERIAL' });
  });

  it('refuses a serial that has no GTIN', async () => {
    await expect(
      caller().createGoodsReceipt({
        ...RECEIPT,
        lines: [{ ...SERIAL_LINE, serialNumber: 'A3F09C1E77B2' }],
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

describe('PUR-06 — the returns and settlement transport', () => {
  const RETURN_LINE = {
    inventoryLotId: 'lot_1',
    stockLocationId: 'loc_main',
    quantityUnits: 30,
    reason: 'Short-dated stock agreed for return',
    returnWindowEndsAt: FUTURE,
    expectedCreditMinor: 36_000,
  };

  it('licenses returns and settlement as pharmacy-procurement, like the rest of PUR', () => {
    expect(moduleForProcedure('pharmacyPurchasing.createPurchaseReturn')).toBe(
      'pharmacy-procurement'
    );
    expect(moduleForProcedure('pharmacyPurchasing.allocateSupplierCredit')).toBe(
      'pharmacy-procurement'
    );
  });

  it('rejects a cross-tenant supplier ID substitution when opening a return', async () => {
    // The tenant-scoped client returns null for another tenant's supplier, so
    // the refusal lands on tenancy before any line is written.
    db.pharmacySupplier.findFirst.mockResolvedValue(null);
    await expect(
      caller().createPurchaseReturn({
        branchId: 'branch_a',
        supplierId: 'supplier_from_org_b',
        kind: 'EXPIRY_CLAIM',
        reference: 'RET-1',
        lines: [RETURN_LINE],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });

  it('refuses a return with no lines, a blank reason or a non-positive quantity', async () => {
    const base = {
      branchId: 'branch_a',
      supplierId: 'supplier_a',
      kind: 'EXPIRY_CLAIM' as const,
      reference: 'RET-1',
    };
    for (const lines of [
      [],
      [{ ...RETURN_LINE, reason: '   ' }],
      [{ ...RETURN_LINE, quantityUnits: 0 }],
      [{ ...RETURN_LINE, quantityUnits: 10.5 }],
    ]) {
      await expect(caller().createPurchaseReturn({ ...base, lines })).rejects.toBeDefined();
    }
    expect(db.pharmacyPurchaseReturn.create).not.toHaveBeenCalled();
  });

  it('refuses a zero or negative supplier credit', async () => {
    for (const amountMinor of [0, -100]) {
      await expect(
        caller().recordSupplierCredit({
          branchId: 'branch_a',
          supplierId: 'supplier_a',
          reference: 'CN-1',
          amountMinor,
          receivedAt: PAST,
        })
      ).rejects.toBeDefined();
    }
    expect(db.pharmacySupplierCredit.create).not.toHaveBeenCalled();
  });

  it('reads the expected-vs-received positions for the session tenant and branch', async () => {
    db.pharmacyDebitNote.findMany.mockResolvedValue([]);
    await caller().debitNotePositions({ branchId: 'branch_a' });
    expect(db.pharmacyDebitNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org_a', branchId: 'branch_a' }),
      })
    );
  });
});

it('refuses receipt reversal without procurement permission before reading the receipt', async () => {
  db.user.findUnique.mockResolvedValue({
    organizationRole: { permissions: [] },
    permissionOverrides: [],
  });
  await expect(
    caller().reverseGoodsReceipt({
      branchId: 'branch_a',
      goodsReceiptId: 'receipt',
      reason: 'Wrong delivery',
    })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(db.pharmacyGoodsReceipt.findFirst).not.toHaveBeenCalled();
});

describe('#979 supplier, requisition and order writes need the procurement capability', () => {
  const gated = [
    ['createSupplier', () => caller().createSupplier({ name: 'Karachi Distributors' })],
    [
      'recordSupplierLicence',
      () =>
        caller().recordSupplierLicence({
          supplierId: 'supplier_a',
          licenceType: 'DSL',
          licenceNumber: 'DSL-1',
          issuingAuthority: 'DRAP',
          issuedAt: PAST,
          expiresAt: FUTURE,
        }),
    ],
    [
      'setSupplierAuthorization',
      () => caller().setSupplierAuthorization({ supplierId: 'supplier_a', authorized: true }),
    ],
    [
      'createRequisition',
      () =>
        caller().createRequisition({
          reference: 'REQ-1',
          lines: [
            {
              medicineId: 'medicine_a',
              packLevelId: 'pack_a',
              quantityPacks: 1,
              canonicalUnitsPerPack: 10,
            },
          ],
        }),
    ],
    ['submitRequisition', () => caller().submitRequisition({ requisitionId: 'req_a' })],
    [
      'recordQuote',
      () =>
        caller().recordQuote({
          requisitionId: 'req_a',
          supplierId: 'supplier_a',
          quotedAt: PAST,
          validUntil: FUTURE,
          lines: [
            {
              requisitionLineId: 'line_a',
              pricePerPackMinor: 100,
              forecastSellThroughPacks: 1,
              canonicalUnitsPerPack: 10,
            },
          ],
        }),
    ],
    [
      'createPurchaseOrder',
      () =>
        caller().createPurchaseOrder({
          reference: 'PO-1',
          supplierId: 'supplier_a',
          lines: [ORDER_LINE],
        }),
    ],
    ['submitPurchaseOrder', () => caller().submitPurchaseOrder({ purchaseOrderId: 'po_a' })],
    // approvePurchaseOrder and sendPurchaseOrder need `pharmacy:procurement-approve`
    // since PR J; see pharmacy-purchasing.authz.test.ts.
  ] as const;

  it.each(gated)('refuses %s to a cashier before any read or write', async (_name, call) => {
    mocks.can.mockImplementation(
      async (_subject: unknown, action: string) => action !== 'pharmacy:procurement'
    );
    orderableSupplier();
    resolvableCatalog();

    await expect(call()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_a' }),
      'pharmacy:procurement',
      undefined,
      expect.objectContaining({ db, source: 'TRPC' })
    );
    for (const delegate of [
      db.pharmacySupplier,
      db.pharmacySupplierLicence,
      db.pharmacyRequisition,
      db.pharmacyQuote,
      db.pharmacyPurchaseOrder,
      db.medicine,
    ]) {
      expect(delegate.findFirst).not.toHaveBeenCalled();
      expect(delegate.create).not.toHaveBeenCalled();
      expect(delegate.update).not.toHaveBeenCalled();
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('lets a procurement holder create a supplier', async () => {
    await expect(caller().createSupplier({ name: 'Karachi Distributors' })).resolves.toMatchObject({
      name: 'Karachi Distributors',
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:procurement',
      undefined,
      expect.anything()
    );
    expect(db.pharmacySupplier.create).toHaveBeenCalledOnce();
  });
});

describe('#979 returns, credits, exceptions and purchasing reads need the procurement capability', () => {
  const gated = [
    [
      'createPurchaseReturn',
      () =>
        caller().createPurchaseReturn({
          branchId: 'branch_a',
          supplierId: 'supplier_a',
          kind: 'PURCHASE_RETURN',
          reference: 'RET-1',
          lines: [
            {
              inventoryLotId: 'lot_a',
              stockLocationId: 'loc_a',
              quantityUnits: 1,
              reason: 'Damaged',
              returnWindowEndsAt: FUTURE,
              expectedCreditMinor: 100,
            },
          ],
        }),
    ],
    [
      'submitPurchaseReturn',
      () => caller().submitPurchaseReturn({ branchId: 'branch_a', purchaseReturnId: 'ret_a' }),
    ],
    [
      'dispatchPurchaseReturn',
      () =>
        caller().dispatchPurchaseReturn({
          branchId: 'branch_a',
          purchaseReturnId: 'ret_a',
          idempotencyKey: 'dispatch-1',
        }),
    ],
    [
      'issueDebitNote',
      () =>
        caller().issueDebitNote({
          branchId: 'branch_a',
          purchaseReturnId: 'ret_a',
          reference: 'DN-1',
        }),
    ],
    [
      'recordSupplierCredit',
      () =>
        caller().recordSupplierCredit({
          branchId: 'branch_a',
          supplierId: 'supplier_a',
          reference: 'CR-1',
          amountMinor: 100,
          receivedAt: PAST,
        }),
    ],
    [
      'allocateSupplierCredit',
      () =>
        caller().allocateSupplierCredit({
          branchId: 'branch_a',
          supplierCreditId: 'credit_a',
          debitNoteId: 'dn_a',
          amountMinor: 100,
        }),
    ],
    [
      'resolveReceivingException',
      () =>
        caller().resolveReceivingException({
          branchId: 'branch_a',
          receivingExceptionId: 'exc_a',
          resolutionNote: 'Checked',
        }),
    ],
    ['receivingExceptions', () => caller().receivingExceptions({ branchId: 'branch_a' })],
    ['debitNotePositions', () => caller().debitNotePositions({ branchId: 'branch_a' })],
    ['workspace', () => caller().workspace()],
    ['suppliers', () => caller().suppliers()],
    ['requisitions', () => caller().requisitions()],
    ['purchaseOrders', () => caller().purchaseOrders()],
    ['goodsReceipts', () => caller().goodsReceipts({ branchId: 'branch_a' })],
    ['returnableLots', () => caller().returnableLots({ branchId: 'branch_a' })],
    ['resolveScan', () => caller().resolveScan({ term: 'paracetamol' })],
  ] as const;

  it.each(gated)('refuses %s to a cashier before any read or write', async (_name, call) => {
    mocks.can.mockImplementation(
      async (_subject: unknown, action: string) => action !== 'pharmacy:procurement'
    );

    await expect(call()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_a' }),
      'pharmacy:procurement',
      undefined,
      expect.objectContaining({ db, source: 'TRPC' })
    );
    for (const delegate of [
      db.pharmacySupplier,
      db.pharmacyRequisition,
      db.pharmacyPurchaseOrder,
      db.pharmacyGoodsReceipt,
      db.pharmacyReceivingException,
      db.pharmacyPurchaseReturn,
      db.pharmacyDebitNote,
      db.pharmacySupplierCredit,
    ]) {
      expect(delegate.findFirst).not.toHaveBeenCalled();
      expect(delegate.findMany).not.toHaveBeenCalled();
      expect(delegate.create).not.toHaveBeenCalled();
      expect(delegate.update).not.toHaveBeenCalled();
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
const sensitiveReads = {
  compareQuotes: () => caller().compareQuotes({ requisitionLineId: 'line' }),
  landedCost: () => caller().landedCost({ purchaseOrderId: 'order' }),
  workspace: () => caller().workspace(),
  suppliers: () => caller().suppliers(),
  requisitions: () => caller().requisitions(),
  purchaseOrders: () => caller().purchaseOrders(),
  receivedAgainstOrder: () => caller().receivedAgainstOrder({ purchaseOrderId: 'order' }),
  goodsReceipts: () => caller().goodsReceipts({ branchId: 'branch_a' }),
  receivingExceptions: () => caller().receivingExceptions({ branchId: 'branch_a' }),
  receivingExceptionQueue: () => caller().receivingExceptionQueue({ branchId: 'branch_a' }),
  lotsFromReceipt: () =>
    caller().lotsFromReceipt({ branchId: 'branch_a', goodsReceiptId: 'receipt' }),
  returnableLots: () => caller().returnableLots({ branchId: 'branch_a' }),
  debitNotePositions: () => caller().debitNotePositions({ branchId: 'branch_a' }),
  resolveScan: () => caller().resolveScan({ term: 'medicine' }),
  centralDemand: () => caller().centralDemand({}),
};
describe.each(Object.keys(sensitiveReads) as (keyof typeof sensitiveReads)[])(
  '%s sensitive read security',
  (name) => {
    it.each(['cashier', 'deny', 'inactive'] as const)(
      'rejects %s before reading procurement data',
      async (mode) => {
        db.user.findUnique.mockResolvedValue(
          mode === 'inactive'
            ? null
            : {
                organizationRole: {
                  permissions: [
                    {
                      capability: mode === 'cashier' ? 'pharmacy.counter' : 'pharmacy:*',
                      effect: 'ALLOW',
                    },
                  ],
                },
                permissionOverrides:
                  mode === 'deny' ? [{ capability: 'pharmacy:procurement', effect: 'DENY' }] : [],
              }
        );
        await expect(sensitiveReads[name]()).rejects.toMatchObject({ code: 'FORBIDDEN' });
        for (const [key, delegate] of Object.entries(db)) {
          if (key === 'user' || typeof delegate === 'function') continue;
          expect(delegate.findFirst).not.toHaveBeenCalled();
          expect(delegate.findMany).not.toHaveBeenCalled();
        }
        expect(db.user.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ id: 'user_a' }) })
        );
      }
    );
  }
);

const branchActions = {
  postGoodsReceipt: () =>
    caller().postGoodsReceipt({ branchId: 'branch_a', goodsReceiptId: 'receipt' }),
  reverseGoodsReceipt: () =>
    caller().reverseGoodsReceipt({
      branchId: 'branch_a',
      goodsReceiptId: 'receipt',
      reason: 'Incorrect invoice',
    }),
  resolveReceivingException: () =>
    caller().resolveReceivingException({
      branchId: 'branch_a',
      receivingExceptionId: 'exception',
      resolutionNote: 'Invoice checked',
    }),
  createPurchaseReturn: () =>
    caller().createPurchaseReturn({
      branchId: 'branch_a',
      supplierId: 'supplier',
      kind: 'EXPIRY_CLAIM',
      reference: 'RET',
      lines: [RETURN_LINE],
    }),
  submitPurchaseReturn: () =>
    caller().submitPurchaseReturn({ branchId: 'branch_a', purchaseReturnId: 'return' }),
  dispatchPurchaseReturn: () =>
    caller().dispatchPurchaseReturn({
      branchId: 'branch_a',
      purchaseReturnId: 'return',
      idempotencyKey: 'dispatch',
    }),
  issueDebitNote: () =>
    caller().issueDebitNote({
      branchId: 'branch_a',
      purchaseReturnId: 'return',
      reference: 'DEBIT',
    }),
  recordSupplierCredit: () =>
    caller().recordSupplierCredit({
      branchId: 'branch_a',
      supplierId: 'supplier',
      reference: 'CREDIT',
      amountMinor: 100,
      receivedAt: PAST,
    }),
  allocateSupplierCredit: () =>
    caller().allocateSupplierCredit({
      branchId: 'branch_a',
      supplierCreditId: 'credit',
      debitNoteId: 'debit',
      amountMinor: 100,
    }),
  authenticatePack: () => caller().authenticatePack({ branchId: 'branch_a', payload: 'scan' }),
  goodsReceipts: sensitiveReads.goodsReceipts,
  receivingExceptions: sensitiveReads.receivingExceptions,
  receivingExceptionQueue: sensitiveReads.receivingExceptionQueue,
  lotsFromReceipt: sensitiveReads.lotsFromReceipt,
  returnableLots: sensitiveReads.returnableLots,
  debitNotePositions: sensitiveReads.debitNotePositions,
  purchaseReturns: () => caller().purchaseReturns({ branchId: 'branch_a' }),
  supplierCredits: () => caller().supplierCredits({ branchId: 'branch_a' }),
};
describe.each(Object.keys(branchActions) as (keyof typeof branchActions)[])(
  '%s branch security',
  (name) => {
    it.each(['unassigned', 'inactive-or-foreign'] as const)(
      'rejects %s branch before side effects',
      async (mode) => {
        if (mode === 'unassigned') {
          db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
          db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'other_branch' }]);
        } else db.pharmacyBranch.findFirst.mockResolvedValue(null);
        await expect(branchActions[name]()).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(db.$transaction).not.toHaveBeenCalled();
        for (const delegate of Object.values(db)) {
          if (typeof delegate !== 'function') {
            expect(delegate.create).not.toHaveBeenCalled();
            expect(delegate.update).not.toHaveBeenCalled();
          }
        }
        if (mode === 'unassigned')
          expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith({
            where: {
              organizationId: 'org_a',
              branchId: 'branch_a',
              userId: 'user_a',
              active: true,
            },
            select: { id: true },
          });
        if (mode !== 'unassigned')
          expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
            where: { id: 'branch_a', organizationId: 'org_a', active: true },
            select: { id: true },
          });
      }
    );
  }
);

describe('stored procurement branch boundaries', () => {
  beforeEach(() => {
    db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch_a' }]);
    db.pharmacyRequisition.findFirst.mockResolvedValue({
      id: 'req',
      branchId: 'branch_b',
      status: 'DRAFT',
      lines: [],
    });
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po',
      branchId: 'branch_b',
      status: 'SUBMITTED',
      lines: [],
    });
  });
  it.each(['submitPurchaseOrder', 'sendPurchaseOrder', 'landedCost'] as const)(
    'refuses %s on another branch order',
    async (name) => {
      await expect(caller()[name]({ purchaseOrderId: 'po' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(db.pharmacyPurchaseOrder.update).not.toHaveBeenCalled();
    }
  );
  it('refuses approval before recording an approval event', async () => {
    await expect(
      caller().approvePurchaseOrder({ purchaseOrderId: 'po', decision: 'APPROVED' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyPurchaseOrderApproval.create).not.toHaveBeenCalled();
    expect(db.pharmacyPurchaseOrder.update).not.toHaveBeenCalled();
  });
  it('refuses submission of another branch requisition', async () => {
    await expect(caller().submitRequisition({ requisitionId: 'req' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyRequisition.update).not.toHaveBeenCalled();
  });
  it('refuses quote comparison on another branch requisition', async () => {
    db.pharmacyRequisitionLine.findFirst.mockResolvedValue({
      id: 'line',
      requisition: { branchId: 'branch_b' },
    });
    await expect(caller().compareQuotes({ requisitionLineId: 'line' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyQuoteLine.findMany).not.toHaveBeenCalled();
  });
  it('refuses a new order naming another branch', async () => {
    await expect(
      caller().createPurchaseOrder({
        branchId: 'branch_b',
        supplierId: 'supplier',
        reference: 'PO',
        lines: [ORDER_LINE],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyPurchaseOrder.create).not.toHaveBeenCalled();
  });
  it('refuses a new requisition naming another branch', async () => {
    await expect(
      caller().createRequisition({
        branchId: 'branch_b',
        reference: 'REQ',
        lines: [
          {
            medicineId: 'medicine',
            packLevelId: 'pack',
            quantityPacks: 1,
            canonicalUnitsPerPack: 10,
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyRequisition.create).not.toHaveBeenCalled();
  });
});

describe('organization-wide (branchless) procurement records', () => {
  const REQUISITION_LINE = {
    medicineId: 'medicine_a',
    packLevelId: 'pack_a',
    quantityPacks: 1,
    canonicalUnitsPerPack: 10,
  };
  const actions = {
    submitPurchaseOrder: () => caller().submitPurchaseOrder({ purchaseOrderId: 'po' }),
    approvePurchaseOrder: () =>
      caller().approvePurchaseOrder({ purchaseOrderId: 'po', decision: 'APPROVED' }),
    sendPurchaseOrder: () => caller().sendPurchaseOrder({ purchaseOrderId: 'po' }),
    landedCost: () => caller().landedCost({ purchaseOrderId: 'po' }),
    compareQuotes: () => caller().compareQuotes({ requisitionLineId: 'line' }),
    submitRequisition: () => caller().submitRequisition({ requisitionId: 'req' }),
    createPurchaseOrder: () =>
      caller().createPurchaseOrder({
        supplierId: 'supplier_a',
        reference: 'PO-CENTRAL',
        lines: [ORDER_LINE],
      }),
    createRequisition: () =>
      caller().createRequisition({ reference: 'REQ-CENTRAL', lines: [REQUISITION_LINE] }),
  };

  beforeEach(() => {
    // A buyer assigned to branch_a only, with no organization-wide grant.
    db.pharmacyCentralPurchasingAccess.findMany.mockResolvedValue([{ branchId: 'branch_a' }]);
    db.pharmacyRequisition.findFirst.mockResolvedValue({
      id: 'req',
      branchId: null,
      status: 'DRAFT',
      lines: [],
    });
    db.pharmacyRequisitionLine.findFirst.mockResolvedValue({
      id: 'line',
      quantityPacks: 1,
      requisition: { branchId: null },
    });
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po',
      branchId: null,
      status: 'SUBMITTED',
      supplierId: 'supplier_a',
      createdByUserId: 'user_other',
      requisition: null,
      lines: [],
      freightMinor: 0,
      otherChargesMinor: 0,
    });
  });

  it.each(Object.keys(actions) as (keyof typeof actions)[])(
    'refuses %s for a branch-scoped buyer',
    async (name) => {
      await expect(actions[name]()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.pharmacyPurchaseOrder.update).not.toHaveBeenCalled();
      expect(db.pharmacyPurchaseOrder.create).not.toHaveBeenCalled();
      expect(db.pharmacyPurchaseOrderApproval.create).not.toHaveBeenCalled();
      expect(db.pharmacyRequisition.update).not.toHaveBeenCalled();
      expect(db.pharmacyRequisition.create).not.toHaveBeenCalled();
      expect(db.pharmacyQuoteLine.findMany).not.toHaveBeenCalled();
    }
  );

  it('lets an organization-wide central purchaser submit a branchless order', async () => {
    db.pharmacyCentralPurchasingAccess.findMany.mockResolvedValue([{ branchId: null }]);
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po',
      branchId: null,
      status: 'DRAFT',
    });
    await caller().submitPurchaseOrder({ purchaseOrderId: 'po' });
    expect(db.pharmacyPurchaseOrder.update).toHaveBeenCalledOnce();
  });
});

const readActions = {
  compareQuotes: () => caller().compareQuotes({ requisitionLineId: 'req_line_a' }),
  landedCost: () => caller().landedCost({ purchaseOrderId: 'po_a' }),
  controlledWitnesses: () =>
    caller().controlledWitnesses({ branchId: 'branch_a', goodsReceiptId: 'grn_a' }),
  controlledReversalWitnesses: () =>
    caller().controlledReversalWitnesses({ branchId: 'branch_a', goodsReceiptId: 'grn_a' }),
  receivingExceptions: () => caller().receivingExceptions({ branchId: 'branch_a' }),
  debitNotePositions: () => caller().debitNotePositions({ branchId: 'branch_a' }),
  workspace: () => caller().workspace(),
  suppliers: () => caller().suppliers(),
  requisitions: () => caller().requisitions(),
  purchaseOrders: () => caller().purchaseOrders(),
  receivedAgainstOrder: () => caller().receivedAgainstOrder({ purchaseOrderId: 'po_a' }),
  goodsReceipts: () => caller().goodsReceipts({ branchId: 'branch_a' }),
  receivingExceptionQueue: () => caller().receivingExceptionQueue({ branchId: 'branch_a' }),
  lotsFromReceipt: () =>
    caller().lotsFromReceipt({ branchId: 'branch_a', goodsReceiptId: 'grn_a' }),
  purchaseReturns: () => caller().purchaseReturns({ branchId: 'branch_a' }),
  supplierCredits: () => caller().supplierCredits({ branchId: 'branch_a' }),
  returnableLots: () => caller().returnableLots({ branchId: 'branch_a' }),
  resolveScan: () => caller().resolveScan({ term: 'scan' }),
  centralDemand: () => caller().centralDemand({}),
};
describe('every purchasing read boundary', () => {
  it('inventories every query so a new read cannot silently omit the authorization matrix', () => {
    const queries = Object.entries(pharmacyPurchasingRouter._def.procedures)
      .filter(([, procedure]) => procedure._def.type === 'query')
      .map(([name]) => name);
    expect(Object.keys(readActions).sort()).toEqual(queries.sort());
  });
  it.each(Object.entries(readActions))(
    'denies unrelated, inactive and explicitly denied actors on %s',
    async (name, act) => {
      // Financial readers have their own capability, independent of goods-in access.
      if (name === 'purchaseReturns' || name === 'supplierCredits')
        mocks.can.mockResolvedValue(false);
      for (const user of [
        null,
        {
          organizationRole: { permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
          permissionOverrides: [],
        },
        {
          organizationRole: { permissions: [{ capability: '*', effect: 'ALLOW' }] },
          permissionOverrides: [{ capability: 'pharmacy:*', effect: 'DENY' }],
        },
      ]) {
        db.user.findUnique.mockResolvedValue(user);
        await expect(act()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
      expect(db.pharmacySupplier.findMany).not.toHaveBeenCalled();
      expect(db.pharmacyGoodsReceipt.findMany).not.toHaveBeenCalled();
    }
  );
  it.each(['pharmacy:procurement', 'pharmacy:*'])(
    'keeps financial follow-up closed for %s without reports:financial',
    async (capability) => {
      db.user.findUnique.mockResolvedValue({
        organizationRole: { permissions: [{ capability, effect: 'ALLOW' }] },
        permissionOverrides: [],
      });
      await expect(caller().suppliers()).resolves.toEqual([]);
      // purchaseReturns / supplierCredits are FINANCIAL_FOLLOW_UP (reports:financial only).
      await expect(caller().purchaseReturns({ branchId: 'branch_a' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(caller().supplierCredits({ branchId: 'branch_a' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  );
  it('allows * to read purchasing and financial follow-up', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: { permissions: [{ capability: '*', effect: 'ALLOW' }] },
      permissionOverrides: [],
    });
    await expect(caller().suppliers()).resolves.toEqual([]);
    await expect(caller().purchaseReturns({ branchId: 'branch_a' })).resolves.toEqual([]);
    await expect(caller().supplierCredits({ branchId: 'branch_a' })).resolves.toEqual([]);
  });
  it('allows reports:financial to read purchaseReturns and supplierCredits', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: {
        permissions: [{ capability: 'reports:financial', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });
    await expect(caller().purchaseReturns({ branchId: 'branch_a' })).resolves.toEqual([]);
    await expect(caller().supplierCredits({ branchId: 'branch_a' })).resolves.toEqual([]);
  });
  it('refuses a write to an actor with receiving-view alone', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: {
        permissions: [{ capability: 'pharmacy:receiving-view', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });
    await expect(caller().createSupplier({ name: 'No write' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacySupplier.create).not.toHaveBeenCalled();
  });
});

function installedOwner() {
  db.user.findUnique.mockResolvedValue({
    status: 'ACTIVE',
    role: 'ADMIN',
    organizationRole: {
      key: 'owner',
      isSystem: true,
      permissions: [{ capability: '*', effect: 'ALLOW' }],
    },
    permissionOverrides: [],
  });
  db.user.count.mockResolvedValue(0);
  db.user.findMany.mockResolvedValue([{ id: 'user_a' }]);
  db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
  db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
  db.pharmacyBranch.findMany.mockResolvedValue([{ id: 'branch_a' }, { id: 'branch_b' }]);
  db.restaurantOperatorCredential.findFirst.mockResolvedValue({
    id: 'credential',
    credentialHash: APPROVER_HASH,
    failedAttempts: 0,
    lockedUntil: null,
  });
}
describe('solo owner purchasing exceptions', () => {
  beforeEach(() => {
    orderableSupplier();
    resolvableCatalog();
  });
  it('allows an installed owner into every active branch without assignments', async () => {
    installedOwner();
    await expect(caller().goodsReceipts({ branchId: 'branch_b' })).resolves.toEqual([]);
    expect(db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyGoodsReceipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_a', branchId: 'branch_b' } })
    );
  });
  it('preserves wildcard ADMIN procurement but does not mistake a custom role key for an owner', async () => {
    installedOwner();
    db.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      role: 'ADMIN',
      organizationRole: {
        key: 'custom',
        isSystem: false,
        permissions: [{ capability: '*', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });
    await expect(caller().goodsReceipts({ branchId: 'branch_b' })).resolves.toEqual([]);
    db.user.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      role: 'EMPLOYEE',
      organizationRole: {
        key: 'owner',
        isSystem: false,
        permissions: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });
    await expect(caller().goodsReceipts({ branchId: 'branch_b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it.each([undefined, '9999', '1234'])(
    'self-approves an order only with a verified PIN (%s)',
    async (pin) => {
      installedOwner();
      db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
        id: 'po_a',
        branchId: 'branch_a',
        createdByUserId: 'user_a',
        status: 'SUBMITTED',
        supplierId: 'supplier_a',
      });
      const result = await caller().approvePurchaseOrder({
        purchaseOrderId: 'po_a',
        decision: 'APPROVED',
        pin,
      });
      if (pin === '1234') {
        expect(result).toMatchObject({ status: 'APPROVED' });
        expect(db.pharmacyPurchaseOrderApproval.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            actorUserId: 'user_a',
            policy: 'PHARMACY_SOLO_OWNER_PIN',
          }),
        });
        expect(db.auditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            actorId: 'user_a',
            action: 'pharmacy.purchaseOrderApproval',
            targetId: 'po_a',
            metadata: {
              policy: 'PHARMACY_SOLO_OWNER_PIN',
              pinVerified: true,
              decision: 'APPROVED',
            },
          }),
        });
        const verifiedPin = db.$queryRaw.mock.calls.find(([sql]) =>
          (sql as TemplateStringsArray)
            .join('?')
            .includes('app.pharmacy_purchase_pin_verified_user_id')
        );
        expect(verifiedPin?.slice(1)).toEqual(['user_a']);
      } else {
        expect(result).toHaveProperty('blocked');
        expect(db.pharmacyPurchaseOrder.update).not.toHaveBeenCalled();
        expect(db.pharmacyPurchaseOrderApproval.create).not.toHaveBeenCalled();
      }
    }
  );
  it('requires a second approver when any other staff member is active in scope', async () => {
    installedOwner();
    db.user.count.mockResolvedValue(1);
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({
      id: 'po_a',
      branchId: 'branch_a',
      createdByUserId: 'user_a',
      status: 'SUBMITTED',
    });
    await expect(
      caller().approvePurchaseOrder({ purchaseOrderId: 'po_a', decision: 'APPROVED', pin: '1234' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyPurchaseOrderApproval.create).not.toHaveBeenCalled();
  });
});

it('does not post a historical direct draft on a stored approver ID alone', async () => {
  db.pharmacyGoodsReceipt.findFirst.mockResolvedValue({
    id: 'legacy',
    directPurchase: true,
    status: 'DRAFT',
    bypassApprovedByUserId: 'user_manager',
    receivedByUserId: 'user_a',
    purchaseOrder: null,
  });
  const result = await caller().postGoodsReceipt({
    branchId: 'branch_a',
    goodsReceiptId: 'legacy',
  });
  expect(result).toHaveProperty('blocked');
  expect(db.pharmacyGoodsReceipt.update).not.toHaveBeenCalled();
  expect(db.auditLog.create).not.toHaveBeenCalled();
});

describe('posting a historical direct draft re-verifies its recorded approver (#246)', () => {
  const legacyDraft = (approverId: string) => ({
    id: 'legacy',
    directPurchase: true,
    status: 'DRAFT',
    bypassApprovedByUserId: approverId,
    receivedByUserId: 'user_a',
    purchaseOrder: null,
  });
  const post = (approvalPin?: string) =>
    caller().postGoodsReceipt({ branchId: 'branch_a', goodsReceiptId: 'legacy', approvalPin });

  it('reads the receipt once, scoped to the tenant and the posting branch', async () => {
    db.pharmacyGoodsReceipt.findFirst.mockResolvedValueOnce(legacyDraft('user_manager'));
    await post();
    expect(db.pharmacyGoodsReceipt.findFirst).toHaveBeenCalledTimes(1);
    expect(db.pharmacyGoodsReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'legacy', organizationId: 'org_a', branchId: 'branch_a' },
      })
    );
  });

  it('records PIN-verified solo-owner evidence before the posting transaction', async () => {
    installedOwner();
    db.pharmacyGoodsReceipt.findFirst.mockResolvedValueOnce(legacyDraft('user_a'));
    const outcome = await post('1234').catch((error: unknown) => error);
    expect(outcome).not.toHaveProperty('blocked');
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'user_a',
        action: 'pharmacy.directPurchaseApproval',
        targetType: 'PharmacyGoodsReceipt',
        targetId: 'legacy',
        metadata: {
          approverId: 'user_a',
          pinVerified: true,
          policy: 'PHARMACY_SOLO_OWNER_PIN',
        },
      }),
    });
    const verifiedPin = db.$queryRaw.mock.calls.find(([sql]) =>
      (sql as TemplateStringsArray).join('?').includes('app.pharmacy_purchase_pin_verified_user_id')
    );
    expect(verifiedPin?.slice(1)).toEqual(['user_a']);
    // Approval evidence, then the controlled-witness check, then the posting.
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });

  it('refuses a wrong PIN without approval evidence or a posting transaction', async () => {
    installedOwner();
    db.pharmacyGoodsReceipt.findFirst.mockResolvedValueOnce(legacyDraft('user_a'));
    const result = await post('9999');
    expect(result).toHaveProperty('blocked');
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.pharmacyGoodsReceipt.update).not.toHaveBeenCalled();
  });

  it('refuses solo self-approval when another staff member is active in scope', async () => {
    installedOwner();
    db.user.count.mockResolvedValue(1);
    db.pharmacyGoodsReceipt.findFirst.mockResolvedValueOnce(legacyDraft('user_a'));
    const result = await post('1234');
    expect(result).toHaveProperty('blocked');
    expect(db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('purchasing list branch boundaries', () => {
  beforeEach(() => {
    db.pharmacyCentralPurchasingAccess.findMany.mockResolvedValue([]);
    db.pharmacyBranch.findMany.mockResolvedValue([{ id: 'branch_a' }, { id: 'branch_b' }]);
  });
  it.each(['requisitions', 'purchaseOrders'] as const)(
    'restricts %s to assigned branches',
    async (name) => {
      await caller()[name]();
      const source = name === 'requisitions' ? db.pharmacyRequisition : db.pharmacyPurchaseOrder;
      expect(source.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org_a',
            OR: [{ branchId: { in: ['branch_a'] } }],
          }),
        })
      );
    }
  );
  it.each(['branch_b', null])(
    'rejects receipt quantities for an unauthorized order scope %s',
    async (branchId) => {
      db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({ branchId });
      await expect(
        caller().receivedAgainstOrder({ purchaseOrderId: 'foreign' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.pharmacyGoodsReceiptLine.findMany).not.toHaveBeenCalled();
    }
  );
  it('reads receipt quantities for an assigned order', async () => {
    db.pharmacyPurchaseOrder.findFirst.mockResolvedValue({ branchId: 'branch_a' });
    await expect(caller().receivedAgainstOrder({ purchaseOrderId: 'mine' })).resolves.toEqual({});
  });
  it('keeps organization-wide orders visible to the installed owner', async () => {
    installedOwner();
    await caller().purchaseOrders();
    expect(db.pharmacyPurchaseOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_a',
          OR: [{ branchId: { in: ['branch_a', 'branch_b'] } }, { branchId: null }],
        }),
      })
    );
  });
});

describe('pharmacy-only approval PIN provisioning', () => {
  it('issues only the current buyer a hashed PIN with no restaurant entitlement', async () => {
    db.restaurantStaffProfile.create.mockResolvedValue({ id: 'my-profile' });
    db.restaurantStaffProfile.findUnique.mockResolvedValue({ id: 'my-profile', status: 'ACTIVE' });
    await expect(caller().provisionMyPurchasePin({ pin: '4821' })).resolves.toEqual({
      id: 'new',
      staffProfileId: 'my-profile',
    });
    expect(db.restaurantStaffProfile.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_a',
        userId: 'user_a',
        displayName: 'Pharmacy buyer',
      },
    });
    const data = db.restaurantOperatorCredential.create.mock.calls[0]![0].data as {
      credentialHash: string;
    };
    expect(data.credentialHash).not.toBe('4821');
    const { compare } = await import('bcryptjs');
    expect(await compare('4821', data.credentialHash)).toBe(true);
  });
  it('does not overwrite an existing PIN or clear its lockout', async () => {
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'my-profile' });
    db.restaurantStaffProfile.findUnique.mockResolvedValue({ id: 'my-profile', status: 'ACTIVE' });
    db.restaurantOperatorCredential.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(caller().provisionMyPurchasePin({ pin: '4821' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.restaurantOperatorCredential.create).not.toHaveBeenCalled();
    expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
  });
  it('rejects users without procurement or the pharmacy module before creating profiles', async () => {
    await expect(
      caller('user_a', []).provisionMyPurchasePin({ pin: '4821' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    db.user.findUnique.mockResolvedValue(null);
    await expect(caller().provisionMyPurchasePin({ pin: '4821' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.restaurantStaffProfile.create).not.toHaveBeenCalled();
  });
});

it('preserves explicit organization-wide central purchasing read access', async () => {
  db.pharmacyCentralPurchasingAccess.findMany.mockResolvedValue([{ branchId: null }]);
  db.pharmacyBranch.findMany.mockResolvedValue([{ id: 'branch_a' }, { id: 'branch_b' }]);
  await caller().purchaseOrders();
  expect(db.pharmacyPurchaseOrder.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        organizationId: 'org_a',
        OR: [{ branchId: { in: ['branch_a', 'branch_b'] } }, { branchId: null }],
      }),
    })
  );
});
it('limits branch-specific central purchasing grants to their granted branches', async () => {
  db.pharmacyCentralPurchasingAccess.findMany.mockResolvedValue([{ branchId: 'branch_b' }]);
  db.pharmacyBranch.findMany.mockResolvedValue([{ id: 'branch_a' }, { id: 'branch_b' }]);
  await caller().requisitions();
  expect(db.pharmacyRequisition.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { organizationId: 'org_a', OR: [{ branchId: { in: ['branch_a', 'branch_b'] } }] },
    })
  );
});

it.each(['requisitions', 'purchaseOrders'] as const)(
  'excludes inactive central grants from %s and related records',
  async (name) => {
    db.pharmacyCentralPurchasingAccess.findMany.mockResolvedValue([
      { branchId: 'branch_b' },
      { branchId: 'inactive_branch' },
    ]);
    db.pharmacyBranch.findMany.mockResolvedValue([{ id: 'branch_a' }, { id: 'branch_b' }]);
    await caller()[name]();
    expect(db.pharmacyBranch.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', active: true },
      select: { id: true },
    });
    const branches = { OR: [{ branchId: { in: ['branch_a', 'branch_b'] } }] };
    if (name === 'requisitions') {
      expect(db.pharmacyRequisition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org_a', ...branches },
          include: expect.objectContaining({
            purchaseOrders: expect.objectContaining({ where: branches }),
          }),
        })
      );
    } else {
      expect(db.pharmacyPurchaseOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org_a',
            ...branches,
            AND: [
              {
                OR: [
                  { requisitionId: null },
                  { requisition: { branchId: null } },
                  { requisition: { branchId: { in: ['branch_a', 'branch_b'] } } },
                ],
              },
            ],
          },
        })
      );
    }
  }
);

it('does not let self-provisioning replace a revoked PIN', async () => {
  db.restaurantOperatorCredential.findFirst.mockResolvedValue({ id: 'revoked', revokedAt: PAST });
  await expect(caller().provisionMyPurchasePin({ pin: '4821' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  expect(db.restaurantStaffProfile.create).not.toHaveBeenCalled();
  expect(db.restaurantOperatorCredential.create).not.toHaveBeenCalled();
});
it('does not let self-provisioning reactivate an archived staff profile', async () => {
  db.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'archived', status: 'ARCHIVED' });
  await expect(caller().provisionMyPurchasePin({ pin: '4821' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(db.restaurantStaffProfile.create).not.toHaveBeenCalled();
  expect(db.restaurantOperatorCredential.create).not.toHaveBeenCalled();
});
