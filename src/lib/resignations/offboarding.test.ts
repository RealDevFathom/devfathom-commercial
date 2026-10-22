import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenancy = vi.hoisted(() => ({
  withPlatformDb: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('@/lib/tenancy/scoped-db', () => tenancy);

import {
  DUE_OFFBOARDING_ORGANIZATIONS_SQL,
  offboardDueResignationsForTenant,
  processDueResignationOffboarding,
} from './offboarding';

describe('scheduled resignation offboarding', () => {
  const now = new Date('2026-10-23T00:00:00.000Z');
  const query = vi.fn();
  const updateMany = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    tenancy.withPlatformDb.mockImplementation(
      (run: (db: { $queryRawUnsafe: typeof query }) => unknown) =>
        run({ $queryRawUnsafe: query })
    );
    tenancy.withTenantDb.mockImplementation(
      (
        _organizationId: string,
        run: (db: { user: { updateMany: typeof updateMany } }) => unknown
      ) => run({ user: { updateMany } })
    );
    updateMany.mockResolvedValue({ count: 1 });
  });

  it('discovers due tenants, then deactivates users only inside each tenant scope', async () => {
    query.mockResolvedValue([{ organizationId: 'org-a' }, { organizationId: 'org-b' }]);

    await expect(processDueResignationOffboarding(now)).resolves.toEqual({
      organizations: 2,
      users: 2,
    });

    expect(query).toHaveBeenCalledWith(DUE_OFFBOARDING_ORGANIZATIONS_SQL, now, 100);
    expect(tenancy.withTenantDb.mock.calls.map(([organizationId]) => organizationId)).toEqual([
      'org-a',
      'org-b',
    ]);
  });

  it('rechecks approval and due date while atomically revoking active sessions', async () => {
    await expect(offboardDueResignationsForTenant('org-a', now)).resolves.toBe(1);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: { not: 'INACTIVE' },
        resignations: { some: { status: 'APPROVED', lastWorkingDay: { lte: now } } },
      },
      data: { status: 'INACTIVE', tokenVersion: { increment: 1 } },
    });
    expect(tenancy.withTenantDb).toHaveBeenCalledWith('org-a', expect.any(Function), {
      skipDrain: true,
    });
  });
});
