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
  assertActorEligibleForBranch,
  assertAuthorizedStaffProfile,
  assertStaffProfileExists,
  resolveCapabilityBranchAuthorization,
  resolveStaffBranchAuthorization,
} from './staff-branch-authorization';

const user = {
  id: 'user_actor',
  role: 'EMPLOYEE',
  status: 'ACTIVE',
  organizationId: 'org_session',
};
const tenantId = 'org_1';
const database = () => ({
  restaurantBranch: { findMany: vi.fn(async () => [{ id: 'a' }, { id: 'b' }]) },
  restaurantStaffProfile: {
    findMany: vi.fn(async () => [
      {
        id: 'actor',
        primaryBranchId: null,
        jobRoles: [{ branchId: 'a' }, { branchId: 'b' }],
        directCapabilityGrants: [],
      },
    ]),
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
  it('fails closed when the active tenant is missing', async () => {
    mocks.can.mockResolvedValue(true);
    await expect(
      resolveStaffBranchAuthorization(database() as never, user, null)
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('not authorized'),
    });
    await expect(
      resolveCapabilityBranchAuthorization(database() as never, user, 'devices:manage', {
        organizationId: '',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('gives restaurant:configure administrators every active in-tenant branch', async () => {
    mocks.can.mockResolvedValue(true);
    const db = database();
    await expect(
      resolveStaffBranchAuthorization(db as never, user, tenantId)
    ).resolves.toMatchObject({
      organizationWide: true,
      branchIds: ['a', 'b'],
    });
    expect(db.restaurantBranch.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', active: true },
      select: { id: true },
    });
  });

  it('keeps only effective staff:manage branches, including DENY subtraction', async () => {
    await expect(
      resolveStaffBranchAuthorization(database() as never, user, tenantId)
    ).resolves.toMatchObject({
      actorStaffProfileId: 'actor',
      organizationWide: false,
      branchIds: ['a'],
    });
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });

  it('resolves a device scope with devices:manage rather than staff:manage', async () => {
    mocks.resolve.mockImplementation(
      async (_db, _staff, branch) => new Set(branch === 'b' ? ['devices:manage'] : [])
    );

    await expect(
      resolveCapabilityBranchAuthorization(database() as never, user, 'devices:manage', {
        organizationId: tenantId,
        requireExactlyOneActiveActor: true,
      })
    ).resolves.toMatchObject({ actorStaffProfileId: 'actor', branchIds: ['b'] });
  });

  it('selects the lowest active profile id deterministically when more than one exists', async () => {
    const db = database();
    mocks.resolve.mockResolvedValue(new Set(['devices:manage']));
    db.restaurantStaffProfile.findMany.mockResolvedValueOnce([
      {
        id: 'actor-a',
        primaryBranchId: null,
        jobRoles: [{ branchId: 'a' }],
        directCapabilityGrants: [],
      },
      {
        id: 'actor-b',
        primaryBranchId: null,
        jobRoles: [{ branchId: 'b' }],
        directCapabilityGrants: [],
      },
    ]);

    await expect(
      resolveCapabilityBranchAuthorization(db as never, user, 'devices:manage', {
        organizationId: tenantId,
      })
    ).resolves.toMatchObject({ actorStaffProfileId: 'actor-a' });
    expect(db.restaurantStaffProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: 'asc' }, take: 2 })
    );
  });

  it('makes an organization-wide actor eligible on every branch, including unlinked ones', async () => {
    mocks.can.mockResolvedValue(true);
    const authorization = await resolveCapabilityBranchAuthorization(
      database() as never,
      user,
      'devices:manage',
      { organizationId: tenantId, requireExactlyOneActiveActor: true }
    );

    expect(() => assertActorEligibleForBranch(authorization, 'a')).not.toThrow();
    expect(() => assertActorEligibleForBranch(authorization, 'unlinked')).not.toThrow();
  });

  it('keeps a branch-scoped actor ineligible on a branch the actor is not linked to', async () => {
    mocks.resolve.mockImplementation(async () => new Set(['devices:manage']));
    const authorization = await resolveCapabilityBranchAuthorization(
      database() as never,
      user,
      'devices:manage',
      { organizationId: tenantId, requireExactlyOneActiveActor: true }
    );

    expect(() => assertActorEligibleForBranch(authorization, 'a')).not.toThrow();
    expect(() => assertActorEligibleForBranch(authorization, 'unlinked')).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' })
    );
  });

  it('fails closed when an exact active actor mapping is absent or ambiguous', async () => {
    const missing = database();
    missing.restaurantStaffProfile.findMany.mockResolvedValueOnce([]);
    await expect(
      resolveCapabilityBranchAuthorization(missing as never, user, 'devices:manage', {
        organizationId: tenantId,
        requireExactlyOneActiveActor: true,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const ambiguous = database();
    ambiguous.restaurantStaffProfile.findMany.mockResolvedValueOnce([
      { id: 'actor-a' },
      { id: 'actor-b' },
    ] as never);
    await expect(
      resolveCapabilityBranchAuthorization(ambiguous as never, user, 'devices:manage', {
        organizationId: tenantId,
        requireExactlyOneActiveActor: true,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns one error for unauthorized, arbitrary, and missing identifiers', async () => {
    const db = database();
    const authorization = await resolveStaffBranchAuthorization(db as never, user, tenantId);
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

  it('denies a global mutation when any target branch is unauthorized', async () => {
    const db = database();
    db.restaurantStaffProfile.findUnique.mockResolvedValueOnce({
      primaryBranchId: 'b',
      jobRoles: [{ branchId: 'a' }, { branchId: 'b' }],
      directCapabilityGrants: [],
    } as never);
    const authorization = await resolveStaffBranchAuthorization(db as never, user, tenantId);
    await expect(
      assertAuthorizedStaffProfile(db as never, authorization, 'target')
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(assertStaffProfileExists(db as never, 'target')).resolves.toBeUndefined();
  });

  it('allows a global mutation when every target branch is authorized', async () => {
    const db = database();
    db.restaurantStaffProfile.findUnique.mockResolvedValueOnce({
      primaryBranchId: 'a',
      jobRoles: [{ branchId: 'a' }, { branchId: 'b' }],
      directCapabilityGrants: [],
    } as never);
    mocks.resolve.mockResolvedValue(new Set(['staff:manage']));
    const authorization = await resolveStaffBranchAuthorization(db as never, user, tenantId);
    await expect(
      assertAuthorizedStaffProfile(db as never, authorization, 'target')
    ).resolves.toBeUndefined();
  });
});
