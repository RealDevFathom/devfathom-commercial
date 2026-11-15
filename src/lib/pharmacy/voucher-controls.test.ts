import { describe, expect, it, vi } from 'vitest';

import {
  assertVoucherIssuerRights,
  voucherNeedsSecondApprover,
  VoucherIssuerRevoked,
} from './voucher-controls';

const crmLicensed = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(async () => ({})),
  hasModule: vi.fn((_view: unknown, key: string) => key === 'pharmacy-crm' && crmLicensed.value),
}));

const users: Record<string, Record<string, unknown>> = {
  'owner-a': { id: 'owner-a', organizationId: 'org-a', status: 'ACTIVE', role: 'ADMIN' },
  'manager-b': { id: 'manager-b', organizationId: 'org-a', status: 'ACTIVE', role: 'EMPLOYEE' },
};

function db(overrides: Record<string, Record<string, unknown> | null> = {}, branchActive = true) {
  const rows = { ...users, ...overrides };
  return {
    pharmacyBranch: { findFirst: async () => (branchActive ? { id: 'branch-a' } : null) },
    user: {
      findFirst: async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows[where.id]
          ? {
              organizationRole: null,
              permissionOverrides:
                where.id === 'manager-b'
                  ? [{ capability: 'pharmacy:manage', effect: 'ALLOW' }]
                  : [],
            }
          : null,
    },
  };
}

const withinCap = {
  id: 'voucher-a',
  discountMinor: 10_000,
  maxUses: 10,
  issuedByUserId: 'owner-a',
  approvedByUserId: 'owner-a',
  approvalPolicy: 'VOUCHER_WITHIN_CAP',
};
const aboveCap = {
  ...withinCap,
  discountMinor: 150_000,
  maxUses: 1,
  approvedByUserId: 'manager-b',
  approvalPolicy: 'MANAGER_PIN',
};

describe('DEV-819 voucher value cap', () => {
  it('needs a second approver above the per-use or total value cap', () => {
    expect(voucherNeedsSecondApprover({ discountMinor: 100_000, maxUses: 10 })).toBe(false);
    expect(voucherNeedsSecondApprover({ discountMinor: 100_001, maxUses: 1 })).toBe(true);
    expect(voucherNeedsSecondApprover({ discountMinor: 50_000, maxUses: 21 })).toBe(true);
  });
});

describe('DEV-819 issuer re-check at redemption', () => {
  it('returns the recorded approver while the issuer and approver keep their rights', async () => {
    await expect(
      assertVoucherIssuerRights(db() as never, 'org-a', 'branch-a', withinCap)
    ).resolves.toBe('owner-a');
    await expect(
      assertVoucherIssuerRights(db() as never, 'org-a', 'branch-a', aboveCap)
    ).resolves.toBe('manager-b');
  });

  it('refuses once the issuer is no longer an active owner', async () => {
    for (const issuer of [
      null,
      { ...users['owner-a'], role: 'EMPLOYEE' },
      { ...users['owner-a'], status: 'SUSPENDED' },
      { ...users['owner-a'], organizationId: 'org-b' },
    ]) {
      await expect(
        assertVoucherIssuerRights(
          db({ 'owner-a': issuer }) as never,
          'org-a',
          'branch-a',
          withinCap
        )
      ).rejects.toThrow(VoucherIssuerRevoked);
    }
  });

  it('refuses once the second approver is no longer an active manager', async () => {
    await expect(
      assertVoucherIssuerRights(db({ 'manager-b': null }) as never, 'org-a', 'branch-a', aboveCap)
    ).rejects.toThrow(VoucherIssuerRevoked);
  });

  it('never accepts the issuer as the approver above the cap without the solo-owner record', async () => {
    for (const voucher of [
      { ...aboveCap, approvedByUserId: 'owner-a' },
      { ...aboveCap, approvalPolicy: 'VOUCHER_WITHIN_CAP' },
      { ...aboveCap, approvedByUserId: null },
    ]) {
      await expect(
        assertVoucherIssuerRights(db() as never, 'org-a', 'branch-a', voucher)
      ).rejects.toThrow(VoucherIssuerRevoked);
    }
    await expect(
      assertVoucherIssuerRights(db() as never, 'org-a', 'branch-a', {
        ...aboveCap,
        approvedByUserId: 'owner-a',
        approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
      })
    ).resolves.toBe('owner-a');
  });
});

describe('DEV-842 branch and CRM module re-check at redemption', () => {
  it('refuses when the branch is no longer active', async () => {
    await expect(
      assertVoucherIssuerRights(db({}, false) as never, 'org-a', 'branch-a', withinCap)
    ).rejects.toThrow(VoucherIssuerRevoked);
  });

  it('refuses when the CRM module is no longer licensed', async () => {
    crmLicensed.value = false;
    try {
      await expect(
        assertVoucherIssuerRights(db() as never, 'org-a', 'branch-a', withinCap)
      ).rejects.toThrow(VoucherIssuerRevoked);
    } finally {
      crmLicensed.value = true;
    }
  });
});
