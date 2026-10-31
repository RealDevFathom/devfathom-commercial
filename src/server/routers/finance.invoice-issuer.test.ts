import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  invoiceFindUnique: vi.fn(),
  organizationFindUnique: vi.fn(),
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
      invoice: { findUnique: mocks.invoiceFindUnique },
      organization: { findUnique: mocks.organizationFindUnique },
    },
    entitlements: { organizationId: 'agency-1', enabledModules: [], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'admin-1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'agency-1' },
    },
    organization: { id: 'agency-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('finance.getInvoiceById issuer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoiceFindUnique.mockResolvedValue({ total: 110, payments: [] });
    mocks.organizationFindUnique.mockResolvedValue({
      legalName: 'Northwind Agency LLC',
      invoiceAddress: '42 Market Street',
      taxId: 'US-12-3456789',
    });
  });

  it('selects seller identity from the authenticated agency', async () => {
    const result = await caller().getInvoiceById({ id: 'invoice-1' });

    expect(mocks.organizationFindUnique).toHaveBeenCalledWith({
      where: { id: 'agency-1' },
      select: { legalName: true, invoiceAddress: true, taxId: true },
    });
    expect(result?.issuer).toEqual({
      legalName: 'Northwind Agency LLC',
      invoiceAddress: '42 Market Street',
      taxId: 'US-12-3456789',
    });
  });
});
