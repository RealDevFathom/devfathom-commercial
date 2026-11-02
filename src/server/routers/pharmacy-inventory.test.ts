/**
 * PH-INV / INV-01..04 — the transport layer.
 *
 * These cases cover only what the router itself owns: the `pharmacy-inventory`
 * entitlement mapping, the refusal to take the tenant or the actor from the
 * payload, and cross-tenant ID substitution on the two references the router
 * checks before it reaches the ledger. Every invariant the ledger and its
 * triggers own is proved against a real database in
 * `lib/pharmacy/stock-ledger.db.test.ts`, not here.
 */
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

import { moduleForProcedure } from '@/lib/module-catalog';

import { pharmacyInventoryRouter } from './pharmacy-inventory';
import type { TRPCContext } from '../trpc';

function model() {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi
      .fn()
      .mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
    update: vi.fn(),
    count: vi.fn(),
  };
}

function makeDb() {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: {
          permissions: [{ capability: 'pharmacy:inventory', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
    },
    medicine: model(),
    packLevel: model(),
    pharmacyStockLocation: model(),
    pharmacyManufacturingBatch: model(),
    pharmacyInventoryLot: model(),
    pharmacyStockMovement: model(),
    pharmacyStockBalance: model(),
    pharmacyAllocationOverride: model(),
    pharmacyStockDiscrepancy: model(),
    pharmacySafetyStock: Object.assign(model(), {
      upsert: vi
        .fn()
        .mockImplementation(async ({ create }: { create: object }) => ({ id: 'new', ...create })),
      findMany: vi.fn().mockResolvedValue([]),
    }),
    pharmacyStockSignal: Object.assign(model(), { findMany: vi.fn().mockResolvedValue([]) }),
    pharmacyStockSignalEvent: model(),
    pharmacyStockSignalAction: model(),
    pharmacyRequisition: model(),
    pharmacyRequisitionLine: model(),
    pharmacyInterbranchTransfer: model(),
    pharmacyPurchaseReturn: model(),
    pharmacyPurchaseReturnLine: model(),
    pharmacyBranchAssignment: {
      findFirst: vi.fn().mockResolvedValue({ id: 'assignment_a' }),
    },
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        (where.id?.in ?? []).map((id) => ({ id }))
      ),
    },
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    $queryRaw: vi.fn(async () => []),
  });
}

let db = makeDb();
function caller(overrides: { enabledModules?: string[]; userId?: string | null } = {}) {
  return pharmacyInventoryRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: overrides.enabledModules ?? ['pharmacy-inventory'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session:
      overrides.userId === null
        ? null
        : {
            expires: 'later',
            user: { id: overrides.userId ?? 'user_a', role: 'ADMIN', status: 'ACTIVE' },
          },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  db = makeDb();
  mocks.hasModule.mockImplementation((view, key) => view.enabledModules.includes(key));
});

