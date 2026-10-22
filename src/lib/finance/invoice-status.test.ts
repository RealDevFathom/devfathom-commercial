import { describe, expect, it } from 'vitest';

import { invoiceStatusUpdate } from './invoice-status';

const NOW = new Date('2026-10-23T12:00:00.000Z');

describe('invoiceStatusUpdate', () => {
  it('stamps an invoice when it is sent', () => {
    expect(invoiceStatusUpdate('DRAFT', 'SENT', NOW)).toEqual({ status: 'SENT', sentAt: NOW });
  });

  it('stamps an invoice when it is paid', () => {
    expect(invoiceStatusUpdate('SENT', 'PAID', NOW)).toEqual({ status: 'PAID', paidAt: NOW });
  });

  it.each(['OVERDUE', 'CANCELLED'] as const)(
    'retains sentAt when a sent invoice becomes %s',
    (status) => {
      expect(invoiceStatusUpdate('SENT', status, NOW)).toEqual({ status });
    }
  );

  it('clears sentAt and paidAt only when an invoice returns to draft', () => {
    expect(invoiceStatusUpdate('SENT', 'DRAFT', NOW)).toEqual({
      status: 'DRAFT',
      sentAt: null,
      paidAt: null,
    });
  });

  it('clears paidAt when a paid invoice is cancelled without erasing sentAt', () => {
    expect(invoiceStatusUpdate('PAID', 'CANCELLED', NOW)).toEqual({
      status: 'CANCELLED',
      paidAt: null,
    });
  });
});
