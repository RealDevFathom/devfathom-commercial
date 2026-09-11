import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ can: vi.fn(), scope: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/restaurant/staff-branch-authorization', () => ({
  resolveCapabilityBranchAuthorization: mocks.scope,
  denyStaffBranchAccess: () => {
    throw new Error('FORBIDDEN');
  },
}));
import { resolveDemoDirectoryScope } from './directory-access';
import { demoPersonaEmail, demoPersonaUserId, type DemoPersona } from './personas';
function context(persona: DemoPersona) {
  return {
    db: {},
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
  mocks.can.mockResolvedValue(true);
  mocks.scope.mockResolvedValue({ branchIds: ['primary_branch'], organizationWide: false });
});
describe('demo console directory reads', () => {
  it.each([
    ['inventory', 'branches', 'inventory:read'],
    ['finance', 'branches', 'money:read'],
    ['finance', 'devices', 'money:read'],
  ] as const)('uses %s existing capability for %s', async (persona, directory, capability) => {
    const ctx = context(persona);
    await expect(resolveDemoDirectoryScope(ctx as never, directory)).resolves.toEqual({
      branchIds: ['primary_branch'],
      organizationWide: false,
    });
    expect(mocks.can).toHaveBeenCalledWith(ctx.session.user, capability, undefined, {
      db: ctx.db,
      source: 'TRPC',
    });
    expect(mocks.scope).toHaveBeenCalledWith(ctx.db, ctx.session.user, capability, {
      requireExactlyOneActiveActor: true,
    });
  });
  it('honors an explicit permission denial and expired demo sessions', async () => {
    const ctx = context('finance');
    mocks.can.mockResolvedValue(false);
    await expect(resolveDemoDirectoryScope(ctx as never, 'devices')).rejects.toThrow('FORBIDDEN');
    expect(mocks.scope).not.toHaveBeenCalled();
    ctx.session.user.demoAccessExpiresAt = Date.now() - 1;
    await expect(resolveDemoDirectoryScope(ctx as never, 'branches')).rejects.toThrow('FORBIDDEN');
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
    expect(mocks.scope).not.toHaveBeenCalled();
  });
});
