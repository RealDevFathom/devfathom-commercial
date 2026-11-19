import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ reviewers: vi.fn(), can: vi.fn(), findMany: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/pharmacy/card-terminal/review-approvers', () => ({
  otherCardTerminalReviewers: mocks.reviewers,
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { otherApReversalApprovers } from './ap-reversal-approvers';

const scope = { organizationId: 'org_1', branchId: 'branch_1', actorId: 'owner_1' };
const db = { user: { findMany: mocks.findMany } } as unknown as ScopedDb;
const person = (id: string, name: string) => ({
  id,
  name,
  role: 'ADMIN',
  department: null,
  status: 'ACTIVE',
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.can.mockResolvedValue(true);
});

describe('DEV-103 otherApReversalApprovers', () => {
  it('starts from the card-terminal solo rule and keeps only active owner-level users', async () => {
    mocks.reviewers.mockResolvedValue([
      { id: 'manager_2', name: 'Hina' },
      { id: 'cashier_3', name: 'Ali' },
    ]);
    mocks.findMany.mockResolvedValue([person('manager_2', 'Hina')]);
    await expect(otherApReversalApprovers(db, scope)).resolves.toEqual([
      { id: 'manager_2', name: 'Hina' },
    ]);
    expect(mocks.reviewers).toHaveBeenCalledWith(db, scope, expect.any(Date));
    expect(mocks.findMany.mock.calls[0]![0].where).toEqual({
      organizationId: 'org_1',
      id: { in: ['manager_2', 'cashier_3'] },
      role: 'ADMIN',
      status: 'ACTIVE',
    });
  });

  it('reads no users when the card-terminal rule finds nobody', async () => {
    mocks.reviewers.mockResolvedValue([]);
    await expect(otherApReversalApprovers(db, scope)).resolves.toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it.each(['admin:access', 'finance:read'])(
    'never counts someone denied %s, which the reversal procedures require',
    async (denied) => {
      mocks.reviewers.mockResolvedValue([
        { id: 'manager_2', name: 'Hina' },
        { id: 'manager_3', name: 'Sana' },
      ]);
      mocks.findMany.mockResolvedValue([person('manager_2', 'Hina'), person('manager_3', 'Sana')]);
      mocks.can.mockImplementation(
        async (subject: { id: string }, action: string) =>
          !(subject.id === 'manager_2' && action === denied)
      );
      await expect(otherApReversalApprovers(db, scope)).resolves.toEqual([
        { id: 'manager_3', name: 'Sana' },
      ]);
    }
  );
});
