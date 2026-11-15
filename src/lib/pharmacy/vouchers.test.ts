import { beforeEach, describe, expect, it, vi } from 'vitest';

const approvals = vi.hoisted(() => ({
  authorize: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('./counter-line-approval', async () => ({
  ...(await vi.importActual<typeof import('./counter-line-approval')>('./counter-line-approval')),
  authorizeCounterApproval: approvals.authorize,
  confirmCounterApproval: approvals.confirm,
}));

import { CounterApprovalDenied } from './counter-line-approval';
import { MarketingWorkflowError } from './marketing-service';
import { VOUCHER_PRINT_FOOTER, VOUCHER_WHATSAPP_FOOTER } from './voucher-scope';
import {
  authorizeVoucherIssue,
  issueVoucher,
  listVouchers,
  revokeVoucher,
  VoucherApprovalRequired,
  voucherIssueInput,
} from './vouchers';

const scope = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  actorId: 'owner-a',
  timezone: 'Asia/Karachi',
};
const input = {
  branchId: 'branch-a',
  code: 'gift10',
  name: 'Gift sets',
  body: 'Rs 100 off gift sets this week. Reply STOP to opt out.',
  discountMinor: 10_000,
  maxUses: 50,
  validUntil: new Date(Date.now() + 30 * 86_400_000),
  reviewed: true as const,
};

function db() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'voucher-a',
    ...data,
  }));
  const audit = vi.fn(async () => ({}));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  return {
    create,
    audit,
    updateMany,
    auditLog: { create: audit },
    pharmacyVoucher: { create, updateMany, findMany: vi.fn(async () => []) },
  };
}

beforeEach(() => {
  approvals.authorize.mockReset();
  approvals.confirm.mockReset();
  approvals.confirm.mockResolvedValue(undefined);
});

describe('DEV-27 voucher issue', () => {
  it('stores the non-drug allowlist on the voucher and renders each channel footer', async () => {
    const fake = db();
    const { voucher, messages } = await issueVoucher(fake as never, scope, input);
    expect(fake.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        code: 'GIFT10',
        eligibleCategories: ['NON_DRUG'],
        issuedByUserId: 'owner-a',
        maxUses: 50,
        approvedByUserId: 'owner-a',
        approvalPolicy: 'VOUCHER_WITHIN_CAP',
        approvalCredentialId: null,
      }),
    });
    expect(fake.audit).not.toHaveBeenCalled();
    expect(voucher.eligibleCategories).toEqual(['NON_DRUG']);
    expect(messages.whatsapp).toBe(`${input.body}\n${VOUCHER_WHATSAPP_FOOTER}`);
    expect(messages.whatsapp).not.toMatch(/medicine/i);
    expect(messages.print).toBe(`${input.body}\n${VOUCHER_PRINT_FOOTER}`);
    expect(messages.inApp).toBe(`${input.body}\n${VOUCHER_PRINT_FOOTER}`);
  });

  it('refuses a drug category in the allowlist', async () => {
    for (const category of ['RX', 'OTC_DRUG', 'SUPPLEMENT', 'MEDICAL_DEVICE']) {
      expect(
        voucherIssueInput.safeParse({ ...input, eligibleCategories: [category] }).success
      ).toBe(false);
    }
  });

  it('refuses voucher copy that names a drug or medicine category', async () => {
    for (const body of [
      'Save on vitamins. Reply STOP to opt out.',
      'Discount on medicines. Reply STOP to opt out.',
    ]) {
      const fake = db();
      await expect(issueVoucher(fake as never, scope, { ...input, body })).rejects.toThrow(
        MarketingWorkflowError
      );
      expect(fake.create).not.toHaveBeenCalled();
    }
  });

  it('lists vouchers with their rendered footers', async () => {
    const fake = db();
    fake.pharmacyVoucher.findMany.mockResolvedValueOnce([
      { id: 'voucher-a', body: input.body } as never,
    ]);
    const [listed] = await listVouchers(fake as never, scope);
    expect(listed?.messages.whatsapp.endsWith(VOUCHER_WHATSAPP_FOOTER)).toBe(true);
  });
});

