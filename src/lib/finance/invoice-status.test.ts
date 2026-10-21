import { describe, expect, it } from 'vitest';

import {
  canTransitionInvoiceStatus,
  getInvoiceStatusTransitions,
  INVOICE_STATUSES,
} from './invoice-status';

describe('invoice status transitions', () => {
  it.each([
    ['DRAFT', ['SENT', 'CANCELLED']],
    ['SENT', ['PAID', 'OVERDUE', 'CANCELLED', 'DRAFT']],
    ['OVERDUE', ['PAID', 'CANCELLED', 'SENT']],
    ['PAID', ['CANCELLED']],
    ['CANCELLED', ['DRAFT']],
  ] as const)('returns the server-approved destinations from %s', (status, expected) => {
    expect(getInvoiceStatusTransitions(status)).toEqual(expected);
  });

  it.each([
    ['DRAFT', 'PAID'],
    ['DRAFT', 'OVERDUE'],
    ['PAID', 'DRAFT'],
    ['CANCELLED', 'PAID'],
  ] as const)('rejects %s to %s', (from, to) => {
    expect(canTransitionInvoiceStatus(from, to)).toBe(false);
  });

  it.each(INVOICE_STATUSES)('does not expose a no-op transition from %s', (status) => {
    expect(canTransitionInvoiceStatus(status, status)).toBe(false);
  });
});
