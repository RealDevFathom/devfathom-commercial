import { beforeEach, describe, expect, it, vi } from 'vitest';
import { router, type TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const recordAudit = vi.hoisted(() => vi.fn());
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  recordTrpcAudit: recordAudit,
}));

const application = router({ organizationAdmin: organizationAdminRouter });
const org = 'provider-refund-settings-org';
const account = 'CARD_REFUNDS_PAYABLE' as const;
const update = vi.fn();
const owner = vi.fn();
const accountant = vi.fn();
function context() {
  return {
    session: { user: { id: 'operator', role: 'ADMIN', organizationId: org, status: 'ACTIVE' } },
    db: { organization: { update }, user: { findUnique: owner, findFirst: accountant } },
    organization: { id: org },
    entitlements: { organizationId: org, vertical: 'PHARMACY', enabledModules: ['pharmacy-core'] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}
beforeEach(() => vi.resetAllMocks());

describe('organization-wide provider refund mapping', () => {
  it('audits the organization whose owner changes the liability mapping', async () => {
    owner.mockResolvedValue({
      role: 'ADMIN',
      status: 'ACTIVE',
      organizationRole: { isSystem: true, key: 'owner', permissions: [] },
      permissionOverrides: [],
    });
    const ctx = context();
    const settings = application.createCaller(ctx).organizationAdmin.pharmacySettings;
    await expect(
      settings.setRefundMapping({ usesCustomFinanceChart: true, account })
    ).resolves.toEqual({ saved: true });
    expect(update).toHaveBeenCalledWith({
      where: { id: org },
      data: { usesCustomFinanceChart: true, terminalRefundAccount: account },
    });
    expect(ctx.audit.detail).toMatchObject({
      targetType: 'Organization',
      targetId: org,
      operation: 'UPDATE',
      metadata: { account, usesCustomFinanceChart: true },
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'organizationAdmin.pharmacySettings.setRefundMapping',
        outcome: 'SUCCESS',
      })
    );
  });
  it('lets an active designated accountant with financial permission update the mapping', async () => {
    owner.mockResolvedValue({
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      organizationRole: { permissions: [{ capability: 'reports:financial', effect: 'ALLOW' }] },
      permissionOverrides: [],
    });
    accountant.mockResolvedValue({ id: 'operator' });
    const settings = application.createCaller(context()).organizationAdmin.pharmacySettings;
    await expect(
      settings.setRefundMapping({ usesCustomFinanceChart: true, account })
    ).resolves.toEqual({ saved: true });
    expect(accountant).toHaveBeenCalledWith({
      where: {
        id: 'operator',
        organizationId: org,
        status: 'ACTIVE',
        organizationRole: { key: 'accountant' },
      },
      select: { id: true },
    });
  });

  it('respects a financial permission denial even for the designated accountant', async () => {
    owner.mockResolvedValue({
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      organizationRole: { permissions: [{ capability: 'reports:financial', effect: 'ALLOW' }] },
      permissionOverrides: [{ capability: 'reports:financial', effect: 'DENY' }],
    });
    accountant.mockResolvedValue({ id: 'operator' });
    const settings = application.createCaller(context()).organizationAdmin.pharmacySettings;
    await expect(
      settings.setRefundMapping({ usesCustomFinanceChart: true, account })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(update).not.toHaveBeenCalled();
  });
  it('audits a refusal for an administrator who is neither the owner nor the accountant', async () => {
    owner.mockResolvedValue(null);
    accountant.mockResolvedValue(null);
    const settings = application.createCaller(context()).organizationAdmin.pharmacySettings;
    await expect(
      settings.setRefundMapping({ usesCustomFinanceChart: false, account: null })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(update).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
  });
});
