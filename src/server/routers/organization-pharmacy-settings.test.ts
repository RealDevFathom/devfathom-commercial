import { beforeEach, describe, expect, it, vi } from 'vitest';
import { router, type TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const requestAudit = vi.hoisted(() => vi.fn());
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  recordTrpcAudit: requestAudit,
}));
const application = router({ organizationAdmin: organizationAdminRouter });
const org = 'provider-refund-settings-org';
const account = 'ACCOUNTS_PAYABLE' as const;
const input = { usesCustomFinanceChart: true, account, pin: '4926' };
const update = vi.fn();
const writeAudit = vi.fn();
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
    organization: { update },
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
});
describe('fixed provider refund liability', () => {
  it.each([true, false])(
    'shows the same read-only account to an authorized reader (owner=%s)',
    async (owner) => {
      tenantMember.mockResolvedValue(member(['finance:read'], owner));
      await expect(caller().refundMapping()).resolves.toEqual({
        terminalRefundAccount: 'CARD_REFUNDS_PAYABLE',
      });
      // @ts-expect-error the account is fixed even for a caller bypassing the form
      await expect(caller().refundMapping(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(application._def.procedures).not.toHaveProperty(
        'organizationAdmin.pharmacySettings.setRefundMapping'
      );
      expect(update).not.toHaveBeenCalled();
    }
  );
  it('requires finance read access', async () => {
    tenantMember.mockResolvedValue(member([]));
    await expect(caller().refundMapping()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
