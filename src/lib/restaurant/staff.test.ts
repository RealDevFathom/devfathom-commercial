import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StaffProfileError,
  createStaffProfile,
  normalizeStaffEmail,
  setStaffProfileStatus,
  updateStaffProfile,
} from './staff';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({
  staffFindFirst: vi.fn(),
  staffFindUnique: vi.fn(),
  staffCreate: vi.fn(),
  staffUpdate: vi.fn(),
  branchFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
}));

const db = {
  restaurantStaffProfile: {
    findFirst: mocks.staffFindFirst,
    findUnique: mocks.staffFindUnique,
    create: mocks.staffCreate,
    update: mocks.staffUpdate,
  },
  restaurantBranch: { findUnique: mocks.branchFindUnique },
  user: { findFirst: mocks.userFindFirst },
} as unknown as ScopedDb;

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: no email clash, branch and user exist, writes echo their data.
  mocks.staffFindFirst.mockResolvedValue(null);
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1' });
  mocks.userFindFirst.mockResolvedValue({ id: 'user_1' });
  mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1' });
  mocks.staffCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'staff_new',
    ...data,
  }));
  mocks.staffUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data,
    })
  );
});

describe('normalizeStaffEmail (C3: email optional)', () => {
  it('lowercases and trims a present email', () => {
    expect(normalizeStaffEmail('  Chef@Restaurant.COM ')).toBe('chef@restaurant.com');
  });

  it('folds absent or blank to null', () => {
    expect(normalizeStaffEmail(undefined)).toBeNull();
    expect(normalizeStaffEmail(null)).toBeNull();
    expect(normalizeStaffEmail('   ')).toBeNull();
  });
});

describe('createStaffProfile', () => {
  it('creates a profile with a normalised email and defaults status to ACTIVE', async () => {
    await createStaffProfile(db, { displayName: '  Dana Cook  ', email: 'Dana@R.com' });

    expect(mocks.staffCreate).toHaveBeenCalledWith({
      data: {
        displayName: 'Dana Cook',
        email: 'dana@r.com',
        userId: null,
        primaryBranchId: null,
        status: 'ACTIVE',
      },
    });
  });

  it('allows a profile with no email at all (C3)', async () => {
    await createStaffProfile(db, { displayName: 'No Email Operator' });
    // A null email must never trigger the uniqueness lookup.
    expect(mocks.staffFindFirst).not.toHaveBeenCalled();
    expect(mocks.staffCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: null }) })
    );
  });

  it('rejects a blank display name', async () => {
    await expect(createStaffProfile(db, { displayName: '   ' })).rejects.toMatchObject({
      reason: 'INVALID',
    });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });

  it('rejects a duplicate email with EMAIL_TAKEN before writing', async () => {
    mocks.staffFindFirst.mockResolvedValue({ id: 'staff_existing' });
    await expect(
      createStaffProfile(db, { displayName: 'Dupe', email: 'taken@r.com' })
    ).rejects.toBeInstanceOf(StaffProfileError);
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-existent primary branch', async () => {
    mocks.branchFindUnique.mockResolvedValue(null);
    await expect(
      createStaffProfile(db, { displayName: 'x', primaryBranchId: 'branch_gone' })
    ).rejects.toMatchObject({ reason: 'BRANCH_NOT_FOUND' });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-existent linked user', async () => {
    mocks.userFindFirst.mockResolvedValue(null);
    await expect(
      createStaffProfile(db, { displayName: 'x', userId: 'user_gone' })
    ).rejects.toMatchObject({ reason: 'USER_NOT_FOUND' });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });

  it('links an active or newly invited user and branch when both are in scope', async () => {
    await createStaffProfile(db, {
      displayName: 'Linked',
      userId: 'user_1',
      primaryBranchId: 'branch_1',
    });
    expect(mocks.userFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'user_1',
        status: { in: ['ACTIVE', 'INVITED'] },
        restaurantStaffProfiles: { none: {} },
      },
      select: { id: true },
    });
    expect(mocks.staffCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user_1', primaryBranchId: 'branch_1' }),
      })
    );
  });
});

describe('updateStaffProfile', () => {
  it('throws NOT_FOUND when the profile is missing', async () => {
    mocks.staffFindUnique.mockResolvedValue(null);
    await expect(updateStaffProfile(db, 'staff_gone', { displayName: 'x' })).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
    expect(mocks.staffUpdate).not.toHaveBeenCalled();
  });

  it('only writes the fields present in the patch', async () => {
    await updateStaffProfile(db, 'staff_1', { displayName: 'Renamed' });
    expect(mocks.staffUpdate).toHaveBeenCalledWith({
      where: { id: 'staff_1' },
      data: { displayName: 'Renamed' },
    });
  });

  it('clears the user link when userId is explicitly null (one-way detach, C3)', async () => {
    await updateStaffProfile(db, 'staff_1', { userId: null });
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
    expect(mocks.staffUpdate).toHaveBeenCalledWith({
      where: { id: 'staff_1' },
      data: { userId: null },
    });
  });

  it('validates a newly linked user and normalises a changed email', async () => {
    await updateStaffProfile(db, 'staff_1', { userId: 'user_1', email: 'New@R.com' });
    expect(mocks.userFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'user_1',
        status: { in: ['ACTIVE', 'INVITED'] },
        restaurantStaffProfiles: { every: { id: 'staff_1' } },
      },
      select: { id: true },
    });
    expect(mocks.staffUpdate).toHaveBeenCalledWith({
      where: { id: 'staff_1' },
      data: { userId: 'user_1', email: 'new@r.com' },
    });
  });

  it('rejects an email that collides with another profile', async () => {
    mocks.staffFindFirst.mockResolvedValue({ id: 'other_staff' });
    await expect(updateStaffProfile(db, 'staff_1', { email: 'taken@r.com' })).rejects.toMatchObject(
      { reason: 'EMAIL_TAKEN' }
    );
    // The uniqueness lookup must exclude the row being edited.
    expect(mocks.staffFindFirst).toHaveBeenCalledWith({
      where: { email: 'taken@r.com', id: { not: 'staff_1' } },
      select: { id: true },
    });
  });
});

describe('setStaffProfileStatus', () => {
  it('writes the new status for an existing profile', async () => {
    await setStaffProfileStatus(db, 'staff_1', 'SUSPENDED');
    expect(mocks.staffUpdate).toHaveBeenCalledWith({
      where: { id: 'staff_1' },
      data: { status: 'SUSPENDED' },
    });
  });

  it('throws NOT_FOUND for a missing profile', async () => {
    mocks.staffFindUnique.mockResolvedValue(null);
    await expect(setStaffProfileStatus(db, 'gone', 'ARCHIVED')).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });
});
