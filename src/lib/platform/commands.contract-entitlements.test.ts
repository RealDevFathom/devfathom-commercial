import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ assertPlatformCapability: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({
  assertPlatformCapability: mocks.assertPlatformCapability,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
}));

const organizationUpdate = vi.fn();
const contractCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
  id: 'contract_337',
  ...args.data,
}));

const platformDb = {
  platformContract: { create: contractCreate },
  platformModule: {
    findMany: vi.fn(async () => [{ id: 'module_catalogue' }]),
  },
  organizationModule: {
    upsert: vi.fn(async () => ({ id: 'entitlement_1' })),
  },
  organization: { update: organizationUpdate },
  platformAuditLog: { create: vi.fn(async () => ({ id: 'audit_1' })) },
};

import { executePlatformCommand } from './commands';

const actor = { id: 'operator_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', {
  method: 'POST',
});

describe('contract seat entitlements', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the organization base seat limit separate from an active contract allowance', async () => {
    await executePlatformCommand(
      actor,
      'commercial.contract.create',
      {
        organizationId: 'org_337',
        number: 'CON-337',
        title: 'Temporary expansion',
        status: 'ACTIVE',
        currency: 'USD',
        value: 1_000,
        billingInterval: 'ANNUAL',
        seatLimit: 250,
        startDate: '2026-10-01T00:00:00.000Z',
        endDate: '2027-10-01T00:00:00.000Z',
        moduleIds: ['module_catalogue'],
      },
      request
    );

    expect(contractCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seatLimit: 250 }) })
    );
    expect(platformDb.organizationModule.upsert).toHaveBeenCalledTimes(1);
    expect(organizationUpdate).not.toHaveBeenCalled();
  });
});
