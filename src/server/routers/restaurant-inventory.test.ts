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
  findStaffProfile: vi.fn(),
  findBranchAssignments: vi.fn(),
  findStockLocation: vi.fn(),
  findStockCount: vi.fn(),
  findStockTransfer: vi.fn(),
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
  restaurantStaffProfile: { findFirst: mocks.findStaffProfile },
  restaurantBranchAssignment: { findMany: mocks.findBranchAssignments },
  restaurantStockLocation: { findUnique: mocks.findStockLocation },
  restaurantStockCount: { findUnique: mocks.findStockCount },
  restaurantStockTransfer: { findUnique: mocks.findStockTransfer },
} as unknown as ScopedDb;

function caller(canOverride?: boolean) {
  if (canOverride !== undefined) mocks.can.mockResolvedValue(canOverride);
  return restaurantInventoryRouter.createCaller({
    db,
    entitlements: {
      enabledModules: ['restaurant-pos'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
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
  mocks.findStaffProfile.mockResolvedValue({ id: 'staff_test', primaryBranchId: 'branch_1' });
  mocks.findBranchAssignments.mockResolvedValue([]);
  mocks.findStockLocation.mockImplementation(async ({ where }) => ({
    branchId: where.id === 'loc_2' ? 'branch_2' : 'branch_1',
  }));
  mocks.findStockCount.mockResolvedValue({ location: { branchId: 'branch_1' } });
  mocks.findStockTransfer.mockResolvedValue({
    sourceLocation: { branchId: 'branch_1' },
    destinationLocation: { branchId: 'branch_1' },
  });
});

describe('restaurantInventoryRouter', () => {
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
    mocks.submitStockCount.mockResolvedValue({ stockCountId: 'count_1' });
    mocks.postStockCount.mockResolvedValue({ stockCountId: 'count_1', movementsPosted: 0 });
    mocks.createStockTransfer.mockResolvedValue({ id: 'transfer_1', status: 'DRAFT' });
    mocks.completeStockTransfer.mockResolvedValue({
      stockTransferId: 'transfer_1',
      movementsPosted: 0,
    });
    mocks.postWastage.mockResolvedValue({ id: 'waste_1', quantity: D('-1') });
    mocks.postSaleReversal.mockResolvedValue({ id: 'reversal_1', quantity: D('1') });

    const api = caller();
    await api.createStockCount({ locationId: 'loc_1' });
    await api.submitStockCount({ stockCountId: 'count_1' });
    await api.postStockCount({ stockCountId: 'count_1' });
    await api.createStockTransfer({ sourceLocationId: 'loc_1', destinationLocationId: 'loc_1' });
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
    expect(mocks.findStaffProfile).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_test', status: 'ACTIVE' } })
    );
  });

  it.each(['absent', 'inactive', 'cross-tenant'])(
    '%s staff mapping fails before mutation',
    async () => {
      mocks.findStaffProfile.mockResolvedValue(null);
      const api = caller();
      const attempts = [
        () => api.createStockCount({ locationId: 'loc_1' }),
        () => api.submitStockCount({ stockCountId: 'count_1' }),
        () => api.postStockCount({ stockCountId: 'count_1' }),
        () =>
          api.createStockTransfer({ sourceLocationId: 'loc_1', destinationLocationId: 'loc_1' }),
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
        mocks.submitStockCount,
        mocks.postStockCount,
        mocks.createStockTransfer,
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
