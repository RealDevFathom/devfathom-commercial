import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(), resolve: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/restaurant/job-roles', () => ({ resolveStaffCapabilities: mocks.resolve }));

import {
  assertAuthorizedBranch,
  assertAuthorizedStaffProfile,
  resolveStaffBranchAuthorization,
} from './staff-branch-authorization';

const user = { id: 'user_actor', role: 'EMPLOYEE', status: 'ACTIVE' };
const database = () => ({
  restaurantBranch: { findMany: vi.fn(async () => [{ id: 'a' }, { id: 'b' }]) },
  restaurantStaffProfile: {
    findFirst: vi.fn(async () => ({
      id: 'actor',
      jobRoles: [{ branchId: 'a' }, { branchId: 'b' }],
      directCapabilityGrants: [],
    })),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === 'target'
        ? { primaryBranchId: 'a', jobRoles: [], directCapabilityGrants: [] }
        : null
    ),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(false);
  mocks.resolve.mockImplementation(
    async (_db, _staff, branch) => new Set(branch === 'a' ? ['staff:manage'] : [])
  );
});

describe('staff branch authorization', () => {
  it('gives restaurant:configure administrators every in-tenant branch', async () => {
    mocks.can.mockResolvedValue(true);
    await expect(resolveStaffBranchAuthorization(database() as never, user)).resolves.toMatchObject(
      {
        organizationWide: true,
        branchIds: ['a', 'b'],
      }
    );
  });

  it('keeps only effective staff:manage branches, including DENY subtraction', async () => {
    await expect(resolveStaffBranchAuthorization(database() as never, user)).resolves.toMatchObject(
      {
        actorStaffProfileId: 'actor',
        organizationWide: false,
        branchIds: ['a'],
      }
    );
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });

  it('returns one error for unauthorized, arbitrary, and missing identifiers', async () => {
    const db = database();
    const authorization = await resolveStaffBranchAuthorization(db as never, user);
    const expected = { code: 'FORBIDDEN', message: expect.stringContaining('not authorized') };
    expect(() => assertAuthorizedBranch(authorization, 'b')).toThrowError(
      expect.objectContaining(expected)
    );
    expect(() => assertAuthorizedBranch(authorization, 'arbitrary')).toThrowError(
      expect.objectContaining(expected)
    );
    await expect(
      assertAuthorizedStaffProfile(db as never, authorization, 'missing')
    ).rejects.toMatchObject(expected);
  });

  it('preserves a target with distinct holdings at two branches', async () => {
    const db = database();
    db.restaurantStaffProfile.findUnique.mockResolvedValueOnce({
      primaryBranchId: 'b',
      jobRoles: [{ branchId: 'a' }, { branchId: 'b' }],
      directCapabilityGrants: [],
    });
    const authorization = await resolveStaffBranchAuthorization(db as never, user);
    await expect(
      assertAuthorizedStaffProfile(db as never, authorization, 'target')
    ).resolves.toBeUndefined();
  });
});
