import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  activate: vi.fn(),
  provision: vi.fn(),
  reset: vi.fn(),
  schedule: vi.fn(),
  syncCatalog: vi.fn(),
  withPlatformDb: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/demo/seed-bootstrap', () => ({
  provisionDemoRestaurantSeatInTransaction: mocks.provision,
}));
vi.mock('@/lib/demo/seed-data', () => ({
  demoSeatIdentity: (seat: number) => ({
    seatNumber: seat,
    organizationId: `org_demo_restaurant_seat_${seat}`,
    slug: `demo-restaurant-seat-${seat}`,
    displayName: `Demo Restaurant — Seat ${seat}`,
    managerUserId: `user_demo_restaurant_seat_${seat}_manager`,
    managerEmail: `manager.seat${seat}@demo.devfathom.invalid`,
  }),
  parseDemoSeatCount: (value: number | undefined) => value ?? 5,
}));
vi.mock('@/lib/demo/jobs', () => ({
  DEMO_RESET_TRANSACTION_TIMEOUT_MS: 1_800_000,
  scheduleDemoReset: mocks.schedule,
}));
vi.mock('@/lib/demo/reset', () => ({ resetDemoSeatInTransaction: mocks.reset }));
vi.mock('@/lib/platform/commands', () => ({
  activateDemoRestaurantOrganizationInTransaction: mocks.activate,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb,
  withTenantDb: mocks.withTenantDb,
}));
vi.mock('../../../prisma/catalog-sync', () => ({ syncPlatformCatalog: mocks.syncCatalog }));

import { resetDemoRestaurantSeat, seedDemoRestaurantSeats } from '@/lib/demo/seed';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const RESULT = {
  organizationId: 'org_demo_restaurant_seat_1',
  seatNumber: 1,
  managerUserId: 'user_demo_restaurant_seat_1_manager',
  managerEmail: 'manager.seat1@demo.devfathom.invalid',
  counts: {},
};
const db = {
  $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
    if (sql.join('').includes('restaurant_tax_refund_allocation_cap')) {
      mocks.events.push('constraint-flush');
    }
  }),
  $queryRawUnsafe: vi.fn(async (sql: string) => {
    mocks.events.push(
      sql.includes("current_organization_id', ''") ? 'platform-scope' : 'tenant-scope'
    );
  }),
};

beforeEach(() => {
  mocks.events.length = 0;
  vi.clearAllMocks();
  mocks.provision.mockImplementation(async () => {
    mocks.events.push('provision');
  });
  mocks.activate.mockImplementation(async () => {
    mocks.events.push('activate');
  });
  mocks.reset.mockImplementation(async () => {
    mocks.events.push('reset');
    return RESULT;
  });
  mocks.schedule.mockImplementation(async () => {
    mocks.events.push('schedule');
  });
  mocks.syncCatalog.mockImplementation(async () => {
    mocks.events.push('catalog-sync');
  });
  mocks.withPlatformDb.mockImplementation(async (run) => {
    mocks.events.push('platform-transaction:begin');
    try {
      const result = await run(db);
      mocks.events.push('platform-transaction:commit');
      return result;
    } catch (error) {
      mocks.events.push('platform-transaction:rollback');
      throw error;
    }
  });
  mocks.withTenantDb.mockImplementation(async (_organizationId, run) => {
    mocks.events.push('transaction:begin');
    try {
      return await run(db);
    } catch (error) {
      mocks.events.push('transaction:rollback');
      throw error;
    }
  });
});

describe('restaurant demo seed transactions', () => {
  it('commits catalog first, then provisions and activates each seat in one transaction', async () => {
    await expect(seedDemoRestaurantSeats({ seats: 1, now: NOW })).resolves.toEqual([RESULT]);
    expect(mocks.events).toEqual([
      'platform-transaction:begin',
      'catalog-sync',
      'platform-transaction:commit',
      'platform-transaction:begin',
      'provision',
      'tenant-scope',
      'reset',
      'schedule',
      'constraint-flush',
      'platform-scope',
      'activate',
      'platform-transaction:commit',
    ]);
    expect(mocks.withPlatformDb).toHaveBeenCalledTimes(2);
    expect(db.$executeRaw.mock.calls[0]?.[0].join('')).toBe(
      'SET CONSTRAINTS restaurant_tax_refund_allocation_cap IMMEDIATE'
    );
    expect(mocks.withPlatformDb.mock.calls[0]).toHaveLength(1);
    expect(mocks.withPlatformDb.mock.calls[1]).toEqual([
      expect.any(Function),
      {
        maxWait: 30_000,
        timeout: 1_800_000,
      },
    ]);
  });

  it('rolls the single seat transaction back when final activation fails', async () => {
    mocks.activate.mockImplementationOnce(async () => {
      mocks.events.push('activate');
      throw new Error('activation failed');
    });
    await expect(seedDemoRestaurantSeats({ seats: 1, now: NOW })).rejects.toThrow(
      'activation failed'
    );
    expect(mocks.events).toEqual([
      'platform-transaction:begin',
      'catalog-sync',
      'platform-transaction:commit',
      'platform-transaction:begin',
      'provision',
      'tenant-scope',
      'reset',
      'schedule',
      'constraint-flush',
      'platform-scope',
      'activate',
      'platform-transaction:rollback',
    ]);
    expect(mocks.withPlatformDb).toHaveBeenCalledTimes(2);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('validates input before catalog mutation', async () => {
    await expect(seedDemoRestaurantSeats({ seats: 1, now: new Date(Number.NaN) })).rejects.toThrow(
      /valid date/
    );
    expect(mocks.syncCatalog).not.toHaveBeenCalled();
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
  });

  it('rejects the manual wrapper transaction when rebuild fails', async () => {
    mocks.reset.mockImplementationOnce(async () => {
      mocks.events.push('reset');
      throw new Error('builder failed');
    });
    await expect(
      resetDemoRestaurantSeat({ organizationId: RESULT.organizationId, now: NOW })
    ).rejects.toThrow('builder failed');
    expect(mocks.events).toEqual(['transaction:begin', 'reset', 'transaction:rollback']);
    expect(mocks.withTenantDb).toHaveBeenCalledWith(RESULT.organizationId, expect.any(Function), {
      maxWait: 30_000,
      timeout: 1_800_000,
    });
  });
});
