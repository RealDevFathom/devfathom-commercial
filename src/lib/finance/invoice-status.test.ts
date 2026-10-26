import { describe, expect, it } from 'vitest';
import {
  invoiceStatusTransitionError,
  invoiceStatusUpdate,
  PAID_STATUS_ERROR,
  type InvoiceStatusValue,
} from './invoice-status';

describe('invoice status contract shared by REST, tRPC, and AI', () => {
  it.each<InvoiceStatusValue>(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'])(
    'rejects direct PAID from %s',
    (prior) => expect(invoiceStatusTransitionError(prior, 'PAID')).toBe(PAID_STATUS_ERROR)
  );

  it.each([
    ['DRAFT', 'SENT'],
    ['DRAFT', 'CANCELLED'],
    ['SENT', 'OVERDUE'],
    ['SENT', 'CANCELLED'],
    ['SENT', 'DRAFT'],
    ['OVERDUE', 'CANCELLED'],
    ['OVERDUE', 'SENT'],
    ['PAID', 'CANCELLED'],
    ['CANCELLED', 'DRAFT'],
  ] as const)('allows %s to %s', (prior, next) => {
    expect(invoiceStatusTransitionError(prior, next)).toBeNull();
  });

  it.each(['OVERDUE', 'CANCELLED'] as const)('preserves sentAt when SENT becomes %s', (next) => {
    const sentAt = new Date('2026-10-20T00:00:00Z');
    const storedInvoice = { status: 'SENT' as const, sentAt };
    const update = invoiceStatusUpdate('SENT', next, new Date('2026-10-21T00:00:00Z'));

    expect(update).toEqual({ status: next });
    expect({ ...storedInvoice, ...update }).toEqual({ status: next, sentAt });
  });

  it.each(['SENT', 'CANCELLED'] as const)(
    'clears issue and payment timestamps when %s returns to DRAFT',
    (prior) => {
      expect(invoiceStatusUpdate(prior, 'DRAFT', new Date(0))).toEqual({
        status: 'DRAFT',
        sentAt: null,
        paidAt: null,
      });
    }
  );

  it('stamps SENT and clears paidAt whenever PAID is exited', () => {
    const at = new Date('2026-10-21T00:00:00Z');
    expect(invoiceStatusUpdate('DRAFT', 'SENT', at)).toEqual({ status: 'SENT', sentAt: at });
    expect(invoiceStatusUpdate('PAID', 'CANCELLED', at)).toEqual({
      status: 'CANCELLED',
      paidAt: null,
    });
  });
});
