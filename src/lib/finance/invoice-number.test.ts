import { describe, expect, it, vi } from 'vitest';
import { allocateInvoiceNumber } from './invoice-number';

describe('allocateInvoiceNumber', () => {
  it('formats the value returned by the atomic sequence upsert', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ nextNumber: 12 }]);

    await expect(
      allocateInvoiceNumber({ $queryRaw: queryRaw }, 'org_one', 2027)
    ).resolves.toBe('INV-2027-012');

    expect(queryRaw).toHaveBeenCalledOnce();
    const query = queryRaw.mock.calls[0][0];
    expect(query.values).toEqual([
      'org_one',
      2027,
      'org_one',
      '^INV-2027-[0-9]+$',
      'org_one',
      '^INV-2027-[0-9]+$',
    ]);
    expect(query.strings.join('?')).toContain(
      'ON CONFLICT ("organizationId", "year") DO UPDATE'
    );
    expect(query.strings.join('?')).toContain('GREATEST(');
    expect(query.strings.join('?')).toContain('FROM "invoices"');
  });

  it('does not return a number when the database fails to reserve one', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await expect(allocateInvoiceNumber({ $queryRaw: queryRaw }, 'org_one', 2027)).rejects.toThrow(
      'Failed to allocate an invoice number.'
    );
  });
});
