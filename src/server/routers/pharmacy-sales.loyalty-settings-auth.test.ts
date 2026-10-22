import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const input = {
  voucherScope: 'WHOLE_BASKET' as const,
  voucherValidityDays: 30,
  maxIssuedPerCustomerPerPeriod: 5,
  maxIssuedPerPhonePerPeriod: 5,
  maxRedeemedPerCustomerPerPeriod: 5,
  maxRedeemedPerPhonePerPeriod: 5,
  abusePeriodDays: 30,
  expiryOverrideGraceDays: 0,
  spendVoucherTiers: [{ thresholdMinor: 1_000_000, valueMinor: 50_000 }],
  spendVoucherMinBasketMinor: 0,
};
type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

function fixture(rolePermissions: Permission[], overrides: Permission[] = []) {
  const transaction = vi.fn();
  const db = {
    user: { findUnique: vi.fn().mockResolvedValue({
      organizationRole: { permissions: rolePermissions }, permissionOverrides: overrides,
    }) },
    $transaction: transaction,
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: { expires: 'later', user: {
      id: 'user-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a',
    } },
    organization: { id: 'org-a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { caller: app.createCaller(context).pharmacySales, transaction };
}

describe('pharmacySales.updateLoyaltySettings authorization', () => {
  it('denies a restricted employee before beginning the settings transaction', async () => {
    const f = fixture([{ capability: 'pharmacy:counter', effect: 'ALLOW' }]);
    await expect(f.caller.updateLoyaltySettings(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('honors an explicit user deny before beginning the settings transaction', async () => {
    const f = fixture(
      [{ capability: 'pharmacy:loyalty-manage', effect: 'ALLOW' }],
      [{ capability: 'pharmacy:loyalty-manage', effect: 'DENY' }]
    );
    await expect(f.caller.updateLoyaltySettings(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.transaction).not.toHaveBeenCalled();
  });
});
