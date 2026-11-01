import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyMedicineRouter } from './pharmacy-medicine';
import type { TRPCContext } from '../trpc';

describe('review assertion bounds', () => {
  it('rejects 21 assertion IDs before opening a transaction', async () => {
    const db = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ organizationRole: null, permissionOverrides: [] }),
      },
      $transaction: vi.fn(),
    };
    const caller = pharmacyMedicineRouter.createCaller({
      db,
      entitlements: {
        organizationId: 'org_a',
        enabledModules: ['pharmacy-core'],
        activeSeats: 1,
        seatLimit: 10,
        modules: [],
        limits: {},
      },
      session: { expires: 'later', user: { id: 'user_a', role: 'ADMIN', status: 'ACTIVE' } },
      organization: null,
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext);

    await expect(
      caller.recordReviewDecision({
        duplicateKey: 'duplicate',
        action: 'ACCEPT',
        medicineIds: ['medicine'],
        payload: {
          assertionIds: Array.from({ length: 21 }, (_, index) => `assertion_${index}`),
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
