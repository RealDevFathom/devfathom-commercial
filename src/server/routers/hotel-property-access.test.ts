import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({ record: vi.fn(), annotate: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: audit.record,
  annotateAudit: audit.annotate,
}));

import { requireHotelPropertyScope } from '@/server/hotel-property-scope';
import type { TRPCContext } from '@/server/trpc';
import { hotelPropertyRouter } from './hotel-property';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const allow = (capability: string): Rule => ({ capability, effect: 'ALLOW' });
const deny = (capability: string): Rule => ({ capability, effect: 'DENY' });
const ORG = 'hotel_org';
const BRANCH = 'property_a';
const ACTOR = 'manager_a';

function fixture() {
  const state = {
    organizationId: ORG,
    branchId: BRANCH,
    userId: ACTOR,
    active: true,
    propertyActive: true,
    userStatus: 'ACTIVE',
    roleKey: 'general-manager',
    roleRules: [allow('hotel:property-admin')],
    globalRules: [allow('hotel:property-admin'), allow('admin:access')],
    overrides: [] as Rule[],
    targetExists: true,
    roleExists: true,
  };
  const events: string[] = [];
  const db = {
    user: {
      // Real can() evaluates these organization permissions and overrides.
      findUnique: vi.fn(async () => ({
        organizationRole: { permissions: state.globalRules },
        permissionOverrides: state.overrides,
      })),
      findFirst: vi.fn(async ({ where }: { where: { organizationId: string; id: string } }) =>
        state.targetExists && where.organizationId === ORG && where.id === 'target_a'
          ? { id: where.id }
          : null
      ),
    },
    organizationRole: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId: string; id: string; key: { in: string[] } };
        }) =>
          state.roleExists &&
          where.organizationId === ORG &&
          where.id === 'role_gm' &&
          where.key.in.includes('general-manager')
            ? { id: where.id }
            : null
      ),
    },
    hotelPropertyAssignment: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            organizationId: string;
            branchId: string;
            userId: string;
            active: boolean;
            property: { organizationId: string; active: boolean };
            user: { organizationId: string; status: { in: string[] } };
            role: { organizationId: string; key: { in: string[] } };
          };
        }) => {
          events.push('resolve');
          if (
            where.organizationId !== state.organizationId ||
            where.branchId !== state.branchId ||
            where.userId !== state.userId ||
            where.active !== state.active ||
            where.property.organizationId !== state.organizationId ||
            where.property.active !== state.propertyActive ||
            where.user.organizationId !== state.organizationId ||
            !where.user.status.in.includes(state.userStatus) ||
            where.role.organizationId !== state.organizationId ||
            !where.role.key.in.includes(state.roleKey)
          )
            return null;
          return {
            property: {
              organizationId: state.organizationId,
              branchId: state.branchId,
              name: 'Property A',
            },
            role: { permissions: state.roleRules },
          };
        }
      ),
      upsert: vi.fn(async () => {
        events.push('assign');
        return {
          id: 'assignment_target',
          branchId: BRANCH,
          userId: 'target_a',
          organizationRoleId: 'role_gm',
          active: true,
        };
      }),
      updateMany: vi.fn(async () => {
        events.push('revoke');
        return { count: 1 };
      }),
    },
    $queryRaw: vi.fn(async () => {
      events.push('lock');
      return [{ branchId: BRANCH }];
    }),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db)),
  };
  const ctx = {
    db,
    entitlements: { organizationId: ORG, enabledModules: ['hotel-core'], modules: [] },
    session: {
      expires: 'later',
      user: { id: ACTOR, organizationId: ORG, role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { state, db, ctx, events, caller: hotelPropertyRouter.createCaller(ctx) };
}

beforeEach(() => vi.clearAllMocks());

describe('Hotel property access foundation', () => {
  it('resolves an explicit assigned property for a non-ADMIN with both capability grants', async () => {
    const f = fixture();
    await expect(
      f.caller.access.select({ branchId: BRANCH, capability: 'hotel:property-admin' })
    ).resolves.toEqual({ organizationId: ORG, branchId: BRANCH, name: 'Property A' });
    expect(f.db.hotelPropertyAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          branchId: BRANCH,
          userId: ACTOR,
          active: true,
        }),
      })
    );
  });

  it.each(['property_b', 'foreign_property'])(
    'denies requested %s without an assignment; never falls back to A',
    async (branchId) => {
      const f = fixture();
      await expect(
        f.caller.access.select({ branchId, capability: 'hotel:property-admin' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  );

  it.each([
    ['cross-tenant assignment', { organizationId: 'other_org' }],
    ['another user assignment', { userId: 'other_user' }],
    ['revoked assignment', { active: false }],
    ['inactive property', { propertyActive: false }],
    ['inactive database user with active JWT', { userStatus: 'INACTIVE' }],
    ['unknown Hotel role', { roleKey: 'invented-owner' }],
  ])('denies %s', async (_label, patch) => {
    const f = fixture();
    Object.assign(f.state, patch);
    await expect(
      requireHotelPropertyScope(f.ctx, BRANCH, 'hotel:property-admin')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(['Owner', 'General Manager', 'ADMIN'])(
    'does not infer property access from %s or selection preferences',
    async (role) => {
      const f = fixture();
      f.ctx.session!.user.role = role;
      Object.assign(f.ctx.session!.user, {
        branchId: BRANCH,
        branch_ids: [BRANCH],
        preferences: { branchId: BRANCH },
      });
      f.db.hotelPropertyAssignment.findFirst.mockResolvedValue(null);
      await expect(
        f.caller.access.select({ branchId: BRANCH, capability: 'hotel:property-admin' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  );

  it('rejects a session from another tenant before querying assignments', async () => {
    const f = fixture();
    f.ctx.session!.user.organizationId = 'other_org';
    await expect(
      requireHotelPropertyScope(f.ctx, BRANCH, 'hotel:property-admin')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.hotelPropertyAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('rechecks selection after revocation instead of trusting the previous result', async () => {
    const f = fixture();
    await f.caller.access.select({ branchId: BRANCH, capability: 'hotel:property-admin' });
    f.state.active = false;
    await expect(
      f.caller.access.select({ branchId: BRANCH, capability: 'hotel:property-admin' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.hotelPropertyAssignment.findFirst).toHaveBeenCalledTimes(2);
  });

  it.each([
    'missing global grant',
    'global override DENY',
    'missing property grant',
    'property DENY',
  ])('preserves %s independently', async (reason) => {
    const f = fixture();
    if (reason === 'missing global grant') f.state.globalRules = [];
    if (reason === 'global override DENY') f.state.overrides = [deny('hotel:*')];
    if (reason === 'missing property grant') f.state.roleRules = [];
    if (reason === 'property DENY') f.state.roleRules = [allow('*'), deny('hotel:property-admin')];
    await expect(
      f.caller.access.select({ branchId: BRANCH, capability: 'hotel:property-admin' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(['hotel:*', '*'])(
    'accepts an explicitly assigned role wildcard %s',
    async (capability) => {
      const f = fixture();
      f.state.roleRules = [allow(capability)];
      await expect(
        f.caller.access.select({ branchId: BRANCH, capability: 'hotel:property-admin' })
      ).resolves.toMatchObject({ branchId: BRANCH });
    }
  );

  it('uses the requested Hotel capability, including operational roles', async () => {
    const f = fixture();
    f.state.roleKey = 'housekeeper';
    f.state.globalRules = f.state.roleRules = [allow('hotel:housekeeping')];
    await expect(
      f.caller.access.select({ branchId: BRANCH, capability: 'hotel:housekeeping' })
    ).resolves.toMatchObject({ branchId: BRANCH });
    await expect(
      f.caller.access.select({ branchId: BRANCH, capability: 'hotel:property-admin' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses missing Hotel Core even with assignments and capabilities', async () => {
    const f = fixture();
    f.ctx.entitlements.enabledModules = [];
    await expect(
      f.caller.access.select({ branchId: BRANCH, capability: 'hotel:property-admin' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.hotelPropertyAssignment.findFirst).not.toHaveBeenCalled();
  });

  it.each([null, 'revoked'])('refuses unusable session %s', async (session) => {
    const f = fixture();
    if (session === null) f.ctx.session = null;
    else f.ctx.session!.user.sessionRevoked = true;
    await expect(
      requireHotelPropertyScope(f.ctx, BRANCH, 'hotel:property-admin')
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.db.hotelPropertyAssignment.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { branchId: '', capability: 'hotel:property-admin' },
    { capability: 'hotel:property-admin' },
    { branchId: BRANCH, capability: 'admin:access' },
  ])('validates selection input %j without a default', async (input) => {
    const f = fixture();
    await expect(
      f.caller.access.select(input as { branchId: string; capability: 'hotel:property-admin' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.hotelPropertyAssignment.findFirst).not.toHaveBeenCalled();
  });
});

describe('Hotel assignment management', () => {
  const input = { branchId: BRANCH, userId: 'target_a', organizationRoleId: 'role_gm' };

  it('assigns under a property lock with scoped target/role checks and native audit', async () => {
    const f = fixture();
    await f.caller.access.assign(input);
    expect(f.events).toEqual(['lock', 'resolve', 'assign']);
    expect(f.db.hotelPropertyAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_branchId_userId: {
            organizationId: ORG,
            branchId: BRANCH,
            userId: 'target_a',
          },
        },
        create: {
          organizationId: ORG,
          branchId: BRANCH,
          userId: 'target_a',
          organizationRoleId: 'role_gm',
        },
        update: { organizationRoleId: 'role_gm', active: true },
      })
    );
    expect(audit.annotate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'HotelPropertyAssignment',
        targetId: 'assignment_target',
      })
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'access.assign', outcome: 'SUCCESS', type: 'mutation' })
    );
  });

  it('revokes by scoped active flag under the same lock and audit', async () => {
    const f = fixture();
    await f.caller.access.revoke(input);
    expect(f.events).toEqual(['lock', 'resolve', 'revoke']);
    expect(f.db.hotelPropertyAssignment.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, branchId: BRANCH, userId: 'target_a', active: true },
      data: { active: false },
    });
    expect(audit.annotate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        description: 'Revoked property access',
        metadata: { branchId: BRANCH, userId: 'target_a' },
      })
    );
  });

  it.each(['assign', 'revoke'] as const)(
    'requires existing admin:access for %s',
    async (operation) => {
      const f = fixture();
      f.state.globalRules = [allow('hotel:property-admin')];
      await expect(f.caller.access[operation](input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
    }
  );

  it.each(['assign', 'revoke'] as const)(
    'denies self-target %s even with all grants',
    async (operation) => {
      const f = fixture();
      await expect(f.caller.access[operation]({ ...input, userId: ACTOR })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(['assign', 'revoke'] as const)('refuses %s at sibling Property B', async (operation) => {
    const f = fixture();
    await expect(
      f.caller.access[operation]({ ...input, branchId: 'property_b' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.hotelPropertyAssignment.upsert).not.toHaveBeenCalled();
    expect(f.db.hotelPropertyAssignment.updateMany).not.toHaveBeenCalled();
  });

  it('does not bootstrap the first assignment through administration', async () => {
    const f = fixture();
    f.db.hotelPropertyAssignment.findFirst.mockResolvedValue(null);
    await expect(f.caller.access.assign(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.hotelPropertyAssignment.upsert).not.toHaveBeenCalled();
  });

  it.each(['targetExists', 'roleExists'] as const)(
    'denies missing, inactive or cross-tenant %s',
    async (key) => {
      const f = fixture();
      f.state[key] = false;
      await expect(f.caller.access.assign(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(f.db.hotelPropertyAssignment.upsert).not.toHaveBeenCalled();
    }
  );

  it('refuses a cross-tenant target id', async () => {
    const f = fixture();
    await expect(
      f.caller.access.assign({ ...input, userId: 'foreign_user' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.db.hotelPropertyAssignment.upsert).not.toHaveBeenCalled();
  });

  it('refuses a revoked manager after obtaining the property lock', async () => {
    const f = fixture();
    f.db.$queryRaw.mockImplementation(async () => {
      f.events.push('lock');
      f.state.active = false;
      return [];
    });
    await expect(f.caller.access.assign(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.hotelPropertyAssignment.upsert).not.toHaveBeenCalled();
  });

  it('reports missing/revoked targets instead of a successful no-op', async () => {
    const f = fixture();
    f.db.hotelPropertyAssignment.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.caller.access.revoke(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(audit.annotate).not.toHaveBeenCalled();
  });
});
