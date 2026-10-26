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

function caller(organizationId = 'org-agency') {
  return financeRouter.createCaller({
    db: {
      invoice: { findUnique: mocks.findInvoice },
      organization: { findUnique: mocks.findOrganization },
    },
    entitlements: { organizationId, enabledModules: [], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'admin-1', role: 'ADMIN', status: 'ACTIVE', organizationId },
    },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('finance.getInvoiceById issuer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.findInvoice.mockResolvedValue({
      id: 'invoice-1',
      total: 125,
      payments: [],
      client: { name: 'Customer', contacts: [] },
      project: null,
    });
    mocks.findOrganization.mockResolvedValue({
      displayName: 'Northstar Studio',
      legalName: 'Northstar Studio Limited',
      brand: {
        logoUrl: 'https://assets.example/northstar.svg',
        supportEmail: 'billing@example.com',
      },
    });
  });

  it('returns the authenticated tenant identity and brand as the invoice issuer', async () => {
    const invoice = await caller().getInvoiceById({ id: 'invoice-1' });

    expect(mocks.findInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'invoice-1', organizationId: 'org-agency' } })
    );
    expect(mocks.findOrganization).toHaveBeenCalledWith({
      where: { id: 'org-agency' },
      select: {
        displayName: true,
        legalName: true,
        brand: { select: { logoUrl: true, supportEmail: true } },
      },
    });
    expect(invoice?.issuer).toEqual({
      displayName: 'Northstar Studio',
      legalName: 'Northstar Studio Limited',
      brand: {
        logoUrl: 'https://assets.example/northstar.svg',
        supportEmail: 'billing@example.com',
      },
    });
  });

  it('does not query or disclose issuer data when the scoped invoice is absent', async () => {
    mocks.findInvoice.mockResolvedValue(null);

    await expect(caller('org-other').getInvoiceById({ id: 'invoice-1' })).resolves.toBeNull();
    expect(mocks.findInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'invoice-1', organizationId: 'org-other' } })
    );
    expect(mocks.findOrganization).not.toHaveBeenCalled();
  });

  it('returns the tenant identity when optional branding is not configured', async () => {
    mocks.findOrganization.mockResolvedValue({
      displayName: 'Northstar Studio',
      legalName: 'Northstar Studio Limited',
      brand: null,
    });

    await expect(caller().getInvoiceById({ id: 'invoice-1' })).resolves.toMatchObject({
      issuer: {
        displayName: 'Northstar Studio',
        legalName: 'Northstar Studio Limited',
        brand: null,
      },
    });
  });

  it('fails instead of substituting a platform identity when the tenant is missing', async () => {
    mocks.findOrganization.mockResolvedValue(null);

    await expect(caller().getInvoiceById({ id: 'invoice-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Workspace not found.',
    });
  });
});
