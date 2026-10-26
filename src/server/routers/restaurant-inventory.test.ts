/**
 * M6-L2 router — capability gating, strict input rejection, and Decimal-as-string
 * serialization for the inventory console surface. Runs the real router against a
 * hand-rolled in-memory db; ABAC/audit middleware mocked (platform middleware).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const D = (v: string) => new Prisma.Decimal(v);

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  listStockOnHand: vi.fn(),
  evaluateLowStockRules: vi.fn(),
  listStockMovements: vi.fn(),
  listStockCounts: vi.fn(),
  listStockTransfers: vi.fn(),
  listStockBatches: vi.fn(),
  createStockItem: vi.fn(),
  createStockCount: vi.fn(),
  addStockCountLine: vi.fn(),
  submitStockCount: vi.fn(),
  postStockCount: vi.fn(),
  createStockTransfer: vi.fn(),
  addStockTransferLine: vi.fn(),
  completeStockTransfer: vi.fn(),
  postWastage: vi.fn(),
  postSaleReversal: vi.fn(),
  createLowStockRule: vi.fn(),
  updateLowStockRule: vi.fn(),
  deleteLowStockRule: vi.fn(),
  findStaffProfiles: vi.fn(),
  findBranchAssignments: vi.fn(),
  findStockLocation: vi.fn(),
  findStockCount: vi.fn(),
  findStockTransfer: vi.fn(),
  findLowStockRule: vi.fn(),
  findBranch: vi.fn(),
  countStockLocations: vi.fn(),
  createStockLocation: vi.fn(),
  updateStockLocation: vi.fn(),
  queryRaw: vi.fn(),
}));

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
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/inventory', () => ({
  listStockOnHand: mocks.listStockOnHand,
  evaluateLowStockRules: mocks.evaluateLowStockRules,
  listStockMovements: mocks.listStockMovements,
  listStockCounts: mocks.listStockCounts,
  listStockTransfers: mocks.listStockTransfers,
  listStockBatches: mocks.listStockBatches,
  createStockItem: mocks.createStockItem,
  createStockCount: mocks.createStockCount,
  addStockCountLine: mocks.addStockCountLine,
  submitStockCount: mocks.submitStockCount,
  postStockCount: mocks.postStockCount,
  createStockTransfer: mocks.createStockTransfer,
  addStockTransferLine: mocks.addStockTransferLine,
  completeStockTransfer: mocks.completeStockTransfer,
  postWastage: mocks.postWastage,
  postSaleReversal: mocks.postSaleReversal,
  createLowStockRule: mocks.createLowStockRule,
  updateLowStockRule: mocks.updateLowStockRule,
  deleteLowStockRule: mocks.deleteLowStockRule,
  InventoryError: class InventoryError extends Error {
    constructor(
      message: string,
      readonly reason: string
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/restaurant/inventory-ledger', () => ({
  StockLedgerError: class StockLedgerError extends Error {
    constructor(
      message: string,
      readonly reason: string
    ) {
      super(message);
    }
  },
}));

import { restaurantInventoryRouter } from './restaurant-inventory';
import type { TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const db = {
  restaurantStaffProfile: { findMany: mocks.findStaffProfiles },
  restaurantBranchAssignment: { findMany: mocks.findBranchAssignments },
  restaurantBranch: {
    findUnique: mocks.findBranch,
    findFirst: mocks.findBranch,
    findMany: vi.fn(async ({ where }: { where?: { id?: { in?: string[] } } }) =>
      (where?.id?.in ?? []).map((id) => ({ id }))
    ),
  },
  restaurantStockLocation: {
    findUnique: mocks.findStockLocation,
    count: mocks.countStockLocations,
    create: mocks.createStockLocation,
    update: mocks.updateStockLocation,
  },
  restaurantStockCount: { findUnique: mocks.findStockCount },
  restaurantStockTransfer: { findUnique: mocks.findStockTransfer },
  restaurantLowStockRule: { findUnique: mocks.findLowStockRule },
  $queryRaw: mocks.queryRaw,
  $transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(db)),
} as unknown as ScopedDb;

function caller(
  canOverride?: boolean,
  limits: Record<string, number> = { 'inventory.stockLocations.max': 2 }
) {
  if (canOverride !== undefined) mocks.can.mockResolvedValue(canOverride);
  return restaurantInventoryRouter.createCaller({
    db,
    entitlements: {
      enabledModules: ['restaurant-pos'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits,
    },
    session: {
      expires: 'later',
      user: { id: 'user_test', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_test' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.findStaffProfiles.mockResolvedValue([{ id: 'staff_test', primaryBranchId: 'branch_1' }]);
  mocks.findBranchAssignments.mockResolvedValue([]);
  mocks.findStockLocation.mockImplementation(async ({ where }) => ({
    branchId: where.id === 'loc_2' ? 'branch_2' : 'branch_1',
  }));
  mocks.findStockCount.mockResolvedValue({ location: { branchId: 'branch_1' } });
  mocks.findStockTransfer.mockResolvedValue({
    sourceLocation: { branchId: 'branch_1' },
    destinationLocation: { branchId: 'branch_1' },
  });
  mocks.findLowStockRule.mockResolvedValue({ location: { branchId: 'branch_1' } });
  mocks.findBranch.mockResolvedValue({ id: 'branch_1', active: true });
  mocks.findStockLocation.mockImplementation(async ({ where }) => ({
    id: where.id,
    branchId: where.id === 'loc_2' ? 'branch_2' : 'branch_1',
    isActive: false,
  }));
  mocks.countStockLocations.mockResolvedValue(0);
  mocks.createStockLocation.mockResolvedValue({ id: 'loc_new', isActive: true });
  mocks.updateStockLocation.mockResolvedValue({ id: 'loc_1', isActive: true });
  mocks.createStockItem.mockResolvedValue({ id: 'stock_item_new' });
  mocks.queryRaw.mockResolvedValue([]);
});

describe('restaurantInventoryRouter', () => {
  it('creates a stock item through the domain service for an active restaurant actor', async () => {
    await expect(
      caller().createStockItem({
        ingredientId: 'ingredient_1',
        canonicalUnitId: 'unit_1',
        trackBatches: true,
      })
    ).resolves.toEqual({ id: 'stock_item_new' });
    expect(mocks.createStockItem).toHaveBeenCalledWith(db, {
      ingredientId: 'ingredient_1',
      canonicalUnitId: 'unit_1',
      trackBatches: true,
    });
  });

  describe('stock location commercial ceiling', () => {
    it('creates below the active organization-wide ceiling under an advisory lock', async () => {
      await expect(
        caller().createStockLocation({ branchId: 'branch_1', name: 'Walk-in' })
      ).resolves.toMatchObject({ id: 'loc_new', isActive: true });
      expect(mocks.queryRaw).toHaveBeenCalledOnce();
      expect(mocks.countStockLocations).toHaveBeenCalledWith({ where: { isActive: true } });
      expect(mocks.createStockLocation).toHaveBeenCalledOnce();
    });

    it('denies create at the ceiling, including explicit zero, without a partial write', async () => {
      mocks.countStockLocations.mockResolvedValue(2);
      await expect(
        caller().createStockLocation({ branchId: 'branch_1', name: 'Dry store' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.createStockLocation).not.toHaveBeenCalled();

      mocks.countStockLocations.mockResolvedValue(0);
      await expect(
        caller(undefined, { 'inventory.stockLocations.max': 0 }).createStockLocation({
          branchId: 'branch_1',
          name: 'Disabled',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.createStockLocation).not.toHaveBeenCalled();
    });

    it.each<Record<string, number>>([
      {},
      { 'inventory.stockLocations.max': -1 },
      { 'inventory.stockLocations.max': 1.5 },
      { 'inventory.stockLocations.max': Number.NaN },
    ])('fails closed for missing or invalid limit %#', async (limits) => {
      await expect(
        caller(undefined, limits).createStockLocation({ branchId: 'branch_1', name: 'Walk-in' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.queryRaw).not.toHaveBeenCalled();
      expect(mocks.createStockLocation).not.toHaveBeenCalled();
    });

    it('checks the ceiling when reactivating but not for idempotent active or deactivation', async () => {
      mocks.countStockLocations.mockResolvedValue(2);
      await expect(
        caller().setStockLocationActive({ id: 'loc_1', isActive: true })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.updateStockLocation).not.toHaveBeenCalled();

      mocks.findStockLocation.mockResolvedValue({
        id: 'loc_1',
        branchId: 'branch_1',
        isActive: true,
      });
      await caller().setStockLocationActive({ id: 'loc_1', isActive: false });
      expect(mocks.updateStockLocation).toHaveBeenCalledWith({
        where: { id: 'loc_1' },
        data: { isActive: false },
      });
      await expect(
        caller(undefined, {}).setStockLocationActive({ id: 'loc_1', isActive: false })
      ).resolves.toMatchObject({ id: 'loc_1', isActive: true });
    });

    it('rejects a cross-tenant branch or location hidden by RLS before writing', async () => {
      mocks.findBranch.mockResolvedValue(null);
      await expect(
        caller().createStockLocation({ branchId: 'other_tenant_branch', name: 'Walk-in' })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      mocks.findStockLocation.mockResolvedValue(null);
      await expect(
        caller().setStockLocationActive({ id: 'other_tenant_location', isActive: true })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mocks.createStockLocation).not.toHaveBeenCalled();
      expect(mocks.updateStockLocation).not.toHaveBeenCalled();
    });

    it('rolls back a failed create after the ceiling check', async () => {
      mocks.createStockLocation.mockRejectedValue(new Error('write failed'));
      await expect(
        caller().createStockLocation({ branchId: 'branch_1', name: 'Walk-in' })
      ).rejects.toThrow('write failed');
      expect(mocks.countStockLocations).toHaveBeenCalledOnce();
      expect(mocks.createStockLocation).toHaveBeenCalledOnce();
    });
  });

  // ── Capability gate ──────────────────────────────────────────────────────────

  it('rejects reads when ABAC denies inventory:read', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().listStockOnHand({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects wastage mutations when ABAC denies inventory:waste', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().postWastage({
        stockItemId: 'si_1',
        locationId: 'loc_1',
        reason: 'WASTAGE',
        quantity: '1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  // ── Strict input ─────────────────────────────────────────────────────────────

  it('rejects unknown fields on listStockOnHand', async () => {
    await expect(caller().listStockOnHand({ unknownField: true } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects unknown fields on createStockCount', async () => {
    mocks.createStockCount.mockResolvedValue({ id: 'c1' });
    await expect(
      caller().createStockCount({ locationId: 'loc_1', unknownField: true } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  // ── Stock on hand — Decimal-as-string serialization ──────────────────────────

  it('serializes onHand as string', async () => {
    mocks.listStockOnHand.mockResolvedValue([
      {
        stockItemId: 'si_1',
        ingredientName: 'Flour',
        locationId: 'loc_1',
        locationName: 'Dry Store',
        onHand: D('12.500000'),
        isNegative: false,
      },
    ]);
    const rows = await caller().listStockOnHand({});
    expect(rows[0]!.onHand).toBe('12.5');
    expect(rows[0]!.isNegative).toBe(false);
  });

  it('flags negative onHand', async () => {
    mocks.listStockOnHand.mockResolvedValue([
      {
        stockItemId: 'si_1',
        ingredientName: 'Flour',
        locationId: 'loc_1',
        locationName: 'Dry Store',
        onHand: D('-3.000000'),
        isNegative: true,
      },
    ]);
    const rows = await caller().listStockOnHand({});
    expect(rows[0]!.isNegative).toBe(true);
  });

  // ── Low-stock rule evaluation ─────────────────────────────────────────────────

  it('evaluateLowStockRules returns isTriggered flag and Decimal-as-string amounts', async () => {
    mocks.evaluateLowStockRules.mockResolvedValue([
      {
        ruleId: 'rule_1',
        stockItemId: 'si_1',
        locationId: 'loc_1',
        threshold: D('5'),
        onHand: D('3'),
        isTriggered: true,
      },
    ]);
    const flags = await caller().evaluateLowStockRules({});
    expect(flags[0]!.isTriggered).toBe(true);
    expect(flags[0]!.threshold).toBe('5');
    expect(flags[0]!.onHand).toBe('3');
  });

  // ── Count lifecycle ───────────────────────────────────────────────────────────

  it('createStockCount delegates to lib with actor staffProfileId', async () => {
    mocks.createStockCount.mockResolvedValue({ id: 'count_1', status: 'DRAFT' });
    await caller().createStockCount({ locationId: 'loc_1' });
    expect(mocks.createStockCount).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        locationId: 'loc_1',
        actor: expect.objectContaining({ staffProfileId: 'staff_test' }),
      })
    );
  });

  it('resolves the distinct active staff profile for every actor-bearing mutation family', async () => {
    mocks.createStockCount.mockResolvedValue({ id: 'count_1', status: 'DRAFT' });
    mocks.addStockCountLine.mockResolvedValue({ id: 'count_line_1' });
    mocks.submitStockCount.mockResolvedValue({ stockCountId: 'count_1' });
    mocks.postStockCount.mockResolvedValue({ stockCountId: 'count_1', movementsPosted: 0 });
    mocks.createStockTransfer.mockResolvedValue({ id: 'transfer_1', status: 'DRAFT' });
    mocks.addStockTransferLine.mockResolvedValue({ id: 'transfer_line_1' });
    mocks.completeStockTransfer.mockResolvedValue({
      stockTransferId: 'transfer_1',
      movementsPosted: 0,
    });
    mocks.postWastage.mockResolvedValue({ id: 'waste_1', quantity: D('-1') });
    mocks.postSaleReversal.mockResolvedValue({ id: 'reversal_1', quantity: D('1') });

    const api = caller();
    await api.createStockCount({ locationId: 'loc_1' });
    await api.addStockCountLine({
      stockCountId: 'count_1',
      stockItemId: 'item_1',
      countedQuantity: '1',
    });
    await api.submitStockCount({ stockCountId: 'count_1' });
    await api.postStockCount({ stockCountId: 'count_1' });
    await api.createStockTransfer({ sourceLocationId: 'loc_1', destinationLocationId: 'loc_1' });
    await api.addStockTransferLine({
      stockTransferId: 'transfer_1',
      stockItemId: 'item_1',
      quantity: '1',
    });
    await api.completeStockTransfer({ stockTransferId: 'transfer_1' });
    await api.postWastage({
      stockItemId: 'item_1',
      locationId: 'loc_1',
      reason: 'WASTAGE',
      quantity: '1',
    });
    await api.postSaleReversal({
      stockItemId: 'item_1',
      locationId: 'loc_1',
      quantity: '1',
    });

    for (const mutation of [
      mocks.createStockCount,
      mocks.submitStockCount,
      mocks.postStockCount,
      mocks.createStockTransfer,
      mocks.completeStockTransfer,
      mocks.postWastage,
      mocks.postSaleReversal,
    ]) {
      expect(mutation).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ actor: { staffProfileId: 'staff_test' } })
      );
    }
    expect(mocks.findStaffProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_test', status: 'ACTIVE' } })
    );
  });

  it.each(['absent', 'inactive', 'cross-tenant'])(
    '%s staff mapping fails before mutation',
    async () => {
      mocks.findStaffProfiles.mockResolvedValue([]);
      const api = caller();
      const attempts = [
        () => api.createStockCount({ locationId: 'loc_1' }),
        () =>
          api.addStockCountLine({
            stockCountId: 'count_1',
            stockItemId: 'item_1',
            countedQuantity: '1',
          }),
        () => api.submitStockCount({ stockCountId: 'count_1' }),
        () => api.postStockCount({ stockCountId: 'count_1' }),
        () =>
          api.createStockTransfer({ sourceLocationId: 'loc_1', destinationLocationId: 'loc_1' }),
        () =>
          api.addStockTransferLine({
            stockTransferId: 'transfer_1',
            stockItemId: 'item_1',
            quantity: '1',
          }),
        () => api.completeStockTransfer({ stockTransferId: 'transfer_1' }),
        () =>
          api.postWastage({
            stockItemId: 'item_1',
            locationId: 'loc_1',
            reason: 'WASTAGE',
            quantity: '1',
          }),
        () => api.postSaleReversal({ stockItemId: 'item_1', locationId: 'loc_1', quantity: '1' }),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      for (const mutation of [
        mocks.createStockCount,
        mocks.addStockCountLine,
        mocks.submitStockCount,
        mocks.postStockCount,
        mocks.createStockTransfer,
        mocks.addStockTransferLine,
        mocks.completeStockTransfer,
        mocks.postWastage,
        mocks.postSaleReversal,
      ]) {
        expect(mutation).not.toHaveBeenCalled();
      }
    }
  );

  it('cross-branch staff mapping fails before mutation without an assignment or configure grant', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(
      caller().postWastage({
        stockItemId: 'item_1',
        locationId: 'loc_2',
        reason: 'WASTAGE',
        quantity: '1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.postWastage).not.toHaveBeenCalled();
  });

  it('denies low-stock rule mutations for a branch the actor is not assigned to', async () => {
    mocks.findLowStockRule.mockResolvedValue({ location: { branchId: 'branch_2' } });

    const attempts = [
      () =>
        caller().createLowStockRule({ stockItemId: 'item_1', locationId: 'loc_2', threshold: '5' }),
      () => caller().updateLowStockRule({ id: 'rule_2', threshold: '6' }),
      () => caller().deleteLowStockRule({ id: 'rule_2' }),
    ];
    for (const attempt of attempts) {
      mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(attempt()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    expect(mocks.createLowStockRule).not.toHaveBeenCalled();
    expect(mocks.updateLowStockRule).not.toHaveBeenCalled();
    expect(mocks.deleteLowStockRule).not.toHaveBeenCalled();
  });

  it('rejects missing low-stock locations and rules before attempting a mutation', async () => {
    mocks.findStockLocation.mockResolvedValueOnce(null);
    mocks.findLowStockRule.mockResolvedValue(null);

    await expect(
      caller().createLowStockRule({
        stockItemId: 'item_1',
        locationId: 'loc_missing',
        threshold: '5',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller().updateLowStockRule({ id: 'rule_missing', threshold: '6' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller().deleteLowStockRule({ id: 'rule_missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect(mocks.createLowStockRule).not.toHaveBeenCalled();
    expect(mocks.updateLowStockRule).not.toHaveBeenCalled();
    expect(mocks.deleteLowStockRule).not.toHaveBeenCalled();
  });

  it('denies line injection into unauthorized count and transfer branches before mutation', async () => {
    mocks.findStockCount.mockResolvedValue({ location: { branchId: 'branch_2' } });
    mocks.findStockTransfer.mockResolvedValue({
      sourceLocation: { branchId: 'branch_1' },
      destinationLocation: { branchId: 'branch_2' },
    });
    mocks.can.mockResolvedValue(false);

    await expect(
      caller().addStockCountLine({
        stockCountId: 'count_2',
        stockItemId: 'item_1',
        countedQuantity: '1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller().addStockTransferLine({
        stockTransferId: 'transfer_2',
        stockItemId: 'item_1',
        quantity: '1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.addStockCountLine).not.toHaveBeenCalled();
    expect(mocks.addStockTransferLine).not.toHaveBeenCalled();
  });

  it('allows an active staff profile through an explicit branch assignment', async () => {
    mocks.findBranchAssignments.mockResolvedValue([{ branchId: 'branch_2' }]);
    mocks.postWastage.mockResolvedValue({ id: 'waste_1', quantity: D('-1') });

    await expect(
      caller().postWastage({
        stockItemId: 'item_1',
        locationId: 'loc_2',
        reason: 'WASTAGE',
        quantity: '1',
      })
    ).resolves.toEqual({ id: 'waste_1', quantity: '-1' });
    expect(mocks.postWastage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ actor: { staffProfileId: 'staff_test' } })
    );
  });

  it('submitStockCount returns stockCountId', async () => {
    mocks.submitStockCount.mockResolvedValue({ stockCountId: 'count_1' });
    const result = await caller().submitStockCount({ stockCountId: 'count_1' });
    expect(result.stockCountId).toBe('count_1');
  });

  // ── Transfer ─────────────────────────────────────────────────────────────────

  it('completeStockTransfer returns movementsPosted', async () => {
    mocks.completeStockTransfer.mockResolvedValue({ stockTransferId: 'tr_1', movementsPosted: 2 });
    const result = await caller().completeStockTransfer({ stockTransferId: 'tr_1' });
    expect(result.movementsPosted).toBe(2);
  });

  // ── Wastage ───────────────────────────────────────────────────────────────────

  it('postWastage serializes quantity as string', async () => {
    mocks.postWastage.mockResolvedValue({ id: 'mv_1', quantity: D('-2.000000') });
    const result = await caller().postWastage({
      stockItemId: 'si_1',
      locationId: 'loc_1',
      reason: 'WASTAGE',
      quantity: '2',
    });
    expect(result.quantity).toBe('-2');
  });
});
