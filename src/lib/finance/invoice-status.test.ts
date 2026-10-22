import { describe, expect, it } from 'vitest';
import {
  INVOICE_STATUS_VALUES,
  invoiceStatusTargets,
  invoiceStatusTransitionError,
  invoiceStatusUpdate,
  PAID_STATUS_ERROR,
  reopenedInvoiceStatus,
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

  // #398: DRAFT and CANCELLED invoices are not owed, so they cannot keep payments.
  it.each([
    ['SENT', 'CANCELLED', 'Delete them before cancelling it.'],
    ['OVERDUE', 'CANCELLED', 'Delete them before cancelling it.'],
    ['PAID', 'CANCELLED', 'Delete them before cancelling it.'],
    ['SENT', 'DRAFT', 'Delete them before moving it back to draft.'],
  ] as const)('refuses %s to %s while payments are recorded', (prior, next, advice) => {
    expect(invoiceStatusTransitionError(prior, next, { amountPaid: 0.01 })).toBe(
      `This invoice has recorded payments. ${advice}`
    );
    // Below the half-cent tolerance there is nothing to strand.
    expect(invoiceStatusTransitionError(prior, next, { amountPaid: 0.004 })).toBeNull();
    expect(invoiceStatusTransitionError(prior, next)).toBeNull();
  });

  it('keeps payments compatible with moves between issued states', () => {
    expect(invoiceStatusTransitionError('SENT', 'OVERDUE', { amountPaid: 50 })).toBeNull();
    expect(invoiceStatusTransitionError('OVERDUE', 'SENT', { amountPaid: 50 })).toBeNull();
  });

  it.each(INVOICE_STATUS_VALUES)('never offers PAID as a status-only target from %s', (prior) => {
    expect(invoiceStatusTargets(prior)).not.toContain('PAID');
    for (const next of invoiceStatusTargets(prior)) {
      expect(invoiceStatusTransitionError(prior, next)).toBeNull();
    }
  });

  it('reopens a past-due invoice as OVERDUE and any other as SENT', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    expect(reopenedInvoiceStatus(new Date('2026-10-21T00:00:00Z'), now)).toBe('OVERDUE');
    expect(reopenedInvoiceStatus(new Date('2026-10-23T00:00:00Z'), now)).toBe('SENT');
  });

  it('stamps SENT and clears paidAt whenever PAID is exited', () => {
    const at = new Date('2026-10-21T00:00:00Z');
    expect(invoiceStatusUpdate('DRAFT', 'SENT', at)).toEqual({ status: 'SENT', sentAt: at });
    expect(invoiceStatusUpdate('PAID', 'CANCELLED', at)).toEqual({
      status: 'CANCELLED',
      paidAt: null,
    });
  });
});
