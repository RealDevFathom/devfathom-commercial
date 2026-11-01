/* eslint-disable @typescript-eslint/no-explicit-any -- command-boundary mocks expose only exercised delegates. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  platformContract: {
    create: vi.fn(async ({ data }: any) => ({ id: 'contract_1', ...data })),
    findUnique: vi.fn(),
    update: vi.fn(async ({ data }: any) => ({
      id: 'contract_1',
      organizationId: 'org_1',
      ...data,
    })),
  },
  platformModule: { findMany: vi.fn(async () => []) },
  organizationModule: { upsert: vi.fn(), updateMany: vi.fn() },
  organization: { update: vi.fn() },
  platformAuditLog: { create: vi.fn(async ({ data }: any) => data) },
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: (run: any) => run(db) }));

import { executePlatformCommand } from './commands';

const actor = { id: 'operator_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control');
const common = {
  organizationId: 'org_1',
  number: 'CON-406',
  title: 'Temporary expansion',
  currency: 'USD',
  value: 1000,
  billingInterval: 'ANNUAL',
  seatLimit: 100,
  startDate: '2026-10-01T00:00:00.000Z',
  endDate: '2027-10-01T00:00:00.000Z',
  moduleIds: [],
};

describe('contract seat entitlements', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the durable organization limit when creating a live contract', async () => {
    await executePlatformCommand(
      actor,
      'commercial.contract.create',
      {
        ...common,
        status: 'ACTIVE',
      },
      request
    );

    expect(db.platformContract.create).toHaveBeenCalled();
    expect(db.organization.update).not.toHaveBeenCalled();
  });

  it('keeps the durable organization limit through live and expired status changes', async () => {
    db.platformContract.findUnique.mockResolvedValue({
      id: 'contract_1',
      organizationId: 'org_1',
      number: 'CON-406',
      seatLimit: 100,
      signedAt: null,
      notes: null,
      endDate: new Date(common.endDate),
      graceUntil: null,
      modules: [],
    });

    for (const status of ['ACTIVE', 'EXPIRED'] as const) {
      await executePlatformCommand(
        actor,
        'commercial.contract.status',
        {
          id: 'contract_1',
          status,
          reason: `Move contract to ${status}`,
        },
        request
      );
    }

    expect(db.organization.update).not.toHaveBeenCalled();
    expect(db.organizationModule.updateMany).toHaveBeenCalledTimes(1);
  });
});
