import { beforeEach, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
const mocks = vi.hoisted(() => ({ ensure: vi.fn(), grant: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./administrator-staff-profile', () => ({ ensureAdministratorStaffProfile: mocks.ensure }));
vi.mock('./job-roles', () => ({ grantJobRole: mocks.grant }));
import { provisionInvitedFloorStaff } from './invited-staff';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensure.mockResolvedValue({ staffProfileId: 'floor', primaryBranchId: 'branch' });
});
it.each(['cashier', 'kitchen', 'server'])(
  'links accepted %s to the matching branch job role without issuing a PIN',
  async (key) => {
    const findFirst = vi.fn(async () => ({ id: `job_${key}` }));
    const db = { restaurantJobRole: { findFirst } } as unknown as ScopedDb;
    await provisionInvitedFloorStaff(db, {
      id: 'user',
      organizationId: 'token_tenant',
      name: 'Alex',
      email: 'alex@example.com',
      organizationRole: { key },
      organization: { vertical: 'RESTAURANT' },
    });
    expect(mocks.ensure).toHaveBeenCalledWith(db, {
      organizationId: 'token_tenant',
      userId: 'user',
      displayName: 'Alex',
      email: 'alex@example.com',
    });
    expect(findFirst).toHaveBeenCalledWith({ where: { key, active: true }, select: { id: true } });
    expect(mocks.grant).toHaveBeenCalledWith(db, {
      staffProfileId: 'floor',
      branchId: 'branch',
      jobRoleId: `job_${key}`,
    });
  }
);
it('leaves agency invites outside restaurant provisioning', async () => {
  await provisionInvitedFloorStaff({} as ScopedDb, {
    id: 'user',
    organizationId: 'tenant',
    name: 'Alex',
    email: 'alex@example.com',
    organizationRole: { key: 'cashier' },
    organization: { vertical: 'AGENCY' },
  });
  expect(mocks.ensure).not.toHaveBeenCalled();
});
