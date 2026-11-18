import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import { showsPharmacyApprovalNotice } from './approval-status';
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

  it('announces no approval once it is withdrawn, though the pharmacy stays active', async () => {
    const db = tenantDb({
      status: 'ACTIVE',
      activatedAt: new Date(),
      platformApprovedAt: null,
      vertical: 'PHARMACY',
      packageId: 'pkg',
    });
    const status = await readPharmacyApprovalStatus(db as never, 'org-a');
    expect(status).toEqual({ state: 'APPROVED', approvedAt: null });
    // No dated approval, so the dashboard shows no "approved, can sell" notice.
    expect(showsPharmacyApprovalNotice(status, new Date())).toBe(false);
  });

  it('answers nothing for an organization it cannot see', async () => {
    await expect(readPharmacyApprovalStatus(tenantDb(null) as never, 'org-a')).resolves.toBeNull();
  });
});
