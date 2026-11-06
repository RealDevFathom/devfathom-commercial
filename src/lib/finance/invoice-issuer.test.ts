import { describe, expect, it, vi } from 'vitest';
import { readInvoiceIssuer, toInvoiceIssuer } from './invoice-issuer';

const row = {
  legalName: 'Northwind Agency LLC',
  displayName: 'Northwind',
  invoiceAddress: '42 Market Street\nSeattle, WA 98101',
  invoiceTaxId: 'US-12-3456789',
};

describe('readInvoiceIssuer', () => {
  it('reads the seller identity of the workspace it is given, by explicit id', async () => {
    const findUnique = vi.fn().mockResolvedValue(row);

    await expect(
      readInvoiceIssuer({ organization: { findUnique } }, 'org_northwind')
    ).resolves.toEqual({
      name: 'Northwind Agency LLC',
      address: '42 Market Street\nSeattle, WA 98101',
      taxId: 'US-12-3456789',
    });
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'org_northwind' },
      select: { legalName: true, displayName: true, invoiceAddress: true, invoiceTaxId: true },
    });
  });

  it('returns null when the workspace row is not visible', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);

    await expect(readInvoiceIssuer({ organization: { findUnique } }, 'org_other')).resolves.toBe(
      null
    );
  });
});

describe('toInvoiceIssuer', () => {
  it.each([
    [null, null],
    ['', null],
    ['   \n ', null],
  ])('drops a blank optional address and tax ID (%j)', (blank, expected) => {
    expect(toInvoiceIssuer({ ...row, invoiceAddress: blank, invoiceTaxId: blank })).toEqual({
      name: 'Northwind Agency LLC',
      address: expected,
      taxId: expected,
    });
  });

  it('trims the stored values but keeps the address line breaks', () => {
    expect(
      toInvoiceIssuer({
        ...row,
        legalName: '  Northwind Agency LLC ',
        invoiceAddress: '\n42 Market Street\nSeattle  \n',
        invoiceTaxId: ' US-12-3456789 ',
      })
    ).toEqual({
      name: 'Northwind Agency LLC',
      address: '42 Market Street\nSeattle',
      taxId: 'US-12-3456789',
    });
  });

  it('falls back to the display name when the legal name is blank', () => {
    expect(toInvoiceIssuer({ ...row, legalName: ' ' })?.name).toBe('Northwind');
  });

  it('has no issuer when the workspace has no name at all', () => {
    expect(toInvoiceIssuer({ ...row, legalName: '', displayName: '' })).toBeNull();
  });
});