describe('pharmacy inventory entitlement and tenant boundaries', () => {
  it('maps the public router prefix to the pharmacy-inventory entitlement', () => {
    expect(moduleForProcedure('pharmacyInventory.allocateForSale')).toBe('pharmacy-inventory');
    // Not the mandatory Core module the medicine identity lane maps to.
    expect(moduleForProcedure('pharmacyMedicine.createIngredient')).toBe('pharmacy-core');
  });

  it('rejects a cross-tenant medicine ID substitution when registering a batch', async () => {
    await expect(
      caller().registerBatch({
        medicineId: 'medicine_from_org_b',
        batchNumber: 'B-1',
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyManufacturingBatch.create).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant pack level ID substitution when receiving a lot', async () => {
    await expect(
      caller().receiveLot({
        branchId: 'branch_a',
        manufacturingBatchId: 'batch_1',
        packLevelId: 'pack_level_from_org_b',
        stockLocationId: 'location_1',
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: 'INV-1',
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
        expiryPrecision: 'DAY',
        quantityUnits: 100,
        idempotencyKey: 'receipt-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyInventoryLot.create).not.toHaveBeenCalled();
  });

  it('takes the organization from the session, never from the payload', async () => {
    db.medicine.findFirst.mockResolvedValue({ id: 'medicine_1' });
    await caller().registerBatch({
      medicineId: 'medicine_1',
      batchNumber: 'B-1',
      printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
      expiryPrecision: 'DAY',
    });
    expect(db.pharmacyManufacturingBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationId: 'org_a' }) })
    );
  });

  it('normalises a MONTH-precision expiry to the first instant after the month', async () => {
    db.medicine.findFirst.mockResolvedValue({ id: 'medicine_1' });
    await caller().registerBatch({
      medicineId: 'medicine_1',
      batchNumber: 'B-1',
      // Printed "06/2027": good through the whole of June.
      printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
      expiryPrecision: 'MONTH',
    });
    expect(db.pharmacyManufacturingBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt: new Date('2027-07-01T00:00:00.000Z') }),
      })
    );
  });

  it('refuses to block a batch without a reason (INV-03 evidence)', async () => {
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({ id: 'batch_1' });
    await expect(
      caller().setBatchState({ manufacturingBatchId: 'batch_1', state: 'RECALLED' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyManufacturingBatch.update).not.toHaveBeenCalled();
  });

  it('refuses a transfer whose source and destination are the same location', async () => {
    await expect(
      caller().transfer({
        branchId: 'branch_a',
        inventoryLotId: 'lot_1',
        fromStockLocationId: 'location_1',
        toStockLocationId: 'location_1',
        units: 10,
        idempotencyKeyPrefix: 'transfer-1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a branch that is not an active branch in the session organization', async () => {
    db.pharmacyBranch.findMany.mockResolvedValueOnce([]);
    await expect(
      caller().createLocation({
        branchId: 'branch_other',
        code: 'MAIN',
        name: 'Main store',
        kind: 'STORE',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(db.pharmacyStockLocation.create).not.toHaveBeenCalled();
  });

  it('refuses every mutation when there is no tenant actor to attribute it to', async () => {
    await expect(
      caller({ userId: null }).createLocation({
        branchId: 'branch_a',
        code: 'MAIN',
        name: 'Main store',
        kind: 'STORE',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.pharmacyStockLocation.create).not.toHaveBeenCalled();
  });

  const vulnerableMutations = [
    {
      name: 'createLocation',
      invoke: () =>
        caller().createLocation({
          branchId: 'branch_a',
          code: 'MAIN',
          name: 'Main store',
          kind: 'STORE',
        }),
    },
    {
      name: 'receiveLot',
      invoke: () =>
        caller().receiveLot({
          branchId: 'branch_a',
          manufacturingBatchId: 'batch_1',
          packLevelId: 'pack_1',
          stockLocationId: 'location_1',
          unitsPerPack: 10,
          supplierName: 'Distributor Ltd',
          supplierInvoiceRef: 'INV-1',
          unitCostMinor: 1200,
          printedMrpMinor: 2000,
          printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
          expiryPrecision: 'DAY',
          quantityUnits: 100,
          idempotencyKey: 'receipt-1',
        }),
    },
    {
      name: 'createCount',
      invoke: () =>
        caller().createCount({
          branchId: 'branch_a',
          varianceThreshold: 0,
          readings: [
            {
              inventoryLotId: 'lot_1',
              stockLocationId: 'location_1',
              countedSealedPacks: 1,
              countedLooseUnits: 0,
            },
          ],
        }),
    },
    {
      name: 'writeOff',
      invoke: () =>
        caller().writeOff({
          branchId: 'branch_a',
          inventoryLotId: 'lot_1',
          stockLocationId: 'location_1',
          units: 1,
          witnessId: 'witness_1',
          reason: 'Damaged',
          evidenceRef: 'photo-1',
          idempotencyKey: 'write-off-1',
        }),
    },
  ];

  it.each(vulnerableMutations)('denies $name without pharmacy:inventory', async ({ invoke }) => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: { permissions: [] },
      permissionOverrides: [],
    });

    await expect(invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
  });

  it.each(vulnerableMutations)(
    'denies $name outside the actor branch assignment',
    async ({ invoke }) => {
      db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);

      await expect(invoke()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Branch is outside your scope.',
      });
      expect(db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: 'org_a',
          branchId: 'branch_a',
          userId: 'user_a',
          active: true,
          branch: { organizationId: 'org_a', active: true },
        },
        select: { id: true },
      });
    }
  );

  it('keeps the branch-assignment check off the inventory reads', async () => {
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    const findMany = () => vi.fn().mockResolvedValue([]);
    Object.assign(db.pharmacyStockLocation, { findMany: findMany() });
    Object.assign(db.pharmacyInterbranchTransfer, { findMany: findMany() });
    Object.assign(db.pharmacyStockMovement, { findMany: findMany() });
    Object.assign(db.user, { findMany: findMany() });

    await expect(caller().nearExpiryBoard({ branchId: 'branch_a' })).resolves.toEqual([]);
    await expect(caller().temperatureZoneStatuses({ branchId: 'branch_a' })).resolves.toEqual([]);
    await expect(caller().transferBoard({ branchId: 'branch_a' })).resolves.toEqual([]);
    expect(db.pharmacyBranchAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('leaves a non-target mutation such as allocateForSale on the tenant branch check', async () => {
    const allocate = () =>
      caller().allocateForSale({
        branchId: 'branch_a',
        medicineId: 'medicine_1',
        requiredUnits: 1,
        idempotencyKeyPrefix: 'sale-1',
      });
    const assigned = await allocate().then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    db = makeDb();
    db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    const unassigned = await allocate().then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );

    expect(unassigned).toEqual(assigned);
    expect(unassigned).not.toMatchObject({
      error: { message: 'Branch is outside your scope.' },
    });
    expect(db.pharmacyBranchAssignment.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyBranch.findMany).toHaveBeenCalled();
  });

  it('lets an explicit user deny override an inventory allow from the role', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: {
        permissions: [{ capability: 'pharmacy:inventory', effect: 'ALLOW' }],
      },
      permissionOverrides: [{ capability: 'pharmacy:inventory', effect: 'DENY' }],
    });

    await expect(vulnerableMutations[0]!.invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
  });
});

describe('PUR-07 — the stock action centre transport', () => {
  it('gates the action centre behind the same pharmacy-inventory entitlement', () => {
    expect(moduleForProcedure('pharmacyInventory.refreshStockSignals')).toBe('pharmacy-inventory');
    expect(moduleForProcedure('pharmacyInventory.createDraftAction')).toBe('pharmacy-inventory');
  });

  it('records the SESSION actor as the safety-stock approver, never a payload field', async () => {
    db.medicine.findFirst.mockResolvedValue({ id: 'medicine_1' });
    await caller({ userId: 'user_pharmacist_in_charge' }).approveSafetyStock({
      branchId: 'branch_a',
      medicineId: 'medicine_1',
      safetyStockUnits: 120,
      coverageDays: 30,
    });
    expect(db.pharmacySafetyStock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          organizationId: 'org_a',
          approvedByUserId: 'user_pharmacist_in_charge',
        }),
      })
    );
  });

  it('rejects a cross-tenant medicine ID when approving a safety stock', async () => {
    await expect(
      caller().approveSafetyStock({
        branchId: 'branch_a',
        medicineId: 'medicine_from_org_b',
        safetyStockUnits: 120,
        coverageDays: 30,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacySafetyStock.upsert).not.toHaveBeenCalled();
  });

  it('refuses a snooze or a dismissal with no reason (§8A invariant 29)', async () => {
    for (const call of [
      () =>
        caller().snoozeSignal({
          branchId: 'branch_a',
          signalId: 'signal_1',
          until: new Date('2026-09-10T00:00:00.000Z'),
          reason: '   ',
        }),
      () => caller().dismissSignal({ branchId: 'branch_a', signalId: 'signal_1', reason: '' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(db.pharmacyStockSignal.update).not.toHaveBeenCalled();
  });

  it('has no draft-action shape that could name a purchase order or a movement', async () => {
    // §8A invariant 29 at the transport layer: the discriminated union admits
    // exactly three kinds, all of them drafts. A caller cannot smuggle a fourth.
    await expect(
      caller().createDraftAction({
        // @ts-expect-error — proving the schema rejects a non-draft action kind.
        kind: 'CREATE_PURCHASE_ORDER',
        branchId: 'branch_a',
        signalId: 'signal_1',
      })
    ).rejects.toBeDefined();
    expect(db.pharmacyStockSignalAction.create).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a draft action when there is no tenant actor to attribute it to', async () => {
    await expect(
      caller({ userId: null }).createDraftAction({
        kind: 'DRAFT_REQUISITION',
        branchId: 'branch_a',
        signalId: 'signal_1',
        reference: 'REQ-1',
        medicineId: 'medicine_1',
        packLevelId: 'pack_1',
        canonicalUnitsPerPack: 10,
        quantityPacks: 8,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.pharmacyRequisition.create).not.toHaveBeenCalled();
  });
});
