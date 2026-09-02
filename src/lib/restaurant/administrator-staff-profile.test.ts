/**
 * WHA-1181 — the organization administrator SuperAdmin creates for a restaurant
 * organization was never given a `RestaurantStaffProfile`, so every restaurant
 * procedure answered 403. These cover the shared write both entry points use.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAdministratorStaffProfile } from './administrator-staff-profile';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({
  staffFindFirst: vi.fn(),
  staffCreate: vi.fn(),
  branchFindFirst: vi.fn(),
}));

const db = {
  restaurantStaffProfile: { findFirst: mocks.staffFindFirst, create: mocks.staffCreate },
  restaurantBranch: { findFirst: mocks.branchFindFirst },
} as unknown as ScopedDb;

const input = {
  organizationId: 'org_1',
  userId: 'user_admin',
  displayName: 'Restaurant Owner',
  email: 'owner@example.test',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default world: no profile for this user, no email clash, one active branch.
  mocks.staffFindFirst.mockResolvedValue(null);
  mocks.branchFindFirst.mockResolvedValue({ id: 'branch_default' });
  mocks.staffCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'staff_new',
    primaryBranchId: data.primaryBranchId,
  }));
});

describe('ensureAdministratorStaffProfile', () => {
  it('creates the missing profile against the default branch', async () => {
    const result = await ensureAdministratorStaffProfile(db, input);

    expect(result).toEqual({
      created: true,
      staffProfileId: 'staff_new',
      primaryBranchId: 'branch_default',
    });
    expect(mocks.staffCreate).toHaveBeenCalledOnce();
    expect(mocks.staffCreate.mock.calls[0]![0].data).toMatchObject({
      // Explicit, because the platform control plane runs with a blank
      // `app.current_organization_id` and the column default would resolve to ''.
      organizationId: 'org_1',
      userId: 'user_admin',
      displayName: 'Restaurant Owner',
      email: 'owner@example.test',
      primaryBranchId: 'branch_default',
      status: 'ACTIVE',
    });
    // Default branch first, then the oldest active one.
    expect(mocks.branchFindFirst.mock.calls[0]![0]).toMatchObject({
      where: { organizationId: 'org_1', active: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('is idempotent: a second call writes nothing and returns the existing profile', async () => {
    mocks.staffFindFirst.mockResolvedValueOnce({
      id: 'staff_existing',
      primaryBranchId: 'branch_default',
    });

    const result = await ensureAdministratorStaffProfile(db, input);

    expect(result).toEqual({
      created: false,
      staffProfileId: 'staff_existing',
      primaryBranchId: 'branch_default',
    });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });

  it('leaves a SUSPENDED profile alone rather than re-activating it', async () => {
    // Re-activation would be a privilege change, not a repair: an operator who
    // suspended this person must not have it undone by a lifecycle command.
    mocks.staffFindFirst.mockResolvedValueOnce({ id: 'staff_suspended', primaryBranchId: null });

    const result = await ensureAdministratorStaffProfile(db, input);

    expect(result).toEqual({
      created: false,
      staffProfileId: 'staff_suspended',
      primaryBranchId: null,
    });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });

  it('scopes the idempotence lookup to the organization and the user link', async () => {
    await ensureAdministratorStaffProfile(db, input);

    expect(mocks.staffFindFirst.mock.calls[0]![0]).toMatchObject({
      where: { organizationId: 'org_1', userId: 'user_admin' },
    });
  });

  it('yields a directory email another profile already claims instead of failing', async () => {
    mocks.staffFindFirst
      .mockResolvedValueOnce(null) // no profile for this user
      .mockResolvedValueOnce({ id: 'staff_other' }); // but the email is taken

    const result = await ensureAdministratorStaffProfile(db, input);

    expect(result.created).toBe(true);
    expect(mocks.staffCreate.mock.calls[0]![0].data.email).toBeNull();
  });

  it('normalises the email and treats a blank one as absent', async () => {
    await ensureAdministratorStaffProfile(db, { ...input, email: '  Owner@Example.TEST  ' });
    expect(mocks.staffCreate.mock.calls[0]![0].data.email).toBe('owner@example.test');

    vi.clearAllMocks();
    mocks.staffFindFirst.mockResolvedValue(null);
    mocks.branchFindFirst.mockResolvedValue({ id: 'branch_default' });
    mocks.staffCreate.mockResolvedValue({ id: 'staff_new', primaryBranchId: 'branch_default' });

    await ensureAdministratorStaffProfile(db, { ...input, email: '   ' });
    expect(mocks.staffCreate.mock.calls[0]![0].data.email).toBeNull();
    // A blank email is not a lookup — only the user-link probe ran.
    expect(mocks.staffFindFirst).toHaveBeenCalledOnce();
  });

  it('still links the administrator when the organization has no active branch', async () => {
    // The 403 is what breaks the workspace; `primaryBranchId` is nullable.
    mocks.branchFindFirst.mockResolvedValueOnce(null);

    const result = await ensureAdministratorStaffProfile(db, input);

    expect(result).toEqual({
      created: true,
      staffProfileId: 'staff_new',
      primaryBranchId: null,
    });
  });

  it.each([['   '], [''], [null], [undefined]])(
    'falls back to a stated display name rather than throwing for %j',
    async (displayName) => {
      // A profile REQUIRES a display name, and failing part-way through an
      // activation would be worse than a generic one.
      await ensureAdministratorStaffProfile(db, { ...input, displayName });
      expect(mocks.staffCreate.mock.calls[0]![0].data.displayName).toBe(
        'Organization administrator'
      );
    }
  );
});
