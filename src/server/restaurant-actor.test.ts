import { describe, expect, it, vi } from 'vitest';
import { resolveRestaurantActor } from './restaurant-actor';
import { can, subjectFromSession } from '@/lib/abac';

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

const ORG_ROLE_ONLY_ACTIONS = [
  'pharmacy:dispense',
  'pharmacy:safety',
  'pharmacy:catalogue-review',
  'sop:verify',
  'restaurant:configure',
  'money:read',
  'staff:manage',
  'hotel:folio',
] as const;

describe('owner/admin capability and automatic branch access', () => {
  it.each([
    ['ADMIN', 'cashier'],
    ['ADMIN', 'owner'],
    ['EMPLOYEE', 'owner'],
    ['EMPLOYEE', 'owner-operator'],
    ['EMPLOYEE', 'admin'],
  ])(
    '%s / %s gets no implicit capability or branch access without explicit grants',
    async (role, key) => {
      const { db, user, ctx } = fixture(role, key);
      for (const action of ORG_ROLE_ONLY_ACTIONS) {
        expect(await can(subjectFromSession(user), action, undefined, { db: db as never })).toBe(
          false
        );
      }
      expect(
        await can(
          subjectFromSession(user),
          'resignation:review',
          { type: 'Resignation', userId: user.id, status: 'PENDING' },
          { db: db as never }
        )
      ).toBe(false);
      await expect(resolveRestaurantActor(ctx as never, ['remote'])).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  );
  it('gives automatic branch access only through an explicit restaurant:configure grant', async () => {
    const { db, user, ctx } = fixture('EMPLOYEE', 'owner');
    db.user.findUnique.mockResolvedValue({
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      organizationRole: { key: 'owner', permissions: [{ capability: '*', effect: 'ALLOW' }] },
      permissionOverrides: [],
    });
    expect(
      await can(subjectFromSession(user), 'restaurant:configure', undefined, { db: db as never })
    ).toBe(true);
    // Wildcards never grant exact-only pharmacy decisions.
    expect(
      await can(subjectFromSession(user), 'pharmacy:dispense', undefined, { db: db as never })
    ).toBe(false);
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
  it('does not treat a DENY capability override as branch eligibility', async () => {
    const { db, ctx } = fixture();
    await resolveRestaurantActor(ctx as never, ['home']);
    const select = db.restaurantStaffProfile.findMany.mock.calls[0]![0].select;
    expect(select.directCapabilityGrants.where).toEqual({ effect: 'ALLOW' });
  });
  it('denies a regular user at another branch', async () => {
    await expect(resolveRestaurantActor(fixture().ctx as never, ['remote'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('does not grant an owner access to a foreign or inactive branch', async () => {
    const { db, ctx } = fixture('ADMIN');
    // Even an explicit tenant-wide restaurant:configure grant only lifts the
    // branch-link requirement; the branch must still be active in this tenant.
    db.user.findUnique.mockResolvedValue({
      role: 'ADMIN',
      status: 'ACTIVE',
      organizationRole: {
        key: 'owner',
        permissions: [{ capability: 'restaurant:configure', effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    });
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
  ])('does not grant %s / %s every capability across branches', async (role, key) => {
    const { operatorHasCapability } = await import('@/lib/restaurant/checkout-routes');
    const db = {
      restaurantStaffJobRole: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStaffCapabilityGrant: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStaffProfile: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'ACTIVE',
          primaryBranchId: 'home',
          user: { role, status: 'ACTIVE', organizationRole: { key, permissions: [] } },
          jobRoles: [],
          directCapabilityGrants: [],
        }),
      },
    };
    for (const branch of ['remote', 'home']) {
      expect(
        await operatorHasCapability(db as never, 'owner', 'future:capability', new Date(), branch)
      ).toBe(false);
    }
  });
  it('does not treat an owner job-role key as granting every capability', async () => {
    const { operatorHasCapability } = await import('@/lib/restaurant/checkout-routes');
    const db = {
      restaurantStaffJobRole: {
        findMany: vi.fn().mockResolvedValue([{ jobRole: { capabilities: [] } }]),
      },
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
    ).toBe(false);
  });
});
