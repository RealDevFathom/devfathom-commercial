import { beforeEach, describe, expect, it, vi } from 'vitest';
import { router, type TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const requestAudit = vi.hoisted(() => vi.fn());
const verifyPin = vi.hoisted(() => vi.fn());
const otherApprovers = vi.hoisted(() => vi.fn());
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  recordTrpcAudit: requestAudit,
}));
vi.mock('@/lib/pharmacy/refund-authorization', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/refund-authorization')>()),
  authenticateRefundPin: verifyPin,
}));
vi.mock('@/lib/pharmacy/accounts/ap-reversal-approvers', () => ({
  otherApReversalApprovers: otherApprovers,
}));
const application = router({ organizationAdmin: organizationAdminRouter });
const org = 'provider-refund-settings-org';
const account = 'ACCOUNTS_PAYABLE' as const;
const input = { usesCustomFinanceChart: true, account, pin: '4926' };
const old = { terminalRefundAccount: null, usesCustomFinanceChart: false };
const update = vi.fn();
const writeAudit = vi.fn();
const currentSettings = vi.fn();
const tenantMember = vi.fn();
const roles = (capability: string) => ({ capability, effect: 'ALLOW' });
function member(capabilities: string[], owner = false) {
  return {
    role: 'ADMIN',
    status: 'ACTIVE',
    organizationRole: {
      key: owner ? 'owner' : 'custom-bookkeeper',
      isSystem: owner,
      permissions: capabilities.map(roles),
    },
    permissionOverrides: [],
  };
}
function context() {
  const db = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(db),
    $queryRaw: vi.fn(),
    organization: { update, findUniqueOrThrow: currentSettings },
    auditLog: { create: writeAudit },
    user: { findUnique: tenantMember },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch' }) },
  };
  return {
    session: { user: { id: 'operator', role: 'ADMIN', organizationId: org, status: 'ACTIVE' } },
    db,
    organization: { id: org },
    entitlements: {
      organizationId: org,
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-core', 'pharmacy-finance'],
    },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}
function caller(ctx = context()) {
  return application.createCaller(ctx).organizationAdmin.pharmacySettings;
}
beforeEach(() => {
  vi.resetAllMocks();
  currentSettings.mockResolvedValue(old);
  otherApprovers.mockResolvedValue([]);
  verifyPin.mockResolvedValue({ verified: true });
});
describe('organization-wide provider refund mapping', () => {
  it('lets a finance reader view the account and forbids changing it without management', async () => {
    tenantMember.mockResolvedValue(member(['finance:read']));
    await expect(caller().refundMapping()).resolves.toEqual({ ...old, canEdit: false });
    await expect(caller().setRefundMapping(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(update).not.toHaveBeenCalled();
    expect(verifyPin).not.toHaveBeenCalled();
    expect(requestAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
  });
  it.each([true, false])(
    'audits the owner or explicitly granted finance manager, owner=%s',
    async (owner) => {
      tenantMember.mockResolvedValue(
        member(owner ? ['pharmacy:manage'] : ['finance:read', 'pharmacy:manage'], owner)
      );
      const ctx = context();
      await expect(caller(ctx).setRefundMapping(input)).resolves.toEqual({ saved: true });
      expect(verifyPin).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: org, actorId: 'operator', pin: input.pin })
      );
      expect(update).toHaveBeenCalledWith({
        where: { id: org },
        data: {
          usesCustomFinanceChart: true,
          terminalRefundAccount: account,
          terminalRefundMappingActorId: 'operator',
        },
      });
      expect(writeAudit).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: org,
          actorId: 'operator',
          targetType: 'Organization',
          targetId: org,
          changes: {
            account: { before: 'CARD_REFUNDS_PAYABLE', after: account },
            terminalRefundAccount: { before: null, after: account },
            usesCustomFinanceChart: { before: false, after: true },
          },
        }),
      });
      expect(ctx.audit.detail).toMatchObject({
        skipInput: true,
        targetType: 'Organization',
        targetId: org,
        operation: 'UPDATE',
        metadata: { account, usesCustomFinanceChart: true },
      });
      expect(requestAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'organizationAdmin.pharmacySettings.setRefundMapping',
          outcome: 'SUCCESS',
        })
      );
    }
  );
  it('respects a personal finance denial even with management and a finance grant', async () => {
    tenantMember.mockResolvedValue({
      ...member(['finance:read', 'pharmacy:manage']),
      permissionOverrides: [{ capability: 'finance:read', effect: 'DENY' }],
    });
    await expect(caller().refundMapping()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().setRefundMapping(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(update).not.toHaveBeenCalled();
  });
  it('denies a coarse administrator without an owner identity or finance grant', async () => {
    tenantMember.mockResolvedValue(member(['pharmacy:manage']));
    await expect(caller().setRefundMapping(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(update).not.toHaveBeenCalled();
    expect(requestAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
  });
  it('requires another eligible approver to change their own entry and checks a fresh credential', async () => {
    tenantMember.mockResolvedValue(member(['finance:read', 'pharmacy:manage']));
    currentSettings.mockResolvedValue({ ...old, terminalRefundMappingActorId: 'operator' });
    otherApprovers.mockResolvedValue([{ name: 'Reviewer' }]);
    await expect(caller().setRefundMapping(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(verifyPin).not.toHaveBeenCalled();
    otherApprovers.mockResolvedValue([]);
    verifyPin.mockResolvedValue({ blocked: 'refused' });
    await expect(caller().setRefundMapping(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(update).not.toHaveBeenCalled();
  });
});
