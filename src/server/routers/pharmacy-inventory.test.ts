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
    medicine: model(),
    packLevel: model(),
    pharmacyStockLocation: model(),
    pharmacyManufacturingBatch: model(),
    pharmacyInventoryLot: model(),
    pharmacyStockMovement: model(),
    pharmacyStockBalance: model(),
    pharmacyAllocationOverride: model(),
    pharmacyStockDiscrepancy: model(),
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
});
