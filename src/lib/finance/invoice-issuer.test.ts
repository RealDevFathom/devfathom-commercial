import { describe, expect, it, vi } from 'vitest';
import { readInvoiceIssuer } from './invoice-issuer';

describe('readInvoiceIssuer', () => {
  it('returns the tenant legal identity without platform branding', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      legalName: 'Northstar Agency LLC',
      invoiceAddress: '15 Market Street\nAustin, TX 78701',
      invoiceTaxId: 'US-TIN 12-3456789',
    });

    await expect(
      readInvoiceIssuer({ organization: { findUnique } }, 'org_northstar')
    ).resolves.toEqual({
      name: 'Northstar Agency LLC',
      address: '15 Market Street\nAustin, TX 78701',
      taxId: 'US-TIN 12-3456789',
    });
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'org_northstar' },
      select: { legalName: true, invoiceAddress: true, invoiceTaxId: true },
    });
  });
});
