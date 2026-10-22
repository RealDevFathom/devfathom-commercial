import { describe, expect, it } from 'vitest';

import {
  canTransitionInvoiceStatus,
  getInvoiceStatusTransitions,
  INVOICE_STATUS_TRANSITIONS,
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

  it('defines transitions for every status and never points outside the canonical enum', () => {
    expect(Object.keys(INVOICE_STATUS_TRANSITIONS).sort()).toEqual([...INVOICE_STATUSES].sort());
    for (const destinations of Object.values(INVOICE_STATUS_TRANSITIONS)) {
      expect(destinations.every((status) => INVOICE_STATUSES.includes(status))).toBe(true);
    }
  });
});
