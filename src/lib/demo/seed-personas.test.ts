import { beforeEach, describe, expect, it, vi } from 'vitest';
import { can, subjectFromSession } from '@/lib/abac';
import { ALL_ACTIONS, type Action } from '@/lib/abac/policies';
import { operatorHasCapability } from '@/lib/restaurant/checkout-routes';
import { RESTAURANT_CAPABILITIES, RESTAURANT_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import {
  DEMO_PERSONAS,
  DEMO_PERSONA_KEYS,
  demoPersonaUserId,
  demoPersonaEmail,
  demoPersonaUserRole,
} from './personas';

const mocks = vi.hoisted(() => ({
  createStaff: vi.fn(),
  updateStaff: vi.fn(),
  createRole: vi.fn(),
  grantRole: vi.fn(),
  enroll: vi.fn(),
}));
vi.mock('@/lib/restaurant/staff', () => ({
  createStaffProfile: mocks.createStaff,
  updateStaffProfile: mocks.updateStaff,
}));
vi.mock('@/lib/restaurant/job-roles', () => ({
  resolveStaffCapabilityDecision: async () => ({ denied: new Set(), effective: new Set() }),
  createJobRole: mocks.createRole,
  grantJobRole: mocks.grantRole,
}));
vi.mock('@/lib/restaurant/devices', () => ({ enrollDevice: mocks.enroll }));
import { seedDemoPersonas, demoPersonaExtraCapabilities } from './seed-personas';
import { buildDemoRestaurantSeed } from './seed-data';

const seed = buildDemoRestaurantSeed(new Date('2026-09-04T12:00:00Z'), 1);
const catalog = {
  branch: Object.fromEntries(seed.branches.map((branch) => [branch.id, branch.id])),
  station: { [`${seed.branches[0]!.id}:HOT_KITCHEN`]: 'station_hot' },
};
function database() {
  return {
    organization: {
      findFirst: vi.fn().mockResolvedValue({
        id: seed.identity.organizationId,
        slug: seed.identity.slug,
        isDemo: true,
        vertical: 'RESTAURANT',
        deploymentMode: 'SHARED',
      }),
    },
    organizationRole: {
      findUnique: vi
        .fn()
        .mockImplementation(async ({ where }) => ({ id: where.organizationId_key.key })),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    userPermissionOverride: { upsert: vi.fn() },
    restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue([]) },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createStaff.mockImplementation(async (_db, input) => ({
    ...input,
    id: `staff_${input.userId}`,
  }));
  mocks.createRole.mockImplementation(async (_db, input) => ({ ...input, id: input.key }));
});

describe('demo persona seed', () => {
  it('creates distinct passwordless identities using existing departments and roles, and separate primary-branch terminals', async () => {
    const db = database();
    const staff = await seedDemoPersonas(db as never, seed, catalog as never, 'manager_staff');
    expect(Object.keys(staff).sort()).toEqual([...DEMO_PERSONA_KEYS].sort());
    expect(new Set(Object.values(staff)).size).toBe(7);
    expect(db.user.create).toHaveBeenCalledTimes(6);
    for (const persona of DEMO_PERSONA_KEYS.filter((key) => key !== 'manager')) {
      expect(db.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: demoPersonaUserId(1, persona),
          email: demoPersonaEmail(1, persona),
          password: null,
          role: demoPersonaUserRole(persona),
          department: DEMO_PERSONAS[persona].department,
          organizationRoleId: DEMO_PERSONAS[persona].roleKey,
        }),
      });
    }
    expect(
      mocks.enroll.mock.calls.map(([, input]) => [input.name, input.kind, input.branchId])
    ).toEqual([
      ['Demo owner POS S1', 'POS', seed.branches[0]!.id],
      ['Demo owner KDS S1', 'KDS', seed.branches[0]!.id],
      ['Demo cashier POS S1', 'POS', seed.branches[0]!.id],
      ['Demo waiter POS S1', 'POS', seed.branches[0]!.id],
      ['Demo kitchen KDS S1', 'KDS', seed.branches[0]!.id],
    ]);
    for (const [, role] of mocks.createRole.mock.calls) {
      expect(role.capabilities).not.toContain('*');
      expect(
        role.capabilities.every((capability: string) =>
          RESTAURANT_CAPABILITIES.includes(capability)
        )
      ).toBe(true);
    }
    expect(
      mocks.grantRole.mock.calls
        .filter(([, grant]) => grant.staffProfileId === staff.finance)
        .map(([, grant]) => grant.branchId)
    ).toEqual([seed.branches[0]!.id]);
  });

  it('reuses retained users and staff after reset while rebuilding branch bindings', async () => {
    const db = database();
    db.user.findUnique.mockImplementation(async ({ where }) => {
      const persona = DEMO_PERSONA_KEYS.find((key) => demoPersonaUserId(1, key) === where.id)!;
      return {
        id: where.id,
        organizationId: seed.identity.organizationId,
        email: demoPersonaEmail(1, persona),
        password: null,
        status: 'ACTIVE',
        role: demoPersonaUserRole(persona),
        organizationRoleId: DEMO_PERSONAS[persona].roleKey,
      };
    });
    db.restaurantStaffProfile.findMany.mockImplementation(async ({ where }) => [
      {
        id: `retained_${where.OR[0].userId}`,
        userId: where.OR[0].userId,
        email: where.OR[1].email,
      },
    ]);
    const staff = await seedDemoPersonas(db as never, seed, catalog as never, 'manager_staff');
    expect(db.user.create).not.toHaveBeenCalled();
    expect(mocks.createStaff).not.toHaveBeenCalled();
    expect(mocks.updateStaff).toHaveBeenCalledTimes(6);
    expect(staff.waiter).toBe('retained_user_demo_restaurant_seat_1_waiter');
  });

  it.each([
    { isDemo: false },
    { id: 'org_production' },
    { slug: 'production' },
    { deploymentMode: 'DEDICATED' },
    { vertical: 'AGENCY' },
  ])('refuses to seed an invalid tenant %j', async (change) => {
    const db = database();
    db.organization.findFirst.mockResolvedValue({
      id: seed.identity.organizationId,
      slug: seed.identity.slug,
      isDemo: true,
      vertical: 'RESTAURANT',
      deploymentMode: 'SHARED',
      ...change,
    });
    await expect(
      seedDemoPersonas(db as never, seed, catalog as never, 'manager_staff')
    ).rejects.toThrow('canonical shared');
    expect(db.user.create).not.toHaveBeenCalled();
    expect(mocks.createStaff).not.toHaveBeenCalled();
  });

  it('rejects occupied user and staff identities', async () => {
    const db = database();
    db.user.findUnique.mockResolvedValue({ organizationId: 'org_production' });
    await expect(
      seedDemoPersonas(db as never, seed, catalog as never, 'manager_staff')
    ).rejects.toThrow('identity is occupied');
    expect(db.user.create).not.toHaveBeenCalled();
    db.user.findUnique.mockResolvedValue(null);
    db.restaurantStaffProfile.findMany.mockResolvedValue([
      { id: 'foreign', userId: 'other', email: 'other' },
    ]);
    await expect(
      seedDemoPersonas(db as never, seed, catalog as never, 'manager_staff')
    ).rejects.toThrow('staff identity is occupied');
    expect(mocks.enroll).not.toHaveBeenCalled();
  });
});

