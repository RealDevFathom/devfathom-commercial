import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ can: vi.fn(), profiles: vi.fn(), capabilities: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/restaurant/job-roles', () => ({ resolveStaffCapabilities: mocks.capabilities }));
import { resolveDemoDirectoryScope } from './directory-access';
import { demoPersonaEmail, demoPersonaUserId, type DemoPersona } from './personas';
function context(persona: DemoPersona) {
  return {
    db: {
      restaurantStaffProfile: { findMany: mocks.profiles },
      restaurantBranch: { findMany: vi.fn(async () => [{ id: 'primary_branch' }]) },
    },
    entitlements: { organizationId: 'org_demo_restaurant_seat_1' },
    organization: {
      id: 'org_demo_restaurant_seat_1',
      slug: 'demo-restaurant-seat-1',
      isDemo: true,
      status: 'ACTIVE',
      vertical: 'RESTAURANT',
      deploymentMode: 'SHARED',
    },
    session: {
      user: {
        id: demoPersonaUserId(1, persona),
        email: demoPersonaEmail(1, persona),
        organizationId: 'org_demo_restaurant_seat_1',
        demoAccessExpiresAt: Date.now() + 60_000,
      },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockImplementation(async (_subject, capability) =>
    ['inventory:read', 'money:read'].includes(capability)
  );
  mocks.profiles.mockResolvedValue([
    {
      id: 'actor',
      primaryBranchId: 'primary_branch',
      jobRoles: [{ branchId: 'primary_branch' }],
      directCapabilityGrants: [],
    },
  ]);
  mocks.capabilities.mockResolvedValue(new Set());
});
describe('demo console directory reads', () => {
  it.each([
    ['inventory', 'branches', 'inventory:read'],
    ['finance', 'branches', 'money:read'],
    ['finance', 'devices', 'money:read'],
  ] as const)('uses %s existing capability for %s', async (persona, directory, capability) => {
    const ctx = context(persona);
    mocks.capabilities.mockResolvedValue(new Set([capability]));
    await expect(resolveDemoDirectoryScope(ctx as never, directory)).resolves.toEqual({
      actorStaffProfileId: 'actor',
      actorBranchIds: ['primary_branch'],
      branchIds: ['primary_branch'],
      organizationWide: false,
    });
    expect(mocks.can).toHaveBeenCalledWith(ctx.session.user, capability, undefined, {
      db: ctx.db,
      source: 'TRPC',
    });
    expect(mocks.profiles).toHaveBeenCalledExactlyOnceWith({
      where: { userId: ctx.session.user.id, status: 'ACTIVE' },
      select: {
        id: true,
        primaryBranchId: true,
        jobRoles: { select: { branchId: true } },
        directCapabilityGrants: { select: { branchId: true } },
      },
      orderBy: { id: 'asc' },
      take: 2,
    });
    expect(mocks.can).toHaveBeenCalledWith(ctx.session.user, 'restaurant:configure', undefined, {
      db: ctx.db,
      source: 'TRPC',
    });
    expect(mocks.capabilities).toHaveBeenCalledExactlyOnceWith(ctx.db, 'actor', 'primary_branch');
  });
  it('honors an explicit permission denial and expired demo sessions', async () => {
    const ctx = context('finance');
    mocks.can.mockResolvedValue(false);
    await expect(resolveDemoDirectoryScope(ctx as never, 'devices')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.profiles).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
    ctx.session.user.demoAccessExpiresAt = Date.now() - 1;
    mocks.can.mockClear();
    await expect(resolveDemoDirectoryScope(ctx as never, 'branches')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.profiles).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });
  it.each([0, 2])('rejects %s active actors before resolving capabilities', async (count) => {
    const ctx = context('finance');
    mocks.profiles.mockResolvedValue(
      Array.from({ length: count }, (_, index) => ({
        id: `actor-${index}`,
        primaryBranchId: 'primary_branch',
        jobRoles: [{ branchId: 'primary_branch' }],
        directCapabilityGrants: [],
      }))
    );
    await expect(resolveDemoDirectoryScope(ctx as never, 'devices')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.profiles).toHaveBeenCalledTimes(1);
    expect(mocks.can).toHaveBeenCalledExactlyOnceWith(ctx.session.user, 'money:read', undefined, {
      db: ctx.db,
      source: 'TRPC',
    });
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });
  it('preserves normal tenant and other persona directory guards', async () => {
    const production = context('finance');
    production.organization.isDemo = false;
    for (const ctx of [production, context('waiter'), context('manager')]) {
      await expect(resolveDemoDirectoryScope(ctx as never, 'branches')).resolves.toBeNull();
    }
    await expect(
      resolveDemoDirectoryScope(context('inventory') as never, 'devices')
    ).resolves.toBeNull();
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.profiles).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });
});
