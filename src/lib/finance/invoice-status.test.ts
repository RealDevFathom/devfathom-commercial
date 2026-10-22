import { describe, expect, it } from 'vitest';

import {
  canTransitionInvoiceStatus,
  getInvoiceStatusTransitions,
  invoiceStatusTransitionError,
  invoiceStatusUpdate,
  INVOICE_STATUS_TRANSITIONS,
  INVOICE_STATUSES,
  PAID_STATUS_ERROR,
  type InvoiceStatus,
} from './invoice-status';

describe('invoice status contract shared by REST, tRPC, AI, and UI', () => {
  it.each([
    ['DRAFT', ['SENT', 'CANCELLED']],
    ['SENT', ['OVERDUE', 'CANCELLED', 'DRAFT']],
    ['OVERDUE', ['CANCELLED', 'SENT']],
    ['PAID', ['CANCELLED']],
    ['CANCELLED', ['DRAFT']],
  ] as const)('returns the server-approved destinations from %s', (status, expected) => {
    expect(getInvoiceStatusTransitions(status)).toEqual(expected);
  });

  it.each<InvoiceStatus>(INVOICE_STATUSES)('rejects direct PAID from %s', (prior) => {
    expect(invoiceStatusTransitionError(prior, 'PAID')).toBe(PAID_STATUS_ERROR);
    expect(canTransitionInvoiceStatus(prior, 'PAID')).toBe(false);
  });

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
    expect(canTransitionInvoiceStatus(prior, next)).toBe(true);
  });

  it.each(INVOICE_STATUSES)('does not expose a no-op transition from %s', (status) => {
    expect(canTransitionInvoiceStatus(status, status)).toBe(false);
  });

  it('defines transitions for every status and never points outside the canonical enum', () => {
    expect(Object.keys(INVOICE_STATUS_TRANSITIONS).sort()).toEqual([...INVOICE_STATUSES].sort());
    for (const destinations of Object.values(INVOICE_STATUS_TRANSITIONS)) {
      expect(destinations.every((status) => INVOICE_STATUSES.includes(status))).toBe(true);
    }
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
