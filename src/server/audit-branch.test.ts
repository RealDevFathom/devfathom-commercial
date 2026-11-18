import { describe, expect, it, vi } from 'vitest';

// DEV-913 — the branch an entry is recorded at is the branch of the mutation's
// own record. An authorization check on a related record (an order's
// requisition, a transfer's source branch) must never replace it.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/pharmacy/procurement-access', () => ({
  actorIsPharmacyOwner: vi.fn(async () => true),
}));

import { auditBranchId, type AuditDetail } from './audit';
import { annotateAuditBranch } from './audit-branch';
import { assertProcurementBranch } from './pharmacy-procurement-scope';
import type { TRPCContext } from './trpc';

/** The pharmacy owner, assigned to no branch: every check takes the owner path. */
function ownerContext() {
  return {
    db: {
      pharmacyBranch: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
      },
      pharmacyBranchAssignment: { findFirst: vi.fn(async () => null) },
    },
    entitlements: { organizationId: 'org_p' },
    session: { user: { id: 'owner', organizationId: 'org_p' } },
    audit: { detail: {} as AuditDetail },
  } as unknown as TRPCContext & { audit: { detail: AuditDetail } };
}

describe('DEV-913 audit branch tag', () => {
  it('records the branch, and leaves a branchless record workspace-wide', () => {
    const ctx = ownerContext();
    annotateAuditBranch(ctx, null);
    expect(auditBranchId({}, ctx.audit.detail)).toBeNull();
    annotateAuditBranch(ctx, 'branch_north');
    expect(auditBranchId({}, ctx.audit.detail)).toBe('branch_north');
    expect(() => annotateAuditBranch({}, 'branch_north')).not.toThrow();
  });

  it('keeps the request branch when the owner is checked at a related branch', async () => {
    const ctx = ownerContext();
    // An order for North that references South's requisition.
    await assertProcurementBranch(ctx, 'branch_north');
    await assertProcurementBranch(ctx, 'branch_south');
    expect(auditBranchId({ branchId: 'branch_north' }, ctx.audit.detail)).toBe('branch_north');
    // The owner's reach is still recorded, under its own key.
    expect(ctx.audit.detail.metadata).toMatchObject({
      ownerAccessBranchId: 'branch_south',
      reason: 'owner-procurement-access-without-branch-assignment',
    });
  });

  it("keeps the record's own tag when a related record is checked afterwards", async () => {
    const ctx = ownerContext();
    annotateAuditBranch(ctx, 'branch_north');
    await assertProcurementBranch(ctx, 'branch_south');
    expect(auditBranchId({}, ctx.audit.detail)).toBe('branch_north');
  });
});
