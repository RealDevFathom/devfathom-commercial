import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { clientsRouter } from './clients';

const findMany = vi.fn();
const groupBy = vi.fn();

function caller(role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN') {
  return clientsRouter.createCaller({
    db: { client: { findMany }, invoice: { groupBy } },
    session: {
      expires: 'later',
      user: { id: 'user-1', role, status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    entitlements: { organizationId: 'org-1', enabledModules: [], modules: [], limits: {} },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

describe('clients.getAll revenue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([
      {
        id: 'client-1',
        name: 'Acme',
        contacts: [],
        _count: { projects: 0, invoices: 2, documents: 0 },
      },
    ]);
    groupBy.mockResolvedValue([
      { clientId: 'client-1', currency: 'USD', _sum: { total: 100 } },
      { clientId: 'client-1', currency: 'PKR', _sum: { total: 100 } },
    ]);
  });

  it('queries and returns paid revenue separately by currency', async () => {
    const [client] = await caller().getAll();

    expect(groupBy).toHaveBeenCalledWith({
      by: ['clientId', 'currency'],
      where: { status: 'PAID' },
      _sum: { total: true },
    });
    expect(client.totalRevenue).toEqual([
      { currency: 'USD', amount: 100 },
      { currency: 'PKR', amount: 100 },
    ]);
  });

  it('does not query or expose revenue to non-admins', async () => {
    const [client] = await caller('EMPLOYEE').getAll();

    expect(groupBy).not.toHaveBeenCalled();
    expect(client.totalRevenue).toEqual([]);
    expect(client._count.invoices).toBe(0);
  });
});
