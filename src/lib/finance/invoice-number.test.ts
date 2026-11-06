import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { reserveInvoiceNumber } from './invoice-number';

describe('reserveInvoiceNumber', () => {
  it('uses an atomic tenant/year upsert and formats its returned value', async () => {
    const upsert = vi.fn().mockResolvedValue({ lastNumber: 12 });
    const tx = { invoiceNumberSequence: { upsert } } as unknown as Prisma.TransactionClient;

    await expect(reserveInvoiceNumber(tx, 'org-a', 2026)).resolves.toBe('INV-2026-012');
    expect(upsert).toHaveBeenCalledWith({
      where: { organizationId_year: { organizationId: 'org-a', year: 2026 } },
      create: { organizationId: 'org-a', year: 2026, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    });
  });

  it('allows different tenants to reserve their own first number', async () => {
    const upsert = vi.fn().mockResolvedValue({ lastNumber: 1 });
    const tx = { invoiceNumberSequence: { upsert } } as unknown as Prisma.TransactionClient;

    expect(await reserveInvoiceNumber(tx, 'org-a', 2027)).toBe('INV-2027-001');
    expect(await reserveInvoiceNumber(tx, 'org-b', 2027)).toBe('INV-2027-001');
    expect(upsert.mock.calls.map(([arg]) => arg.where.organizationId_year.organizationId)).toEqual([
      'org-a',
      'org-b',
    ]);
  });
});
