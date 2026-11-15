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
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
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
      organizationId: 'org-1',
      invoiceNumber: 'INV-2026-1',
      total: 100,
      payments: [{ amount: 40 }],
    });
  });

  it("returns the issuing workspace's legal name, display name and branding", async () => {
    mocks.organizationFindUnique.mockResolvedValue({
      legalName: 'Northwind Studio LLC',
      displayName: 'Northwind Studio',
      brand: { logoUrl: 'https://cdn.example.com/logo.png', supportEmail: 'billing@example.com' },
    });

    const invoice = await caller().getInvoiceById({ id: 'invoice-1' });

    expect(mocks.organizationFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-1' } })
    );
    expect(invoice?.issuer).toEqual({
      legalName: 'Northwind Studio LLC',
      displayName: 'Northwind Studio',
      logoUrl: 'https://cdn.example.com/logo.png',
      supportEmail: 'billing@example.com',
    });
    expect(invoice?.amountPaid).toBe(40);
    expect(invoice?.balance).toBe(60);
  });

  it('falls back to no logo or contact when the workspace has no brand row', async () => {
    mocks.organizationFindUnique.mockResolvedValue({
      legalName: 'Harbor Labs Ltd',
      displayName: 'Harbor Labs',
      brand: null,
    });

    const invoice = await caller().getInvoiceById({ id: 'invoice-1' });

    expect(invoice?.issuer).toEqual({
      legalName: 'Harbor Labs Ltd',
      displayName: 'Harbor Labs',
      logoUrl: null,
      supportEmail: null,
    });
  });

  it('does not look up an issuer for a missing invoice', async () => {
    mocks.invoiceFindUnique.mockResolvedValue(null);

    await expect(caller().getInvoiceById({ id: 'missing' })).resolves.toBeNull();
    expect(mocks.organizationFindUnique).not.toHaveBeenCalled();
  });
});
