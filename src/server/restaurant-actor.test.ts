import { describe, expect, it, vi } from 'vitest';
import { resolveRestaurantActor } from './restaurant-actor';
import { can, subjectFromSession } from '@/lib/abac';
import { ALL_ACTIONS } from '@/lib/abac/policies';

function fixture(role = 'EMPLOYEE', key = 'cashier') {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        role,
        status: 'ACTIVE',
        organizationRole: { key, permissions: [] },
        permissionOverrides: [],
      }),
    },
    restaurantStaffProfile: {
      findMany: vi.fn().mockResolvedValue([{ id: 'session-staff', primaryBranchId: 'home' }]),
    },
    restaurantBranchAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    restaurantBranch: {
      findMany: vi
        .fn()
        .mockImplementation(async ({ where }) => where.id.in.map((id: string) => ({ id }))),
    },
  };
  const user = { id: 'session-user', role, organizationId: 'tenant', status: 'ACTIVE' };
  return {
    db,
    user,
    ctx: {
      db,
      session: { user },
      entitlements: { organizationId: 'tenant' },
      requestMeta: { ip: null },
    },
  };
}

describe('owner/admin capability and automatic branch access', () => {
  it.each([
    ['ADMIN', 'cashier'],
    ['EMPLOYEE', 'owner'],
  ])('%s / %s has every tenant capability and needs no branch assignment', async (role, key) => {
    const { db, user, ctx } = fixture(role, key);
    for (const action of ALL_ACTIONS) {
      expect(await can(subjectFromSession(user), action, undefined, { db: db as never })).toBe(
        true
      );
    }
    await expect(resolveRestaurantActor(ctx as never, ['remote'])).resolves.toEqual({
      staffProfileId: 'session-staff',
    });
    expect(db.restaurantBranch.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['remote'] }, organizationId: 'tenant', active: true },
      select: { id: true },
    });
  });
  it('recognizes an active owner job-role holding as branch eligibility', async () => {
    const { db, ctx } = fixture();
    db.restaurantStaffProfile.findMany.mockResolvedValue([
      {
        id: 'session-staff',
        primaryBranchId: 'home',
        jobRoles: [{ branchId: 'owned-branch' }],
        directCapabilityGrants: [],
      },
    ] as never);
    await expect(resolveRestaurantActor(ctx as never, ['owned-branch'])).resolves.toEqual({
      staffProfileId: 'session-staff',
    });
  });
  it('denies a regular user at another branch', async () => {
    await expect(resolveRestaurantActor(fixture().ctx as never, ['remote'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('does not grant an owner access to a foreign or inactive branch', async () => {
    const { db, ctx } = fixture('ADMIN');
    db.restaurantBranch.findMany.mockResolvedValue([]);
    await expect(resolveRestaurantActor(ctx as never, ['foreign'])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
  it('does not trust a session role over the persisted identity', async () => {
    const { db, user } = fixture();
    await expect(
      can(subjectFromSession({ ...user, role: 'ADMIN' }), 'sop:verify', undefined, {
        db: db as never,
      })
    ).resolves.toBe(false);
  });
});

describe('terminal owner capabilities', () => {
  it.each([
    ['ADMIN', 'cashier'],
    ['EMPLOYEE', 'owner'],
  ])('grants %s / %s all capabilities across branches', async (role, key) => {
    const { operatorHasCapability } = await import('@/lib/restaurant/checkout-routes');
    const db = {
      restaurantStaffJobRole: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStaffCapabilityGrant: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStaffProfile: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'ACTIVE',
          primaryBranchId: 'home',
          user: { role, status: 'ACTIVE', organizationRole: { key } },
          jobRoles: [],
          directCapabilityGrants: [],
        }),
      },
    };
    expect(
      await operatorHasCapability(db as never, 'owner', 'future:capability', new Date(), 'remote')
    ).toBe(true);
  });
  it('grants a branch owner all capabilities only within their held branch', async () => {
    const { operatorHasCapability } = await import('@/lib/restaurant/checkout-routes');
    const db = {
      restaurantStaffJobRole: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStaffCapabilityGrant: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStaffProfile: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'ACTIVE',
          primaryBranchId: 'home',
          user: null,
          jobRoles: [{ branchId: 'owned', jobRole: { key: 'owner', active: true } }],
          directCapabilityGrants: [],
        }),
      },
    };
    expect(
      await operatorHasCapability(db as never, 'owner', 'future:capability', new Date(), 'owned')
    ).toBe(true);
    expect(
      await operatorHasCapability(
        db as never,
        'owner',
        'future:capability',
        new Date(),
        'unassigned'
      )
    ).toBe(false);
  });
});
