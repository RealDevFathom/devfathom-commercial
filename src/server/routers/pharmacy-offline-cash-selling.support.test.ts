// @vitest-environment node
/**
 * DEV-1053: the offline cash selling switch is the owner's. A platform support session acting
 * as the owner is refused before anything is read or written, the same way `setCashMode` is;
 * the owner's own session still reaches the write.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(async () => true),
}));

import type { TRPCContext } from '../trpc';
import { pharmacyOfflineRouter } from './pharmacy-offline';

function fixture(support: 'none' | 'support' | 'session-flag') {
  const transaction = vi.fn(async () => ({ enabled: false, available: false }));
  const context = {
    db: { $transaction: transaction },
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'owner-1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: 'org-a',
        ...(support === 'session-flag' ? { isSupportSession: true } : {}),
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support:
      support === 'support'
        ? { supportSessionId: 'support_session_1', platformUserId: 'platform_operator_1' }
        : null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return {
    transaction,
    caller: pharmacyOfflineRouter.createCaller(context as unknown as TRPCContext),
  };
}

const input = { branchId: 'branch-a', enabled: false };

describe('DEV-1053 offline cash selling is the owner’s own switch', () => {
  it.each(['support', 'session-flag'] as const)(
    'refuses a support session before reading or writing (%s)',
    async (kind) => {
      const f = fixture(kind);
      await expect(f.caller.setOfflineCashSelling(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only the owner can change this.',
      });
      expect(f.transaction).not.toHaveBeenCalled();
    }
  );

  it('still reaches the write for the owner’s own session', async () => {
    const f = fixture('none');
    await expect(f.caller.setOfflineCashSelling(input)).resolves.toEqual({
      enabled: false,
      available: false,
    });
    expect(f.transaction).toHaveBeenCalledTimes(1);
  });
});
