import { beforeEach, expect, it, vi } from 'vitest';
import {
  resolveDemoDirectoryScope,
  type DemoDirectoryPolicy,
} from '@/lib/restaurant/staff-branch-authorization';
import type { TRPCContext } from '@/server/trpc';

const mocks = vi.hoisted(() => ({ can: vi.fn(), capabilities: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/restaurant/job-roles', () => ({ resolveStaffCapabilities: mocks.capabilities }));
const policy: DemoDirectoryPolicy = {
  seatFromOrganizationId: () => 1,
  isCanonicalOrganization: () => true,
  personaForUser: () => 'finance',
};
function context() {
  return {
    organization: { id: 'organization', isDemo: true },
    entitlements: { organizationId: 'organization' },
    session: {
      user: {
        id: 'actor',
        organizationId: 'organization',
        demoAccessExpiresAt: Date.now() + 60_000,
      },
    },
    db: {
      restaurantStaffProfile: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'profile',
            primaryBranchId: 'branch-a',
            jobRoles: [{ branchId: 'branch-a' }, { branchId: 'branch-b' }],
            directCapabilityGrants: [],
          },
        ]),
      },
      restaurantBranch: { findMany: vi.fn().mockResolvedValue([{ id: 'branch-a' }]) },
    },
  };
}
beforeEach(() => {
  mocks.can
    .mockReset()
    .mockImplementation(async (_user, capability) => capability !== 'restaurant:configure');
  mocks.capabilities
    .mockReset()
    .mockImplementation(
      async (_db, _id, branch) => new Set(branch === 'branch-a' ? ['money:read'] : [])
    );
});
it('limits finance directory to active actor capability branches', async () => {
  const ctx = context();
  const result = await resolveDemoDirectoryScope(ctx as unknown as TRPCContext, 'devices', policy);
  expect(result?.branchIds).toEqual(['branch-a']);
  expect(result?.actorStaffProfileId).toBe('profile');
  expect(ctx.db.restaurantStaffProfile.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { userId: 'actor', status: 'ACTIVE' }, take: 2 })
  );
});
it.each([
  'expired',
  'tenant',
  'canonical',
  'seat',
  'capability',
  'no actor',
  'ambiguous actor',
  'no branch',
])('rejects invalid demo %s before ordinary management fallback', async (reason) => {
  const ctx = context();
  const rules = { ...policy };
  if (reason === 'expired') ctx.session.user.demoAccessExpiresAt = Date.now() - 1;
  if (reason === 'tenant') ctx.session.user.organizationId = 'other';
  if (reason === 'canonical') rules.isCanonicalOrganization = () => false;
  if (reason === 'seat') rules.seatFromOrganizationId = () => null;
  if (reason === 'capability') mocks.can.mockResolvedValue(false);
  if (reason === 'no actor') ctx.db.restaurantStaffProfile.findMany.mockResolvedValue([]);
  if (reason === 'ambiguous actor')
    ctx.db.restaurantStaffProfile.findMany.mockResolvedValue([{}, {}]);
  if (reason === 'no branch') mocks.capabilities.mockResolvedValue(new Set());
  await expect(
    resolveDemoDirectoryScope(ctx as unknown as TRPCContext, 'devices', rules)
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('retains ordinary management resolution and demo personas without directory read duty', async () => {
  const ctx = context();
  ctx.organization.isDemo = false;
  expect(
    await resolveDemoDirectoryScope(ctx as unknown as TRPCContext, 'devices', policy)
  ).toBeNull();
  ctx.organization.isDemo = true;
  expect(
    await resolveDemoDirectoryScope(ctx as unknown as TRPCContext, 'devices', {
      ...policy,
      personaForUser: () => 'inventory',
    })
  ).toBeNull();
  expect(ctx.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
});