describe('demo persona ABAC least privilege', () => {
  it.each([
    [
      'cashier',
      ['payments:collect', 'orders:take'],
      ['payments:refund', 'purchasing:approve', 'reports:financial', 'staff:manage'],
    ],
    [
      'waiter',
      ['orders:take'],
      ['payments:collect', 'payments:refund', 'reports:financial', 'devices:manage'],
    ],
    [
      'kitchen',
      ['kitchen:operate'],
      ['pos:operate', 'payments:collect', 'reports:financial', 'staff:manage'],
    ],
    [
      'inventory',
      ['inventory:adjust', 'purchasing:create', 'purchasing:approve'],
      ['pos:operate', 'payments:collect', 'staff:manage', 'reports:financial'],
    ],
    [
      'finance',
      ['money:read', 'reports:financial'],
      ['pos:operate', 'payments:collect', 'inventory:adjust', 'staff:manage'],
    ],
  ] as const)('enforces %s through the actual ABAC engine', async (persona, allowed, denied) => {
    const template = RESTAURANT_ROLE_TEMPLATES.find(
      (role) => role.key === DEMO_PERSONAS[persona].roleKey
    )!;
    const db = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          organizationId: seed.identity.organizationId,
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          organizationRole: {
            permissions: template.capabilities.map((capability) => ({
              capability,
              effect: 'ALLOW',
            })),
          },
          permissionOverrides: demoPersonaExtraCapabilities(persona).map((capability) => ({
            capability,
            effect: 'ALLOW',
          })),
        }),
      },
    };
    const subject = subjectFromSession({
      id: demoPersonaUserId(1, persona),
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      department: DEMO_PERSONAS[persona].department,
    });
    const operatorDb = {
      restaurantStaffJobRole: { findMany: async () => [] },
      restaurantStaffCapabilityGrant: { findMany: async () => [] },
      restaurantStaffProfile: {
        findUnique: async () => ({
          status: 'ACTIVE',
          primaryBranchId: 'branch',
          jobRoles: [],
          directCapabilityGrants: [],
          user: await db.user.findUnique(),
        }),
      },
    };
    for (const [actions, expected] of [
      [allowed, true],
      [denied, false],
    ] as const) {
      for (const action of actions) {
        expect(
          await operatorHasCapability(operatorDb as never, 'staff', action, new Date(), 'branch'),
          action
        ).toBe(expected);
        if (ALL_ACTIONS.includes(action as Action)) {
          expect(
            await can(subject, action as Action, undefined, { db: db as never, source: 'TRPC' }),
            action
          ).toBe(expected);
        }
      }
    }
  });
});
