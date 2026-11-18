import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(), withTenantDb: vi.fn() }));

import { REFUND_PIN_POLICY, refundApprovalAudit } from './refund-authorization';

// DEV-32: a manager or owner approves their own refund or stock return with a fresh PIN.
// The audit detail records who started it, who approved it, when, and that it was self-approved.
describe('DEV-32 refund approval audit detail', () => {
  const now = new Date('2026-11-18T10:15:30.000Z');

  it('records the approver, the initiator, the approval time and the self-approval', () => {
    expect(
      refundApprovalAudit({
        initiatedById: 'manager-a',
        approverId: 'manager-a',
        pin: { verified: true },
        now,
      })
    ).toEqual({
      policy: REFUND_PIN_POLICY,
      approverId: 'manager-a',
      initiatedById: 'manager-a',
      pinVerified: true,
      selfApproved: true,
      approvedAt: '2026-11-18T10:15:30.000Z',
    });
  });

  it('records no approval time or self-approval when the PIN is refused', () => {
    expect(
      refundApprovalAudit({
        initiatedById: 'manager-a',
        approverId: 'manager-a',
        pin: { blocked: 'refused' },
        now,
      })
    ).toEqual({
      policy: REFUND_PIN_POLICY,
      approverId: 'manager-a',
      initiatedById: 'manager-a',
      pinVerified: false,
      selfApproved: false,
      approvedAt: null,
    });
  });

  it('does not mark an approval by another person as a self-approval', () => {
    expect(
      refundApprovalAudit({
        initiatedById: 'manager-a',
        approverId: 'owner-b',
        pin: { verified: true },
        now,
      })
    ).toMatchObject({ selfApproved: false, approvedAt: '2026-11-18T10:15:30.000Z' });
  });
});
