import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import { readPharmacyApprovalStatus } from './onboarding';

// DEV-905: the owner sees when DevFathom approved the pharmacy, read live on a tenant
// connection, so nobody has to sign out and in again.
describe('readPharmacyApprovalStatus', () => {
  function tenantDb(organization: Record<string, unknown> | null) {
    return { organization: { findFirst: vi.fn(async () => organization) } };
  }

  it('dates an approved pharmacy from the super admin approval', async () => {
    const db = tenantDb({
      status: 'ACTIVE',
      activatedAt: new Date('2026-11-18T10:00:00.000Z'),
      platformApprovedAt: new Date('2026-11-18T09:59:00.000Z'),
      vertical: 'PHARMACY',
      packageId: 'pkg',
    });
    await expect(readPharmacyApprovalStatus(db as never, 'org-a')).resolves.toEqual({
      state: 'APPROVED',
      approvedAt: '2026-11-18T09:59:00.000Z',
    });
    expect(db.organization.findFirst).toHaveBeenCalledWith({
      where: { id: 'org-a' },
      select: expect.objectContaining({ status: true, platformApprovedAt: true }),
    });
  });

  it('falls back to the activation time for a pharmacy activated before approvals existed', async () => {
    const db = tenantDb({
      status: 'ACTIVE',
      activatedAt: new Date('2026-10-01T10:00:00.000Z'),
      platformApprovedAt: null,
      vertical: 'PHARMACY',
      packageId: 'pkg',
    });
    await expect(readPharmacyApprovalStatus(db as never, 'org-a')).resolves.toEqual({
      state: 'APPROVED',
      approvedAt: '2026-10-01T10:00:00.000Z',
    });
  });

  it('answers nothing for an organization it cannot see', async () => {
    await expect(readPharmacyApprovalStatus(tenantDb(null) as never, 'org-a')).resolves.toBeNull();
  });
});
