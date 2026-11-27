import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacySopEvidenceReadDecision } from './sop-evidence';
import { clinicalBranchAssignmentDenial } from './clinical-branch-access';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async () => true),
}));

describe('clinical and SOP admission with independent capability checks', () => {
  it.each([false, true])(
    'only full admission (%s) opens evidence; either admission opens clinical work',
    async (full) => {
      const db = {
        user: { findUnique: vi.fn().mockResolvedValue(null) },
        pharmacySopSite: { findFirst: vi.fn().mockResolvedValue({ pharmacyBranchId: 'north' }) },
        pharmacyBranchAssignment: {
          findFirst: vi.fn().mockResolvedValue(full ? { branchId: 'north', id: 'full' } : null),
        },
        pharmacyClinicalBranchAssignment: {
          findFirst: vi.fn().mockResolvedValue(full ? null : { branchId: 'north' }),
        },
      } as unknown as ScopedDb;
      const user = { id: 'member', role: 'EMPLOYEE', status: 'ACTIVE' };
      expect(await clinicalBranchAssignmentDenial(db, user, 'tenant', 'north')).toBeNull();
      expect(
        await pharmacySopEvidenceReadDecision(db, {
          organizationId: 'tenant',
          user,
          evidence: {
            uploaderStaffProfileId: null,
            occurrence: {
              branchId: 'sop-north',
              templateVersionId: 'v1',
              assignedStaffProfileId: null,
              claimedByStaffProfileId: null,
            },
          },
        })
      ).toBe(full ? 'ALLOW' : 'DENY');
    }
  );
});
