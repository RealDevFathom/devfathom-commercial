import { describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from './trpc';
import { assignedRegisterBranchIds } from '@/lib/pharmacy/controlled-register';
import { pharmacyReadBranches } from './pharmacy-branch-access';

function fixture({
  role = 'EMPLOYEE',
  owner = false,
  status = 'ACTIVE',
  organizationId = 'org',
} = {}) {
  const db = {
    user: {
      findFirst: vi.fn(async () => ({ id: 'actor', role })),
      findUnique: vi.fn(async () => ({
        status,
        organizationId,
        organization: { vertical: 'PHARMACY' },
        organizationRole: { organizationId, key: owner ? 'owner' : 'admin', isSystem: true },
      })),
    },
    pharmacyBranchAssignment: { findMany: vi.fn(async () => []) },
    pharmacyBranch: { findMany: vi.fn(async () => []) },
  };
  const ctx = {
    db,
    entitlements: { organizationId: 'org' },
    session: { user: { id: 'actor', role: 'ADMIN', organizationId: 'org' } },
  } as unknown as TRPCContext;
  return { db, ctx };
}

describe('persisted owner branch exemption', () => {
  it('grants every active tenant branch to an EMPLOYEE with the persisted system-owner role', async () => {
    const { db, ctx } = fixture({ owner: true });
    await pharmacyReadBranches(ctx);
    expect(db.pharmacyBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org', active: true } })
    );
  });
  it.each([
    { role: 'ADMIN' },
    { owner: true, status: 'SUSPENDED' },
    { owner: true, organizationId: 'foreign' },
  ])('requires an assignment without a current tenant owner identity: %j', async (options) => {
    const { db, ctx } = fixture(options);
    await pharmacyReadBranches(ctx);
    expect(db.pharmacyBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branchAssignments: { some: { organizationId: 'org', userId: 'actor', active: true } },
        }),
      })
    );
  });
});

it('uses persisted system-owner identity for register branches, never the ADMIN title', async () => {
  for (const owner of [true, false]) {
    const { db } = fixture({ owner, role: 'ADMIN' });
    await assignedRegisterBranchIds(db as never, 'org', 'actor');
    if (owner)
      expect(db.pharmacyBranch.findMany).toHaveBeenCalledWith({
        where: { organizationId: 'org', active: true },
        select: { id: true },
      });
    else {
      expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
      expect(db.pharmacyBranchAssignment.findMany).toHaveBeenCalledWith({
        where: { organizationId: 'org', userId: 'actor', active: true },
        select: { branchId: true },
      });
    }
  }
});
