import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  invoiceFindUnique: vi.fn(),
  organizationFindUniqueOrThrow: vi.fn(),
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
      organization: { findUniqueOrThrow: mocks.organizationFindUniqueOrThrow },
    },
    entitlements: { organizationId: 'org-1', enabledModules: [], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'admin-1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('finance.getInvoiceById issuer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.invoiceFindUnique.mockResolvedValue({
      id: 'invoice-1',
      total: 125,
      payments: [],
    });
    mocks.organizationFindUniqueOrThrow.mockResolvedValue({
      legalName: 'Tenant Legal Ltd',
      displayName: 'Tenant Studio',
      brand: { logoUrl: 'https://tenant.example/logo.png' },
    });
  });

  it('returns branding only for the authenticated workspace issuer', async () => {
    const invoice = await caller().getInvoiceById({ id: 'invoice-1' });

    expect(mocks.organizationFindUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: {
        legalName: true,
        displayName: true,
        brand: { select: { logoUrl: true } },
      },
    });
    expect(invoice?.issuer).toEqual({
      legalName: 'Tenant Legal Ltd',
      displayName: 'Tenant Studio',
      brand: { logoUrl: 'https://tenant.example/logo.png' },
    });
  });

  it('does not fetch issuer details when the invoice is not visible', async () => {
    mocks.invoiceFindUnique.mockResolvedValue(null);

    await expect(caller().getInvoiceById({ id: 'missing' })).resolves.toBeNull();
    expect(mocks.organizationFindUniqueOrThrow).not.toHaveBeenCalled();
  });
});
