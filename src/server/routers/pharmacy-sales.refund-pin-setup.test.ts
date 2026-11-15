import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-645: a manager or owner with no staff PIN can set their first one from the counter.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(), withTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  recordAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/refund-authorization', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/refund-authorization')>()),
  hasRefundPin: vi.fn(),
  provisionRefundPin: vi.fn(),
}));

import {
  hasRefundPin,
  provisionRefundPin,
  REFUND_PIN_EXISTS,
  RefundPinSetupError,
} from '@/lib/pharmacy/refund-authorization';
import { recordTrpcAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const app = router({ pharmacySales: pharmacySalesRouter });
const cashier: Rule[] = [{ capability: 'pharmacy:counter', effect: 'ALLOW' }];
const manager: Rule[] = [...cashier, { capability: 'pharmacy:manage', effect: 'ALLOW' }];

function fixture(rules: Rule[]) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-a',
        organizationRole: { permissions: rules },
        permissionOverrides: [],
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'user-a',
        name: 'Owner A',
        email: 'owner@example.invalid',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return {
    db,
    context,
    caller: app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasRefundPin).mockResolvedValue(true);
  vi.mocked(provisionRefundPin).mockResolvedValue({ id: 'cred-a', staffProfileId: 'staff-a' });
});

describe('DEV-645 refund PIN readiness', () => {
  it('reports a manager without a PIN as not ready', async () => {
    vi.mocked(hasRefundPin).mockResolvedValue(false);
    const f = fixture(manager);
    await expect(f.caller.refundAccess()).resolves.toEqual({ authorized: true, pinReady: false });
    expect(hasRefundPin).toHaveBeenCalledWith(f.db, 'org-a', 'user-a');
  });

  it('never looks up a PIN for a cashier', async () => {
    await expect(fixture(cashier).caller.refundAccess()).resolves.toEqual({
      authorized: false,
      pinReady: false,
    });
    expect(hasRefundPin).not.toHaveBeenCalled();
  });
});

describe('DEV-645 provisionMyRefundPin', () => {
  it('refuses a cashier before any write', async () => {
    const f = fixture(cashier);
    await expect(f.caller.provisionMyRefundPin({ pin: '7351' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only a manager or owner can refund.',
    });
    expect(provisionRefundPin).not.toHaveBeenCalled();
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it("sets a manager's own first PIN and keeps it out of the audit row", async () => {
    const f = fixture(manager);
    await expect(f.caller.provisionMyRefundPin({ pin: '7351' })).resolves.toEqual({
      id: 'cred-a',
      staffProfileId: 'staff-a',
    });
    expect(provisionRefundPin).toHaveBeenCalledExactlyOnceWith(f.db, {
      organizationId: 'org-a',
      userId: 'user-a',
      displayName: 'Owner A',
      pin: '7351',
    });
    expect(f.context.audit.detail).toMatchObject({ skipInput: true });
    // The audit writer replaces the input with '[skipped]' when this flag is set.
    const recorded = vi.mocked(recordTrpcAudit).mock.calls.at(-1)?.[0];
    expect(recorded?.ctx.audit?.detail.skipInput).toBe(true);
  });

  it('refuses to replace an existing PIN', async () => {
    vi.mocked(provisionRefundPin).mockRejectedValue(
      new RefundPinSetupError(REFUND_PIN_EXISTS, 'ALREADY_EXISTS')
    );
    await expect(
      fixture(manager).caller.provisionMyRefundPin({ pin: '7351' })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: REFUND_PIN_EXISTS });
  });

  it('rejects a malformed PIN at the input boundary', async () => {
    await expect(fixture(manager).caller.provisionMyRefundPin({ pin: '12' })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    expect(provisionRefundPin).not.toHaveBeenCalled();
  });
});
