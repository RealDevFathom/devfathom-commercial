import { describe, expect, it } from 'vitest';
import type { ApAgingRow, ApAgingView } from './ap-aging';
import { buildPaymentDraft, buildSetOffDraft, computeDueBillReminders } from './ap-payables-drafts';

const row = (
  id: string,
  payee: string,
  dueDate: string,
  out: number,
  days: number
): ApAgingRow => ({
  invoiceId: id,
  reference: `R-${id}`,
  payeeName: payee,
  supplierInvoiceRef: id,
  invoiceDate: '2026-01-01',
  dueDate,
  currency: 'PKR',
  amountMinor: out,
  paidMinor: 0,
  setOffMinor: 0,
  outstandingMinor: out,
  daysPastDue: days,
  bucket: 'CURRENT',
});
const view = (rows: ApAgingRow[]): ApAgingView => ({
  asOf: '2026-11-17',
  complete: true,
  scannedInvoices: rows.length,
  rows,
  totals: [],
});

const rows = [
  row('a', 'Alpha Distributors', '2026-10-01', 1000, 47),
  row('b', 'alpha  distributors', '2026-11-20', 500, -3),
  row('c', 'Alpha Distributors', '2026-12-30', 900, -43),
  row('d', 'Beta Pharma', '2026-11-10', 300, 7),
];

describe('computeDueBillReminders', () => {
  it('groups per distributor into overdue and due-soon, ignoring far-future bills', () => {
    const out = computeDueBillReminders(view(rows));
    expect(out.map((r) => r.payeeName)).toEqual(['Alpha Distributors', 'Beta Pharma']);
    expect(out[0]).toMatchObject({
      overdueMinor: 1000,
      overdueCount: 1,
      dueSoonMinor: 500,
      dueSoonCount: 1,
      oldestDueDate: '2026-10-01',
      maxDaysPastDue: 47,
    });
  });
});

describe('buildPaymentDraft', () => {
  it('pays oldest due first and part-pays the last funded bill', () => {
    const d = buildPaymentDraft(view(rows), {
      payeeName: 'Alpha Distributors',
      currency: 'PKR',
      budgetMinor: 1200,
    });
    expect(d.lines.map((l) => [l.invoiceId, l.payMinor])).toEqual([
      ['a', 1000],
      ['b', 200],
    ]);
    expect(d.allocatedMinor).toBe(1200);
    expect(d.remainingBudgetMinor).toBe(0);
  });
  it('never exceeds outstanding and reports leftover budget', () => {
    const d = buildPaymentDraft(view(rows), {
      payeeName: 'Beta Pharma',
      currency: 'PKR',
      budgetMinor: 9999,
    });
    expect(d.allocatedMinor).toBe(300);
    expect(d.remainingBudgetMinor).toBe(9699);
  });
});

describe('buildSetOffDraft', () => {
  it('sets credits off oldest-first against the matching distributor only', () => {
    const d = buildSetOffDraft(
      view(rows),
      [
        {
          creditId: 'c1',
          reference: 'CN1',
          supplierName: 'Alpha Distributors',
          receivedAt: new Date('2026-09-01'),
          amountMinor: 1200,
          allocatedMinor: 100,
        },
        {
          creditId: 'c2',
          reference: 'CN2',
          supplierName: 'Gamma',
          receivedAt: new Date('2026-09-02'),
          amountMinor: 50,
          allocatedMinor: 0,
        },
      ],
      'PKR'
    );
    expect(d.lines.map((l) => [l.invoiceId, l.setOffMinor])).toEqual([
      ['a', 1000],
      ['b', 100],
    ]);
    expect(d.totalSetOffMinor).toBe(1100);
    expect(d.unmatchedCreditMinor).toBe(50);
  });
});
