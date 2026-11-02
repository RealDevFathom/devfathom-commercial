/**
 * #458 / DEV-243: the invoice print/PDF view (also where the emailed invoice
 * link lands) prints the authenticated agency as the seller. getInvoiceById
 * reads the invoice and the issuer under the same workspace id, so neither the
 * URL nor another tenant's row can decide whose identity is printed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  invoiceFindUnique: vi.fn(),
  invoiceUpdate: vi.fn(),
  organizationFindUnique: vi.fn(),
  invoiceIssued: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/email', () => ({
  appUrl: () => 'https://hub.example.test',
  sendEmail: mocks.sendEmail,
  templates: { invoiceIssued: mocks.invoiceIssued },
}));
vi.mock('../audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { financeRouter } from './finance';

function caller(organizationId = 'agency-1') {
  return financeRouter.createCaller({
    db: {
      invoice: { findUnique: mocks.invoiceFindUnique, update: mocks.invoiceUpdate },
      organization: { findUnique: mocks.organizationFindUnique },
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

const agency = {
  legalName: 'Northwind Agency LLC',
  displayName: 'Northwind',
  invoiceAddress: '42 Market Street\nSeattle, WA 98101',
  invoiceTaxId: 'US-12-3456789',
};

describe('finance.getInvoiceById seller identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoiceFindUnique.mockResolvedValue({ id: 'invoice-1', total: 110, payments: [] });
    mocks.organizationFindUnique.mockResolvedValue(agency);
  });

  it('reads the invoice and the issuer under the authenticated workspace', async () => {
    const result = await caller().getInvoiceById({ id: 'invoice-1' });

    expect(mocks.invoiceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'invoice-1', organizationId: 'agency-1' } })
    );
    expect(mocks.organizationFindUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'agency-1' },
      select: { legalName: true, displayName: true, invoiceAddress: true, invoiceTaxId: true },
    });
    expect(result?.issuer).toEqual({
      name: 'Northwind Agency LLC',
      address: '42 Market Street\nSeattle, WA 98101',
      taxId: 'US-12-3456789',
    });
    expect(JSON.stringify(result)).not.toMatch(/DevFathom|hub\.devfathom\.com/);
  });

  it('degrades to the legal name alone when the optional details are empty', async () => {
    mocks.organizationFindUnique.mockResolvedValue({
      ...agency,
      invoiceAddress: null,
      invoiceTaxId: '  ',
    });

    const result = await caller().getInvoiceById({ id: 'invoice-1' });

    expect(result?.issuer).toEqual({ name: 'Northwind Agency LLC', address: null, taxId: null });
  });

  it('returns nothing for an invoice outside the workspace', async () => {
    mocks.invoiceFindUnique.mockResolvedValue(null);

    await expect(caller('agency-2').getInvoiceById({ id: 'invoice-1' })).resolves.toBeNull();
    expect(mocks.invoiceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'invoice-1', organizationId: 'agency-2' } })
    );
    expect(mocks.organizationFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'agency-2' } })
    );
  });
});

describe('finance.sendInvoiceEmail link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoiceFindUnique.mockResolvedValue({
      id: 'invoice-1',
      invoiceNumber: 'INV-2026-001',
      clientId: 'client-1',
      status: 'SENT',
      total: 110,
      currency: 'USD',
      dueDate: new Date('2026-11-30T00:00:00.000Z'),
      client: { name: 'Example Client', contacts: [{ name: 'Ada', email: 'ada@example.test' }] },
    });
    mocks.invoiceIssued.mockReturnValue({ subject: 's', html: 'h', text: 't' });
    mocks.sendEmail.mockResolvedValue(undefined);
  });

  it('links to the workspace print view by invoice id only', async () => {
    await caller().sendInvoiceEmail({ id: 'invoice-1' });

    expect(mocks.invoiceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'invoice-1', organizationId: 'agency-1' } })
    );
    expect(mocks.invoiceIssued).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://hub.example.test/finance/invoices/invoice-1/print' })
    );
  });
});