describe('DEV-819 voucher controls at issue', () => {
  const aboveCap = { ...input, discountMinor: 150_000, maxUses: 1 };
  const managerApproval = {
    approvedByUserId: 'manager-b',
    approvalPolicy: 'MANAGER_PIN',
    selfApproved: false,
    credentialId: 'credential-b',
  };
  const soloApproval = {
    approvedByUserId: 'owner-a',
    approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
    selfApproved: true,
    credentialId: 'credential-a',
  };

  it('requires a use limit and an expiry, and caps the per-use value', () => {
    const noLimit: Partial<typeof input> = { ...input };
    delete noLimit.maxUses;
    const noExpiry: Partial<typeof input> = { ...input };
    delete noExpiry.validUntil;
    expect(voucherIssueInput.safeParse(noLimit).success).toBe(false);
    expect(voucherIssueInput.safeParse(noExpiry).success).toBe(false);
    expect(voucherIssueInput.safeParse({ ...input, maxUses: 0 }).success).toBe(false);
    expect(voucherIssueInput.safeParse({ ...input, maxUses: 10_001 }).success).toBe(false);
    expect(voucherIssueInput.safeParse({ ...input, discountMinor: 1_000_001 }).success).toBe(false);
  });

  it('refuses an expiry more than a year away', async () => {
    const fake = db();
    await expect(
      issueVoucher(fake as never, scope, {
        ...input,
        validUntil: new Date(Date.now() + 400 * 86_400_000),
      })
    ).rejects.toThrow(MarketingWorkflowError);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('refuses a voucher above the value cap without a second approval', async () => {
    for (const voucher of [aboveCap, { ...input, discountMinor: 50_000, maxUses: 21 }]) {
      const fake = db();
      await expect(issueVoucher(fake as never, scope, voucher)).rejects.toThrow(
        VoucherApprovalRequired
      );
      await expect(authorizeVoucherIssue(fake as never, scope, voucher)).rejects.toThrow(
        VoucherApprovalRequired
      );
      expect(fake.create).not.toHaveBeenCalled();
    }
    expect(approvals.authorize).not.toHaveBeenCalled();
  });

  it('does not let the issuer count as the approver above the cap', async () => {
    for (const approval of [
      { ...managerApproval, approvedByUserId: 'owner-a' },
      { ...soloApproval, approvalPolicy: 'MANAGER_PIN' },
      { ...soloApproval, selfApproved: false },
      { ...managerApproval, credentialId: null },
    ]) {
      const fake = db();
      await expect(issueVoucher(fake as never, scope, aboveCap, approval)).rejects.toThrow(
        VoucherApprovalRequired
      );
      expect(fake.create).not.toHaveBeenCalled();
    }
  });

  it('refuses when the second approver no longer holds the capability', async () => {
    approvals.confirm.mockRejectedValueOnce(new CounterApprovalDenied('DISCOUNT'));
    const fake = db();
    await expect(issueVoucher(fake as never, scope, aboveCap, managerApproval)).rejects.toThrow(
      VoucherApprovalRequired
    );
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('maps a refused approver PIN to the voucher approval message', async () => {
    approvals.authorize.mockRejectedValueOnce(new CounterApprovalDenied('DISCOUNT'));
    await expect(
      authorizeVoucherIssue(db() as never, scope, {
        ...aboveCap,
        approval: { staffProfileId: 'staff-b', pin: '1234' },
      })
    ).rejects.toThrow(VoucherApprovalRequired);
  });

  it('records a second approver and an audit row', async () => {
    approvals.authorize.mockResolvedValueOnce(managerApproval);
    const withPin = { ...aboveCap, approval: { staffProfileId: 'staff-b', pin: '1234' } };
    const approval = await authorizeVoucherIssue(db() as never, scope, withPin);
    expect(approvals.authorize).toHaveBeenCalledWith(expect.anything(), scope, 'DISCOUNT', {
      staffProfileId: 'staff-b',
      pin: '1234',
    });
    const fake = db();
    await issueVoucher(fake as never, scope, withPin, approval);
    expect(approvals.confirm).toHaveBeenCalledWith(fake, scope, 'DISCOUNT', managerApproval);
    expect(fake.create.mock.calls[0]![0].data).toMatchObject({
      issuedByUserId: 'owner-a',
      approvedByUserId: 'manager-b',
      approvalPolicy: 'MANAGER_PIN',
      approvalCredentialId: 'credential-b',
    });
    expect(fake.audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'owner-a',
        action: 'pharmacy_voucher_approval',
        targetId: 'voucher-a',
        metadata: expect.objectContaining({ approvedByUserId: 'manager-b', selfApproved: false }),
      }),
    });
  });

  it('lets a solo owner approve with a fresh PIN and leaves an audit record', async () => {
    const fake = db();
    await issueVoucher(fake as never, scope, aboveCap, soloApproval);
    expect(fake.create.mock.calls[0]![0].data).toMatchObject({
      issuedByUserId: 'owner-a',
      approvedByUserId: 'owner-a',
      approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
    });
    expect(fake.audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          policy: 'SOLE_APPROVER_PIN_REAUTH',
          selfApproved: true,
          pinVerified: true,
        }),
      }),
    });
  });
});

describe('DEV-819 voucher revocation', () => {
  it('revokes a live voucher in this branch and records who revoked it', async () => {
    const fake = db();
    await expect(
      revokeVoucher(fake as never, scope, {
        branchId: 'branch-a',
        voucherId: 'voucher-a',
        reason: 'Code leaked',
      })
    ).resolves.toEqual({ voucherId: 'voucher-a', revoked: true });
    expect(fake.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'voucher-a',
        organizationId: 'org-a',
        branchId: 'branch-a',
        revokedAt: null,
      },
      data: {
        active: false,
        revokedAt: expect.any(Date),
        revokedByUserId: 'owner-a',
        revokeReason: 'Code leaked',
      },
    });
  });

  it('refuses a missing or already revoked voucher', async () => {
    const fake = db();
    fake.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      revokeVoucher(fake as never, scope, {
        branchId: 'branch-a',
        voucherId: 'voucher-a',
        reason: 'Code leaked',
      })
    ).rejects.toThrow(MarketingWorkflowError);
  });
});
