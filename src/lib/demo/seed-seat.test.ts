import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  catalog: vi.fn(),
  operations: vi.fn(),
  inventory: vi.fn(),
  history: vi.fn(),
  reconcile: vi.fn(),
  minimums: {} as Record<string, number>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/demo/seed-bootstrap', () => ({
  createDemoRestaurantSeedContext: async (db: unknown) => ({ db }),
}));
vi.mock('@/lib/demo/seed-catalog', () => ({ seedDemoRestaurantCatalog: mocks.catalog }));
vi.mock('@/lib/demo/seed-inventory', () => ({
  seedDemoRestaurantInventory: mocks.inventory,
  reconcileDemoRestaurantInventory: mocks.reconcile,
}));
vi.mock('@/lib/demo/seed-history', () => ({ seedDemoRestaurantHistory: mocks.history }));
vi.mock('@/lib/demo/seed-operations', () => ({ seedDemoRestaurantOperations: mocks.operations }));

const COUNT_KEYS = [
  'branches',
  'floors',
  'tables',
  'modifierGroups',
  'modifierOptions',
  'products',
  'ingredients',
  'recipes',
  'recipeLines',
  'suppliers',
  'purchaseOrders',
  'purchaseReceipts',
  'stockBalances',
  'stockMovements',
  'stockCounts',
  'stockCountLines',
  'lowStockRules',
  'triggeredLowStockRules',
  'historicalBusinessDates',
  'historicalOrders',
  'historicalOrderLines',
  'bills',
  'settlements',
  'splitTenderOrders',
  'refunds',
  'dailyCloses',
  'dailyCloseCorrections',
  'liveOrders',
  'kdsTickets',
  'loyaltyCustomers',
  'promotions',
  'staff',
  'rosterShifts',
  'sopTemplates',
  'sopSteps',
  'sopOccurrences',
  'sopEvidence',
  'notifications',
] as const;

const identity = {
  seatNumber: 1,
  organizationId: 'org_demo_restaurant_seat_1',
  slug: 'demo-restaurant-seat-1',
  displayName: 'Demo Restaurant — Seat 1',
  managerUserId: 'user_demo_restaurant_seat_1_manager',
  managerEmail: 'manager.seat1@demo.devfathom.invalid',
};
const persisted = Object.fromEntries(COUNT_KEYS.map((key) => [key, 1])) as Record<
  (typeof COUNT_KEYS)[number],
  number
>;
Object.assign(persisted, {
  branches: 3,
  recipes: 25,
  historicalBusinessDates: 90,
  historicalOrders: 1_740,
  liveOrders: 3,
  loyaltyCustomers: 200,
});

vi.mock('@/lib/demo/seed-data', () => ({
  buildDemoRestaurantSeed: () => ({ identity, historicalBusinessDates: ['2026-09-03'] }),
  demoRestaurantSeedCounts: () => mocks.minimums,
}));

import { rebuildDemoRestaurantSeatInTransaction } from '@/lib/demo/seed-seat';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

beforeEach(() => {
  mocks.events.length = 0;
  vi.clearAllMocks();
  for (const key of COUNT_KEYS) mocks.minimums[key] = 0;
  mocks.catalog.mockImplementation(async () => {
    mocks.events.push('catalog');
    return {};
  });
  mocks.operations.mockImplementation(async () => {
    mocks.events.push('operations');
    return {
      managerStaffProfileId: 'manager_staff_actual',
      approverStaffProfileId: 'approver_staff_actual',
    };
  });
  mocks.inventory.mockImplementation(async () => {
    mocks.events.push('inventory');
    return { counts: { branches: 999 } };
  });
  mocks.history.mockImplementation(async () => {
    mocks.events.push('history');
  });
  mocks.reconcile.mockImplementation(async () => {
    mocks.events.push('reconcile');
  });
});

describe('rebuildDemoRestaurantSeatInTransaction', () => {
  it('runs history before final inventory reconciliation and returns DB counts only', async () => {
    const db = {
      $queryRawUnsafe: vi.fn(async () => {
        mocks.events.push('counts');
        return [persisted];
      }),
    } as unknown as ScopedDb;
    const result = await rebuildDemoRestaurantSeatInTransaction(db, {
      identity,
      now: new Date('2026-09-04T12:00:00.000Z'),
      managerStaffProfileId: 'manager_staff_actual',
      approverStaffProfileId: 'approver_staff_actual',
    });

    expect(mocks.events).toEqual([
      'catalog',
      'operations',
      'inventory',
      'history',
      'reconcile',
      'counts',
    ]);
    expect(result.counts).toEqual(persisted);
    expect(result.counts.branches).toBe(3);
  });

  it('accepts another generated window below 1,743 orders when DB counts meet its descriptor', async () => {
    const lowerWindow = { ...persisted, historicalOrders: 1_500, liveOrders: 2 };
    expect(lowerWindow.historicalOrders + lowerWindow.liveOrders).toBeLessThan(1_743);
    Object.assign(mocks.minimums, lowerWindow);
    const db = {
      $queryRawUnsafe: vi.fn(async () => [lowerWindow]),
    } as unknown as ScopedDb;

    const result = await rebuildDemoRestaurantSeatInTransaction(db, {
      identity,
      now: new Date('2026-10-14T12:00:00.000Z'),
      managerStaffProfileId: 'manager_staff_actual',
      approverStaffProfileId: 'approver_staff_actual',
    });
    expect(result.counts.historicalOrders).toBe(1_500);
  });
});
