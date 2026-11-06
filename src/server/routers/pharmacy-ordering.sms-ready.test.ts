import { beforeEach, describe, expect, it, vi } from 'vitest';

// #723: marking an order ready triggers the SMS fallback after the transition
// commits, as the acting staff user. The notice is best effort and never fails
// or undoes the staff transition; other actions never notify.
const background = vi.hoisted(() => ({ tasks: [] as Array<() => Promise<unknown>> }));
vi.mock('next/server', () => ({
  after: (task: () => Promise<unknown>) => background.tasks.push(task),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/customer-ordering', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/customer-ordering')>()),
  transitionCustomerOrder: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sms/order-ready', () => ({ notifyOrderReadyBySms: vi.fn() }));

import { transitionCustomerOrder } from '@/lib/pharmacy/customer-ordering';
import { notifyOrderReadyBySms } from '@/lib/pharmacy/sms/order-ready';
import { router, type TRPCContext } from '../trpc';
import { pharmacyOrderingRouter } from './pharmacy-ordering';

const app = router({ pharmacyOrdering: pharmacyOrderingRouter });
const BRANCH = 'branch-1';
const order = { id: 'order-1', status: 'READY_FOR_COLLECTION' };

let db: {
  user: { findUnique: ReturnType<typeof vi.fn> };
  pharmacyBranch: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

function caller() {
  return app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyOrdering;
}

beforeEach(() => {
  background.tasks = [];
  vi.mocked(transitionCustomerOrder)
    .mockReset()
    .mockResolvedValue(order as never);
  vi.mocked(notifyOrderReadyBySms).mockReset().mockResolvedValue('PREPARED');
  db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: null,
        permissionOverrides: [{ capability: 'pharmacy:orders', effect: 'ALLOW' }],
      }),
    },
    pharmacyBranch: { findMany: vi.fn().mockResolvedValue([{ id: BRANCH }]) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
  };
});

describe('pharmacyOrdering.transition SMS order-ready fallback', () => {
  it('notifies by SMS after a committed ready transition, as the acting staff user', async () => {
    await expect(
      caller().transition({ branchId: BRANCH, orderId: 'order-1', action: 'ready' })
    ).resolves.toEqual(order);
    expect(notifyOrderReadyBySms).not.toHaveBeenCalled();
    expect(background.tasks).toHaveLength(1);
    await background.tasks[0]!();
    expect(notifyOrderReadyBySms).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'org-1',
      branchId: BRANCH,
      orderId: 'order-1',
      actorUserId: 'actor-1',
    });
  });

  it.each(['accept', 'pack', 'dispatch', 'cancel', 'expire'] as const)(
    'does not notify on %s',
    async (action) => {
      await caller().transition({ branchId: BRANCH, orderId: 'order-1', action });
      expect(notifyOrderReadyBySms).not.toHaveBeenCalled();
    }
  );

  it('keeps the transition result when the SMS notice fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(notifyOrderReadyBySms).mockRejectedValue(new Error('sensitive gateway payload'));
    await expect(
      caller().transition({ branchId: BRANCH, orderId: 'order-1', action: 'ready' })
    ).resolves.toEqual(order);
    await expect(background.tasks[0]!()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('PHARMACY_ORDER_READY_SMS_FAILED', {
      organizationId: 'org-1',
      orderId: 'order-1',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('sensitive');
    error.mockRestore();
  });

  it('does not notify when the transition itself fails', async () => {
    vi.mocked(transitionCustomerOrder).mockRejectedValue(new Error('boom'));
    await expect(
      caller().transition({ branchId: BRANCH, orderId: 'order-1', action: 'ready' })
    ).rejects.toThrow();
    expect(notifyOrderReadyBySms).not.toHaveBeenCalled();
  });
});
