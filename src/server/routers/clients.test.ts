import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  groupBy: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import type { TRPCContext } from '../trpc';
import { clientsRouter } from './clients';

function caller() {
  return clientsRouter.createCaller({
    db: {
      client: { findMany: mocks.findMany },
      invoice: { groupBy: mocks.groupBy },
    },
    entitlements: { enabledModules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'admin-1',
        organizationId: 'org-1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('clients.getAll revenue totals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([
      {
        id: 'client-1',
        name: 'Acme',
        contacts: [],
        _count: { projects: 0, invoices: 2, documents: 0 },
      },
      {
        id: 'client-2',
        name: 'Globex',
        contacts: [],
        _count: { projects: 0, invoices: 1, documents: 0 },
      },
      {
        id: 'client-3',
        name: 'Initech',
        contacts: [],
        _count: { projects: 0, invoices: 0, documents: 0 },
      },
    ]);
    mocks.groupBy.mockResolvedValue([
      { clientId: 'client-1', currency: 'PKR', _sum: { total: 100 } },
      { clientId: 'client-1', currency: 'USD', _sum: { total: 100 } },
      { clientId: 'client-2', currency: 'PKR', _sum: { total: 250 } },
    ]);
  });

  it('groups and returns paid revenue separately in deterministic currency order', async () => {
    const result = await caller().getAll();

    expect(mocks.groupBy).toHaveBeenCalledWith({
      by: ['clientId', 'currency'],
      where: { status: 'PAID' },
      _sum: { total: true },
    });
    expect(result[0].totalRevenue).toEqual([
      { currency: 'USD', amount: 100 },
      { currency: 'PKR', amount: 100 },
    ]);
    expect(result[1].totalRevenue).toEqual([{ currency: 'PKR', amount: 250 }]);
    expect(result[2].totalRevenue).toEqual([]);
  });
});
