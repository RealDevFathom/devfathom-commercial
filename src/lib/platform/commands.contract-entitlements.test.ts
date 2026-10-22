import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  contractCreate: vi.fn(),
  moduleFindUnique: vi.fn(),
  moduleUpsert: vi.fn(),
  moduleUpdateMany: vi.fn(),
  organizationUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));

const platformDb = {
  platformContract: { create: mocks.contractCreate },
  organizationModule: {
    findUnique: mocks.moduleFindUnique,
    upsert: mocks.moduleUpsert,
    updateMany: mocks.moduleUpdateMany,
  },
  organization: { update: mocks.organizationUpdate },
  platformAuditLog: { create: mocks.auditCreate },
};

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: typeof platformDb) => Promise<unknown>) => run(platformDb)),
}));

import { executePlatformCommand } from './commands';

const actor = { id: 'operator_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

describe('commercial contract entitlement synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.contractCreate.mockResolvedValue({ id: 'contract_1' });
    mocks.moduleFindUnique.mockResolvedValue(null);
    mocks.moduleUpsert.mockResolvedValue({ id: 'override_1' });
    mocks.moduleUpdateMany.mockResolvedValue({ count: 0 });
    mocks.organizationUpdate.mockResolvedValue({ id: 'org_1' });
    mocks.auditCreate.mockResolvedValue({ id: 'audit_1' });
  });

  it('creates overrides only for modules included in the contract', async () => {
    const endDate = '2027-10-21T00:00:00.000Z';

    await executePlatformCommand(
      actor,
      'commercial.contract.create',
      {
        organizationId: 'org_1',
        number: 'CON-304',
        title: 'Package-safe contract',
        status: 'ACTIVE',
        currency: 'USD',
        value: 1200,
        billingInterval: 'ANNUAL',
        seatLimit: 10,
        startDate: '2026-10-21T00:00:00.000Z',
        endDate,
        moduleIds: ['mod_contract'],
      },
      request
    );

    expect(mocks.moduleUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.moduleUpsert).toHaveBeenCalledWith({
      where: {
        organizationId_moduleId: {
          organizationId: 'org_1',
          moduleId: 'mod_contract',
        },
      },
      update: {
        status: 'ENABLED',
        expiresAt: new Date(endDate),
        reason: 'Contract CON-304',
        changedById: 'operator_1',
        sourceContractId: 'contract_1',
      },
      create: {
        organizationId: 'org_1',
        moduleId: 'mod_contract',
        status: 'ENABLED',
        expiresAt: new Date(endDate),
        reason: 'Contract CON-304',
        changedById: 'operator_1',
        sourceContractId: 'contract_1',
      },
    });
  });

  it('expires only proven grants omitted by a superseding contract', async () => {
    await executePlatformCommand(
      actor,
      'commercial.contract.create',
      {
        organizationId: 'org_1',
        number: 'CON-NEW',
        title: 'Superseding contract',
        status: 'ACTIVE',
        currency: 'USD',
        value: 1200,
        billingInterval: 'ANNUAL',
        seatLimit: 10,
        startDate: '2026-10-21T00:00:00.000Z',
        endDate: '2027-10-21T00:00:00.000Z',
        moduleIds: ['mod_retained'],
      },
      request
    );

    expect(mocks.moduleUpdateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        sourceContractId: { not: 'contract_1' },
        moduleId: { notIn: ['mod_retained'] },
        status: 'ENABLED',
      },
      data: {
        status: 'EXPIRED',
        expiresAt: expect.any(Date),
        reason: 'Superseded by Contract CON-NEW',
        changedById: 'operator_1',
      },
    });
  });

  it('does not overwrite an explicit deny with a contract allow', async () => {
    mocks.moduleFindUnique.mockResolvedValue({ sourceContractId: null });

    await executePlatformCommand(
      actor,
      'commercial.contract.create',
      {
        organizationId: 'org_1',
        number: 'CON-DENY',
        title: 'Contract cannot override deny',
        status: 'ACTIVE',
        currency: 'USD',
        value: 1200,
        billingInterval: 'ANNUAL',
        seatLimit: 10,
        startDate: '2026-10-21T00:00:00.000Z',
        endDate: '2027-10-21T00:00:00.000Z',
        moduleIds: ['mod_denied'],
      },
      request
    );

    expect(mocks.moduleUpsert).not.toHaveBeenCalled();
  });
});
