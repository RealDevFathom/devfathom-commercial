import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  CommercialLimitError,
  createStaffProfileWithinCommercialLimit,
  enrollDeviceWithinCommercialLimits,
  setStaffProfileStatusWithinCommercialLimit,
  updateStaffProfileWithinCommercialLimit,
} from './commercial-limits';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const limits = {
  'pos.registeredDevices.max': 3,
  'pos.terminals.max': 2,
  'restaurant.operators.max': 2,
};

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  deviceCount: vi.fn(),
  deviceCreate: vi.fn(),
  staffCount: vi.fn(),
  staffFindFirst: vi.fn(),
  staffFindUnique: vi.fn(),
  staffCreate: vi.fn(),
  staffUpdate: vi.fn(),
  branchFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
}));

const tx = {
  $queryRaw: mocks.raw,
  restaurantRegisteredDevice: {
    count: mocks.deviceCount,
    create: mocks.deviceCreate,
  },
  restaurantStaffProfile: {
    count: mocks.staffCount,
    findFirst: mocks.staffFindFirst,
    findUnique: mocks.staffFindUnique,
    create: mocks.staffCreate,
    update: mocks.staffUpdate,
  },
  restaurantBranch: { findUnique: mocks.branchFindUnique },
  user: { findFirst: mocks.userFindFirst },
};

const db = {
  $transaction: (run: (inner: typeof tx) => unknown) => run(tx),
  ...tx,
} as unknown as ScopedDb;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.raw.mockResolvedValue([{ id: 'org_current' }]);
  mocks.deviceCount.mockResolvedValue(0);
  mocks.staffCount.mockResolvedValue(0);
  mocks.staffFindFirst.mockResolvedValue(null);
  mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1', status: 'SUSPENDED' });
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1' });
  mocks.userFindFirst.mockResolvedValue({ id: 'user_1' });
  mocks.deviceCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'device_new',
    status: 'ACTIVE',
    ...data,
  }));
  mocks.staffCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'staff_new',
    ...data,
  }));
  mocks.staffUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      displayName: 'Operator',
      ...data,
    })
  );
});

describe('device commercial ceilings', () => {
  it('enrolls below both limits after taking the tenant lock and preserves the branch', async () => {
    mocks.deviceCount.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    const result = await enrollDeviceWithinCommercialLimits(db, limits, {
      branchId: 'branch_2',
      name: 'Register 2',
      kind: 'POS',
    });

    expect(result.device).toMatchObject({ branchId: 'branch_2', kind: 'POS' });
    expect(mocks.raw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deviceCount.mock.invocationCallOrder[0]
    );
    expect(mocks.deviceCount).toHaveBeenNthCalledWith(1, { where: { status: 'ACTIVE' } });
    expect(mocks.deviceCount).toHaveBeenNthCalledWith(2, {
      where: { status: 'ACTIVE', kind: 'POS' },
    });
  });

  it('denies at the registered-device limit without a partial write', async () => {
    mocks.deviceCount.mockResolvedValue(3);
    await expect(
      enrollDeviceWithinCommercialLimits(db, limits, {
        branchId: 'branch_1',
        name: 'Blocked',
        kind: 'KDS',
      })
    ).rejects.toMatchObject({ reason: 'LIMIT_REACHED' });
    expect(mocks.deviceCreate).not.toHaveBeenCalled();
  });

  it('denies a POS enrollment at the terminal limit', async () => {
    mocks.deviceCount.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await expect(
      enrollDeviceWithinCommercialLimits(db, limits, {
        branchId: 'branch_1',
        name: 'Blocked POS',
        kind: 'POS',
      })
    ).rejects.toMatchObject({ reason: 'LIMIT_REACHED' });
    expect(mocks.deviceCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', { ...limits, 'pos.registeredDevices.max': 0 }],
    ['missing', { 'pos.terminals.max': 2 }],
    ['invalid', { ...limits, 'pos.registeredDevices.max': -1 }],
  ])('fails closed for %s registered-device configuration', async (_case, configured) => {
    await expect(
      enrollDeviceWithinCommercialLimits(db, configured, {
        branchId: 'branch_1',
        name: 'Blocked',
        kind: 'KDS',
      })
    ).rejects.toBeInstanceOf(CommercialLimitError);
    expect(mocks.deviceCreate).not.toHaveBeenCalled();
  });
});

describe('operator commercial ceiling', () => {
  it('creates an active operator below the tenant-wide limit', async () => {
    mocks.staffCount.mockResolvedValue(1);
    await expect(
      createStaffProfileWithinCommercialLimit(db, limits, {
        displayName: 'New operator',
        primaryBranchId: 'branch_1',
      })
    ).resolves.toMatchObject({ id: 'staff_new', status: 'ACTIVE' });
  });

  it('denies exact-limit creation and zero/missing/invalid configuration without writing', async () => {
    mocks.staffCount.mockResolvedValue(2);
    await expect(
      createStaffProfileWithinCommercialLimit(db, limits, { displayName: 'Blocked' })
    ).rejects.toMatchObject({ reason: 'LIMIT_REACHED' });
    await expect(
      createStaffProfileWithinCommercialLimit(
        db,
        { 'restaurant.operators.max': 0 },
        {
          displayName: 'Blocked',
        }
      )
    ).rejects.toMatchObject({ reason: 'LIMIT_REACHED' });
    await expect(
      createStaffProfileWithinCommercialLimit(db, {}, { displayName: 'Blocked' })
    ).rejects.toMatchObject({ reason: 'UNCONFIGURED' });
    await expect(
      createStaffProfileWithinCommercialLimit(
        db,
        { 'restaurant.operators.max': 1.5 },
        { displayName: 'Blocked' }
      )
    ).rejects.toMatchObject({ reason: 'UNCONFIGURED' });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });

  it('enforces both reactivation paths and leaves an already-active update count-neutral', async () => {
    mocks.staffCount.mockResolvedValue(2);
    await expect(
      setStaffProfileStatusWithinCommercialLimit(db, limits, 'staff_1', 'ACTIVE')
    ).rejects.toMatchObject({ reason: 'LIMIT_REACHED' });
    await expect(
      updateStaffProfileWithinCommercialLimit(db, limits, 'staff_1', { status: 'ACTIVE' })
    ).rejects.toMatchObject({ reason: 'LIMIT_REACHED' });
    expect(mocks.staffUpdate).not.toHaveBeenCalled();

    mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1', status: 'ACTIVE' });
    await expect(
      updateStaffProfileWithinCommercialLimit(db, limits, 'staff_1', {
        displayName: 'Renamed',
        status: 'ACTIVE',
      })
    ).resolves.toMatchObject({ displayName: 'Renamed', status: 'ACTIVE' });
  });

  it('allows inactive creation without consuming capacity', async () => {
    await expect(
      createStaffProfileWithinCommercialLimit(
        db,
        {},
        {
          displayName: 'Future operator',
          status: 'SUSPENDED',
        }
      )
    ).resolves.toMatchObject({ status: 'SUSPENDED' });
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.staffCount).not.toHaveBeenCalled();
  });
});
