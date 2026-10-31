import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { invoiceBalanceCovered, settleCoveredSentInvoice } from './invoice-settlement';

function db(paid: number | null, count = 1) {
  return {
    payment: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: paid } }) },
    invoice: { updateMany: vi.fn().mockResolvedValue({ count }) },
  };
}

const asTx = (value: ReturnType<typeof db>) => value as unknown as Prisma.TransactionClient;

describe('invoiceBalanceCovered', () => {
  it('treats an exact or half-cent-short payoff as covered', () => {
    expect(invoiceBalanceCovered(20, 20)).toBe(true);
    expect(invoiceBalanceCovered(0, 0)).toBe(true);
    expect(invoiceBalanceCovered(20, 19.99)).toBe(false);
  });
});

describe('settleCoveredSentInvoice', () => {
  it('flips a zero-total SENT invoice to PAID with a compare-and-set', async () => {
    const mock = db(null);

    await expect(settleCoveredSentInvoice(asTx(mock), { id: 'inv-1', total: 0 })).resolves.toBe(
      true
    );
    expect(mock.payment.aggregate).not.toHaveBeenCalled();
    expect(mock.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv-1', status: 'SENT' },
      data: { status: 'PAID', paidAt: expect.any(Date) },
    });
  });

  it('settles when collected payments already cover the total', async () => {
    const mock = db(20);

    await expect(settleCoveredSentInvoice(asTx(mock), { id: 'inv-1', total: 20 })).resolves.toBe(
      true
    );
  });

  it('leaves an invoice with an outstanding balance untouched', async () => {
    const mock = db(5);

    await expect(settleCoveredSentInvoice(asTx(mock), { id: 'inv-1', total: 20 })).resolves.toBe(
      false
    );
    expect(mock.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('reports no settlement when a concurrent change already moved the invoice', async () => {
    const mock = db(null, 0);

    await expect(settleCoveredSentInvoice(asTx(mock), { id: 'inv-1', total: 0 })).resolves.toBe(
      false
    );
  });
});
