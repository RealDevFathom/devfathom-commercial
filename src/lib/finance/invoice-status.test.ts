import { describe, expect, it } from 'vitest';
import {
  allowedInvoiceStatuses,
  INVOICE_STATUS_VALUES,
  invoiceStatusTransitionError,
  invoiceStatusUpdate,
  PAID_STATUS_ERROR,
  type InvoiceStatusValue,
} from './invoice-status';

describe('invoice status contract shared by REST, tRPC, and AI', () => {
  it('keeps every picker choice aligned with the transition validator', () => {
    for (const prior of INVOICE_STATUS_VALUES) {
      const allowed = allowedInvoiceStatuses(prior);

      for (const next of INVOICE_STATUS_VALUES) {
        expect(allowed.includes(next)).toBe(invoiceStatusTransitionError(prior, next) === null);
      }
    }
  });

  it.each([
    ['DRAFT', ['DRAFT', 'SENT', 'CANCELLED']],
    ['SENT', ['DRAFT', 'SENT', 'OVERDUE', 'CANCELLED']],
    ['OVERDUE', ['SENT', 'OVERDUE', 'CANCELLED']],
    ['PAID', ['CANCELLED']],
    ['CANCELLED', ['DRAFT', 'CANCELLED']],
  ] as const)('only offers API-supported transitions from %s', (prior, expected) => {
    expect(allowedInvoiceStatuses(prior)).toEqual(expected);
  });

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
    const updatedInvoice = { ...storedInvoice, ...update };

    expect(update).toEqual({ status: next });
    expect(update).not.toHaveProperty('sentAt');
    expect(updatedInvoice).toEqual({ status: next, sentAt });
    expect(updatedInvoice.sentAt).toBe(sentAt);
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

  it.each(['DRAFT', 'OVERDUE'] as const)('stamps SENT when %s is sent', (prior) => {
    const at = new Date('2026-10-21T00:00:00Z');
    expect(invoiceStatusUpdate(prior, 'SENT', at)).toEqual({ status: 'SENT', sentAt: at });
  });

  it('clears paidAt but preserves sentAt whenever PAID is exited', () => {
    const at = new Date('2026-10-21T00:00:00Z');
    const sentAt = new Date('2026-10-20T00:00:00Z');
    const storedInvoice = { status: 'PAID' as const, sentAt, paidAt: at };
    const update = invoiceStatusUpdate('PAID', 'CANCELLED', at);

    expect(update).toEqual({
      status: 'CANCELLED',
      paidAt: null,
    });
    expect({ ...storedInvoice, ...update }).toEqual({
      status: 'CANCELLED',
      sentAt,
      paidAt: null,
    });
  });
});
