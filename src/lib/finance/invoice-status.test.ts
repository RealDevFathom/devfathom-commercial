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

  it.each(['SENT', 'OVERDUE', 'PAID'] as const)(
    'allows PAID from %s only for callers that settle the ledger',
    (prior) => {
      expect(invoiceStatusTransitionError(prior, 'PAID', { recordsPayment: true })).toBeNull();
    }
  );

  it.each(['DRAFT', 'CANCELLED'] as const)(
    'rejects settlement of an unissued %s invoice',
    (prior) => {
      expect(invoiceStatusTransitionError(prior, 'PAID', { recordsPayment: true })).toBe(
        `Cannot change an invoice from ${prior} to PAID.`
      );
    }
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

  it.each(['OVERDUE', 'CANCELLED', 'DRAFT'] as const)(
    'clears sentAt when SENT becomes %s',
    (next) => {
      expect(invoiceStatusUpdate('SENT', next, new Date(0))).toEqual({
        status: next,
        sentAt: null,
        ...(next === 'DRAFT' ? { paidAt: null } : {}),
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
