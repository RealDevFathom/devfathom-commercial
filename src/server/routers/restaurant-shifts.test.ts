import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(async () => true) }));

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
vi.mock('@/lib/restaurant/shifts', () => ({
  ShiftError: class ShiftError extends Error {},
  cancelShift: vi.fn(),
  createShift: vi.fn(),
  listShifts: vi.fn(),
  updateShift: vi.fn(),
}));

import { restaurantShiftsRouter } from './restaurant-shifts';
import type { TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const shift = {
  id: 'shift_1',
  branchId: 'branch_1',
  staffProfileId: 'staff_1',
  startAt: new Date('2026-08-29T09:00:00Z'),
  endAt: new Date('2026-08-29T17:00:00Z'),
  status: 'SCHEDULED',
  clockedInAt: null,
  clockedOutAt: null,
};

const tx = {
  restaurantShift: { update: vi.fn() },
  restaurantShiftSwapRequest: { update: vi.fn() },
};
const db = {
  restaurantShift: { findFirst: vi.fn(), update: vi.fn() },
  restaurantShiftBreak: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  restaurantShiftSwapRequest: { findFirst: vi.fn(), create: vi.fn() },
  restaurantStaffProfile: { findFirst: vi.fn() },
  $transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)),
};

function caller() {
  return restaurantShiftsRouter.createCaller({
    db: db as unknown as ScopedDb,
    entitlements: {
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime('2026-08-29T09:12:00Z');
  db.restaurantShift.findFirst.mockResolvedValue({ ...shift });
  db.restaurantShiftBreak.findFirst.mockResolvedValue(null);
});

describe('restaurantShiftsRouter workforce attendance', () => {
  it('uses server time for clock-in and records a late arrival', async () => {
    db.restaurantShift.update.mockImplementation(async ({ data }) => data);
    await caller().clockIn({ id: 'shift_1', branchId: 'branch_1' });
    expect(db.restaurantShift.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          clockedInAt: new Date('2026-08-29T09:12:00Z'),
          lateArrivalAt: new Date('2026-08-29T09:12:00Z'),
        },
      })
    );
  });

  it('fails closed when the shift is not visible in the requested branch', async () => {
    db.restaurantShift.findFirst.mockResolvedValue(null);
    await expect(caller().clockIn({ id: 'shift_1', branchId: 'branch_2' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(db.restaurantShift.update).not.toHaveBeenCalled();
  });

  it('requires an active clock-in and prevents overlapping breaks', async () => {
    await expect(
      caller().startBreak({ id: 'shift_1', branchId: 'branch_1' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    db.restaurantShift.findFirst.mockResolvedValue({ ...shift, clockedInAt: shift.startAt });
    db.restaurantShiftBreak.findFirst.mockResolvedValue({ id: 'break_1' });
    await expect(
      caller().startBreak({ id: 'shift_1', branchId: 'branch_1' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('only permits the rostered operator to request a swap', async () => {
    await expect(
      caller().requestSwap({
        id: 'shift_1',
        branchId: 'branch_1',
        requestedByStaffProfileId: 'staff_2',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.restaurantShiftSwapRequest.create).not.toHaveBeenCalled();
  });

  it('approves a branch-scoped pending swap atomically', async () => {
    db.restaurantShiftSwapRequest.findFirst.mockResolvedValue({
      id: 'swap_1',
      shiftId: 'shift_1',
      replacementStaffProfileId: 'staff_2',
      shift,
    });
    tx.restaurantShiftSwapRequest.update.mockResolvedValue({ id: 'swap_1', status: 'APPROVED' });
    await caller().reviewSwap({ requestId: 'swap_1', branchId: 'branch_1', decision: 'APPROVED' });
    expect(tx.restaurantShift.update).toHaveBeenCalledWith({
      where: { id: 'shift_1' },
      data: { staffProfileId: 'staff_2' },
    });
  });
});
