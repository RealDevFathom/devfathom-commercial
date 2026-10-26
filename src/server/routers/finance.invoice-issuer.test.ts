import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  findInvoice: vi.fn(),
  findOrganization: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
vi.mock('../audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { financeRouter } from './finance';

function caller() {
  return financeRouter.createCaller({
    db: {
      invoice: { findFirst: mocks.findInvoice },
      organization: { findUniqueOrThrow: mocks.findOrganization },
    },
    entitlements: { organizationId: 'agency-a', enabledModules: [], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'admin-1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'agency-a' },
    },
    organization: { id: 'agency-a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('finance.getInvoiceById issuer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findInvoice.mockResolvedValue({ id: 'invoice-1', total: 100, payments: [] });
    mocks.findOrganization.mockResolvedValue({
      displayName: 'Northwind Studio',
      legalName: 'Northwind Studio LLC',
      primaryContactEmail: 'accounts@northwind.example',
    });
  });

  it('returns issuer identity only from the authenticated agency tenant', async () => {
    const invoice = await caller().getInvoiceById({ id: 'invoice-1' });

    expect(mocks.findInvoice).toHaveBeenCalledExactlyOnceWith({
      where: { organizationId: 'agency-a', id: 'invoice-1' },
      include: {
        client: { include: { contacts: { where: { isPrimary: true }, take: 1 } } },
        project: { select: { id: true, name: true } },
        payments: { orderBy: { paidAt: 'desc' } },
      },
    });
    expect(mocks.findOrganization).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'agency-a' },
      select: { displayName: true, legalName: true, primaryContactEmail: true },
    });
    expect(invoice?.issuer).toEqual({
      displayName: 'Northwind Studio',
      legalName: 'Northwind Studio LLC',
      primaryContactEmail: 'accounts@northwind.example',
    });
  });

  it('returns null without reading issuer data when the tenant-scoped invoice is absent', async () => {
    mocks.findInvoice.mockResolvedValue(null);

    await expect(caller().getInvoiceById({ id: 'another-tenant-invoice' })).resolves.toBeNull();

    expect(mocks.findInvoice).toHaveBeenCalledWith({
      where: { organizationId: 'agency-a', id: 'another-tenant-invoice' },
      include: expect.any(Object),
    });
    expect(mocks.findOrganization).not.toHaveBeenCalled();
  });
});
