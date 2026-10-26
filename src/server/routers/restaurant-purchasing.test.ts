/**
 * M6-L3 router — capability gating/wiring, strict inputs, the domain-error →
 * tRPC-status mapping, actor/idempotency plumbing, and Decimal-as-string
 * serialization. Runs the REAL router with the `purchasing.ts` command layer
 * mocked (its behaviour is proven against real PostgreSQL in purchasing.test.ts);
 * the ABAC decision, entitlement check and audit writer are mocked here so the
 * focus is the console edge itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const D = (v: string) => new Prisma.Decimal(v);

const mocks = vi.hoisted(() => {
  class PurchasingError extends Error {
    constructor(
      message: string,
      readonly reason: string
    ) {
      super(message);
      this.name = 'PurchasingError';
    }
  }
  const fn = () => vi.fn();
  return {
    PurchasingError,
    can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() =>
      Promise.resolve(true)
    ),
    createSupplier: fn(),
    updateSupplier: fn(),
    setSupplierActive: fn(),
    listSuppliers: fn(),
    getSupplier: fn(),
    createPurchaseOrder: fn(),
    addPurchaseOrderLine: fn(),
    updatePurchaseOrderLine: fn(),
    removePurchaseOrderLine: fn(),
    submitPurchaseOrder: fn(),
    approvePurchaseOrder: fn(),
    cancelPurchaseOrder: fn(),
    closePurchaseOrder: fn(),
    receivePurchaseOrder: fn(),
    createSupplierReturn: fn(),
    listPurchaseOrders: fn(),
    getPurchaseOrder: fn(),
    getPurchaseReceipt: fn(),
    findStaffProfiles: fn(),
    findBranchAssignments: fn(),
    findPurchaseOrder: fn(),
    findPurchaseReceipt: fn(),
    findStockLocation: fn(),
    annotateAudit: fn(),
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/purchasing', () => ({
  PurchasingError: mocks.PurchasingError,
  createSupplier: mocks.createSupplier,
  updateSupplier: mocks.updateSupplier,
  setSupplierActive: mocks.setSupplierActive,
  listSuppliers: mocks.listSuppliers,
  getSupplier: mocks.getSupplier,
  createPurchaseOrder: mocks.createPurchaseOrder,
  addPurchaseOrderLine: mocks.addPurchaseOrderLine,
  updatePurchaseOrderLine: mocks.updatePurchaseOrderLine,
  removePurchaseOrderLine: mocks.removePurchaseOrderLine,
  submitPurchaseOrder: mocks.submitPurchaseOrder,
  approvePurchaseOrder: mocks.approvePurchaseOrder,
  cancelPurchaseOrder: mocks.cancelPurchaseOrder,
  closePurchaseOrder: mocks.closePurchaseOrder,
  receivePurchaseOrder: mocks.receivePurchaseOrder,
  createSupplierReturn: mocks.createSupplierReturn,
  listPurchaseOrders: mocks.listPurchaseOrders,
  getPurchaseOrder: mocks.getPurchaseOrder,
  getPurchaseReceipt: mocks.getPurchaseReceipt,
}));

import { restaurantPurchasingRouter } from './restaurant-purchasing';
import type { TRPCContext } from '../trpc';

function caller() {
  return restaurantPurchasingRouter.createCaller({
    db: {
      restaurantStaffProfile: { findMany: mocks.findStaffProfiles },
      restaurantBranchAssignment: { findMany: mocks.findBranchAssignments },
      restaurantBranch: {
        findMany: vi.fn(async ({ where }: { where?: { id?: { in?: string[] } } }) =>
          (where?.id?.in ?? []).map((id) => ({ id }))
        ),
      },
      restaurantPurchaseOrder: { findUnique: mocks.findPurchaseOrder },
      restaurantPurchaseReceipt: { findUnique: mocks.findPurchaseReceipt },
      restaurantStockLocation: { findUnique: mocks.findStockLocation },
    } as never,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['restaurant-pos'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_po',
        role: 'EMPLOYEE',
        department: 'OPERATIONS',
        status: 'ACTIVE',
        organizationId: 'org_1',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const usedActions = () => mocks.can.mock.calls.map((c) => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.findStaffProfiles.mockResolvedValue([{ id: 'staff_server', primaryBranchId: 'b1' }]);
  mocks.findBranchAssignments.mockResolvedValue([]);
  mocks.findPurchaseOrder.mockResolvedValue({ branchId: 'b1', locationId: 'loc1' });
  mocks.findPurchaseReceipt.mockResolvedValue({ branchId: 'b1' });
  mocks.findStockLocation.mockResolvedValue({ branchId: 'b1' });
});

describe('capability gating', () => {
  it('gates supplier/PO reads on inventory:read', async () => {
    mocks.listSuppliers.mockResolvedValue({ suppliers: [], nextCursor: null });
    await caller().listSuppliers({});
    expect(usedActions()).toContain('inventory:read');
  });

  it('gates supplier/PO/receiving mutations on purchasing:create', async () => {
    mocks.createSupplier.mockResolvedValue({ id: 's1', name: 'Acme' });
    await caller().createSupplier({ name: 'Acme' });
    expect(usedActions()).toContain('purchasing:create');
  });

  it('gates the approval transition on purchasing:approve', async () => {
    mocks.approvePurchaseOrder.mockResolvedValue(minimalOrder());
    await caller().approvePurchaseOrder({ purchaseOrderId: 'po1' });
    expect(usedActions()).toContain('purchasing:approve');
    expect(usedActions()).not.toContain('purchasing:create');
  });

  it('denies when the ABAC engine refuses', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().createSupplier({ name: 'Acme' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.createSupplier).not.toHaveBeenCalled();
  });
});

describe('strict inputs', () => {
  it('rejects unknown input fields (never strips)', async () => {
    await expect(
      // @ts-expect-error — surplus field must be rejected, never stripped
      caller().listSuppliers({ surplus: true })
    ).rejects.toBeDefined();
  });

  it('requires at least one receive line', async () => {
    await expect(
      caller().receivePurchaseOrder({ purchaseOrderId: 'po1', lines: [] })
    ).rejects.toBeDefined();
    expect(mocks.receivePurchaseOrder).not.toHaveBeenCalled();
  });
});

describe('Decimal-as-string serialization (D07)', () => {
  it('serializes every quantity/cost on a purchase order as a string', async () => {
    mocks.getPurchaseOrder.mockResolvedValue({
      ...minimalOrder(),
      lines: [
        {
          id: 'l1',
          stockItemId: 'si1',
          unitId: 'u1',
          orderedQuantity: D('10.000000'),
          unitCost: D('2.50'),
          orderedQuantityCanonical: D('240.000000'),
          receivedQuantityCanonical: D('24.000000'),
          fullyReceived: false,
        },
      ],
    });
    const result = await caller().getPurchaseOrder({ purchaseOrderId: 'po1' });
    const line = result.lines[0]!;
    expect(line.orderedQuantity).toBe('10');
    expect(line.unitCost).toBe('2.5');
    expect(line.orderedQuantityCanonical).toBe('240');
    expect(line.receivedQuantityCanonical).toBe('24');
    expect(typeof line.orderedQuantity).toBe('string');
  });

  it('serializes received movement quantity/cost as strings', async () => {
    mocks.receivePurchaseOrder.mockResolvedValue({
      receiptId: 'r1',
      purchaseOrderId: 'po1',
      purchaseOrderStatus: 'RECEIVED',
      discrepancyIds: ['d1'],
      replayed: false,
      movements: [
        {
          id: 'm1',
          stockItemId: 'si1',
          locationId: 'loc1',
          quantity: D('10.000000'),
          unitCost: D('2.00'),
          batchId: null,
        },
      ],
    });
    const result = await caller().receivePurchaseOrder({
      purchaseOrderId: 'po1',
      lines: [{ purchaseOrderLineId: 'l1', receivedQuantity: '10' }],
    });
    expect(result.movements[0]!.quantity).toBe('10');
    expect(result.movements[0]!.unitCost).toBe('2');
    expect(result.purchaseOrderStatus).toBe('RECEIVED');
  });
});

describe('branch authorization', () => {
  it('allows purchase-order lists for primary and explicitly assigned branches', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action !== 'restaurant:configure');
    mocks.findBranchAssignments.mockResolvedValue([{ branchId: 'b2' }]);
    mocks.listPurchaseOrders.mockResolvedValue({ orders: [], nextCursor: null });

    await expect(caller().listPurchaseOrders({ branchId: 'b1' })).resolves.toEqual({
      orders: [],
      nextCursor: null,
    });
    await expect(caller().listPurchaseOrders({ branchId: 'b2' })).resolves.toEqual({
      orders: [],
      nextCursor: null,
    });
    expect(mocks.listPurchaseOrders).toHaveBeenNthCalledWith(1, expect.anything(), {
      branchId: 'b1',
    });
    expect(mocks.listPurchaseOrders).toHaveBeenNthCalledWith(2, expect.anything(), {
      branchId: 'b2',
    });
    expect(usedActions()).not.toContain('restaurant:configure');
  });

  it('allows configured staff to list another branch or all branches', async () => {
    mocks.listPurchaseOrders.mockResolvedValue({ orders: [], nextCursor: null });

    await expect(caller().listPurchaseOrders({ branchId: 'b2' })).resolves.toEqual({
      orders: [],
      nextCursor: null,
    });
    await expect(caller().listPurchaseOrders({})).resolves.toEqual({
      orders: [],
      nextCursor: null,
    });

    expect(mocks.listPurchaseOrders).toHaveBeenNthCalledWith(1, expect.anything(), {
      branchId: 'b2',
    });
    expect(mocks.listPurchaseOrders).toHaveBeenNthCalledWith(2, expect.anything(), {});
    expect(usedActions()).toContain('restaurant:configure');
  });

  it('allows configured staff to mutate a purchase order from another branch', async () => {
    mocks.findPurchaseOrder.mockResolvedValue({ branchId: 'b2', locationId: 'loc2' });
    mocks.submitPurchaseOrder.mockResolvedValue({ ...minimalOrder(), branchId: 'b2' });

    await expect(
      caller().submitPurchaseOrder({ purchaseOrderId: 'po2' })
    ).resolves.toMatchObject({ branchId: 'b2' });

    expect(usedActions()).toContain('restaurant:configure');
    expect(mocks.submitPurchaseOrder).toHaveBeenCalledWith(expect.anything(), 'po2');
    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), {
      targetType: 'RestaurantPurchaseOrder',
      targetId: 'po2',
    });
  });

  it('denies branch-limited staff access to purchase orders and receipts from another branch', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action !== 'restaurant:configure');
    mocks.findPurchaseOrder.mockResolvedValue({ branchId: 'b2', locationId: 'loc2' });
    mocks.findPurchaseReceipt.mockResolvedValue({ branchId: 'b2' });

    await expect(caller().listPurchaseOrders({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().listPurchaseOrders({ branchId: 'b2' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller().getPurchaseOrder({ purchaseOrderId: 'po2' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller().getReceipt({ receiptId: 'receipt2' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const mutations = [
      () => caller().addPurchaseOrderLine({ purchaseOrderId: 'po2', line: lineInput() }),
      () =>
        caller().updatePurchaseOrderLine({
          purchaseOrderId: 'po2',
          lineId: 'line2',
          unitCost: '2',
        }),
      () => caller().removePurchaseOrderLine({ purchaseOrderId: 'po2', lineId: 'line2' }),
      () => caller().submitPurchaseOrder({ purchaseOrderId: 'po2' }),
      () => caller().cancelPurchaseOrder({ purchaseOrderId: 'po2' }),
      () => caller().closePurchaseOrder({ purchaseOrderId: 'po2' }),
    ];
    for (const mutation of mutations) {
      await expect(mutation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    expect(mocks.listPurchaseOrders).not.toHaveBeenCalled();
    expect(mocks.getPurchaseOrder).not.toHaveBeenCalled();
    expect(mocks.getPurchaseReceipt).not.toHaveBeenCalled();
    expect(mocks.addPurchaseOrderLine).not.toHaveBeenCalled();
    expect(mocks.updatePurchaseOrderLine).not.toHaveBeenCalled();
    expect(mocks.removePurchaseOrderLine).not.toHaveBeenCalled();
    expect(mocks.submitPurchaseOrder).not.toHaveBeenCalled();
    expect(mocks.cancelPurchaseOrder).not.toHaveBeenCalled();
    expect(mocks.closePurchaseOrder).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('returns not found without authorizing or mutating when the scoped resource is missing', async () => {
    mocks.findPurchaseOrder.mockResolvedValue(null);
    mocks.findPurchaseReceipt.mockResolvedValue(null);

    await expect(caller().getPurchaseOrder({ purchaseOrderId: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller().getReceipt({ receiptId: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller().submitPurchaseOrder({ purchaseOrderId: 'missing' })).rejects.toMatchObject(
      { code: 'NOT_FOUND' }
    );

    expect(mocks.findStaffProfiles).not.toHaveBeenCalled();
    expect(mocks.getPurchaseOrder).not.toHaveBeenCalled();
    expect(mocks.getPurchaseReceipt).not.toHaveBeenCalled();
    expect(mocks.submitPurchaseOrder).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });
});

describe('actor + idempotency plumbing', () => {
  it('rejects a create location outside the authorized branch before mutation', async () => {
    mocks.findStockLocation.mockResolvedValue({ branchId: 'b2' });

    await expect(
      caller().createPurchaseOrder({ supplierId: 's1', branchId: 'b1', locationId: 'loc2' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.createPurchaseOrder).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('rejects a receive override outside the purchase-order branch before mutation', async () => {
    mocks.findStockLocation.mockResolvedValue({ branchId: 'b2' });

    await expect(
      caller().receivePurchaseOrder({
        purchaseOrderId: 'po1',
        locationId: 'loc2',
        lines: [{ purchaseOrderLineId: 'l1', receivedQuantity: '1' }],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.receivePurchaseOrder).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('derives receipt staff from the session and leaves device attribution absent', async () => {
    mocks.receivePurchaseOrder.mockResolvedValue({
      receiptId: 'r1',
      purchaseOrderId: 'po1',
      purchaseOrderStatus: 'RECEIVED',
      discrepancyIds: [],
      replayed: false,
      movements: [],
    });
    await caller().receivePurchaseOrder({
      purchaseOrderId: 'po1',
      idempotencyKey: 'idem-1',
      lines: [{ purchaseOrderLineId: 'l1', receivedQuantity: '10' }],
    });
    const arg = mocks.receivePurchaseOrder.mock.calls[0]![1];
    expect(arg.actor).toEqual({
      staffProfileId: 'staff_server',
      idempotencyKey: 'idem-1',
    });
  });

  it('derives PO creator and approver from the same active branch-authorized profile', async () => {
    mocks.createPurchaseOrder.mockResolvedValue(minimalOrder());
    mocks.approvePurchaseOrder.mockResolvedValue(minimalOrder());

    await caller().createPurchaseOrder({ supplierId: 's1', branchId: 'b1' });
    await caller().approvePurchaseOrder({ purchaseOrderId: 'po1' });

    expect(mocks.createPurchaseOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ createdByStaffProfileId: 'staff_server' })
    );
    expect(mocks.approvePurchaseOrder).toHaveBeenCalledWith(expect.anything(), 'po1', {
      approvedByStaffProfileId: 'staff_server',
    });
  });

  it('derives supplier-return staff and leaves device attribution absent', async () => {
    mocks.createSupplierReturn.mockResolvedValue({ replayed: false, movements: [] });
    await caller().createSupplierReturn({
      locationId: 'loc1',
      idempotencyKey: 'return-idem',
      lines: [{ stockItemId: 'si1', quantity: '1' }],
    });
    expect(mocks.createSupplierReturn.mock.calls[0]![1].actor).toEqual({
      staffProfileId: 'staff_server',
      idempotencyKey: 'return-idem',
    });
  });

  it.each([
    ['createPurchaseOrder', { supplierId: 's1', branchId: 'b1', createdByStaffProfileId: 'spoof' }],
    ['approvePurchaseOrder', { purchaseOrderId: 'po1', approvedByStaffProfileId: 'spoof' }],
    [
      'receivePurchaseOrder',
      {
        purchaseOrderId: 'po1',
        actingStaffProfileId: 'spoof',
        deviceId: 'spoof-device',
        lines: [{ purchaseOrderLineId: 'l1', receivedQuantity: '1' }],
      },
    ],
    [
      'createSupplierReturn',
      {
        locationId: 'loc1',
        actingStaffProfileId: 'spoof',
        deviceId: 'spoof-device',
        lines: [{ stockItemId: 'si1', quantity: '1' }],
      },
    ],
  ] as const)('rejects client attribution spoofing on %s', async (procedure, input) => {
    await expect(
      (caller()[procedure] as (value: never) => Promise<unknown>)(input as never)
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('fails before purchasing mutation when no active staff mapping exists', async () => {
    mocks.findStaffProfiles.mockResolvedValue([]);
    await expect(
      caller().createPurchaseOrder({ supplierId: 's1', branchId: 'b1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.createPurchaseOrder).not.toHaveBeenCalled();
  });

  it('fails before purchasing mutation when the active staff mapping is ambiguous', async () => {
    mocks.findStaffProfiles.mockResolvedValue([
      { id: 'staff_one', primaryBranchId: 'b1' },
      { id: 'staff_two', primaryBranchId: 'b1' },
    ]);
    await expect(
      caller().createPurchaseOrder({ supplierId: 's1', branchId: 'b1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.createPurchaseOrder).not.toHaveBeenCalled();
  });
});

describe('domain error mapping', () => {
  it('maps a NOT_FOUND PurchasingError to a tRPC NOT_FOUND', async () => {
    mocks.getSupplier.mockRejectedValue(
      new mocks.PurchasingError('The supplier does not exist.', 'NOT_FOUND')
    );
    await expect(caller().getSupplier({ supplierId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('maps an INVALID_STATE PurchasingError to a tRPC BAD_REQUEST', async () => {
    mocks.submitPurchaseOrder.mockRejectedValue(
      new mocks.PurchasingError(
        'Expected a DRAFT purchase order but it is SUBMITTED.',
        'INVALID_STATE'
      )
    );
    await expect(caller().submitPurchaseOrder({ purchaseOrderId: 'po1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

/** A minimal getPurchaseOrder-shaped result with no lines/receipts. */
function minimalOrder() {
  return {
    id: 'po1',
    supplierId: 's1',
    supplierName: 'Acme',
    branchId: 'b1',
    locationId: 'loc1',
    status: 'APPROVED',
    reference: null,
    expectedDate: null,
    submittedAt: null,
    approvedAt: null,
    closedAt: null,
    cancelledAt: null,
    createdByStaffProfileId: null,
    approvedByStaffProfileId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lines: [],
    receipts: [],
  };
}

function lineInput() {
  return { stockItemId: 'si1', orderedQuantity: '1', unitId: 'u1', unitCost: '1' };
}
