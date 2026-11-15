import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FinancialStatements } from './financial-statements';
import { journalEvidenceCsv } from '@/lib/pharmacy/accounts/journal-evidence-export';

const entry = {
  id: 'internal-entry',
  sourceId: 'internal-source',
  sourceKind: 'PHARMACY_SALE_LINE',
  description: 'Sale line internal-source',
  occurredAt: new Date('2026-11-03T21:15:00Z'),
  currency: 'PKR',
  reversesEntryId: null,
  actorId: 'internal-user',
  userName: 'Saad',
  billNumber: 42,
  lines: [
    { id: 'debit', accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: 12345, lotId: null },
    { id: 'credit', accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: 12345, lotId: null },
  ],
};

async function renderJournal(change: Record<string, unknown> = {}) {
  const journalEntry = { ...entry, ...change };
  const html = renderToStaticMarkup(
    await FinancialStatements({
      branchId: 'branch',
      from: '2026-11-03',
      to: '2026-11-05',
      caller: {
        financialStatements: async () => ({
          accounts: [],
          cashflow: [],
          profitAndLoss: [],
          page: 1,
          journalCount: 1,
          freshness: { retrievedAt: entry.occurredAt },
          definition: 'Posted journal',
          journal: [journalEntry],
        }),
      } as never,
    })
  );
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('accounting journal presentation', () => {
  it.each([
    ['PHARMACY_SALE_LINE', 'Sale'],
    ['PHARMACY_TENDER', 'Payment received'],
    ['PHARMACY_REFUND', 'Refund'],
    ['PHARMACY_UNIDENTIFIED_RETURN_HOLD', 'Return on hold'],
    ['PHARMACY_SALE_RETURN_LINE', 'Sale return'],
  ])('shows local time, bill, money and user for %s', async (sourceKind, label) => {
    const container = await renderJournal({ sourceKind });
    const summary = container.querySelector('summary')!;
    expect(summary.textContent).toContain('2026-11-04 02:15 PKT');
    expect(summary.textContent).toContain(label);
    expect(summary.textContent).toContain('Bill 42');
    expect(summary.textContent).toContain('User: Saad');
    expect(summary.textContent).toContain('Debits PKR 123.45');
    expect(summary.textContent).toContain('Credits PKR 123.45');
    expect(summary.textContent).not.toContain('internal-');
    expect(summary.textContent).not.toContain(sourceKind);
    expect(summary.textContent).not.toContain('T21:15');
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(container.textContent).toContain('internal-entry');
    expect(container.textContent).toContain('internal-source');
    expect(container.textContent).toContain(sourceKind);
    expect(container.textContent).toContain('Sales clearing · Debit');
    expect(container.querySelector('a')?.href).toContain('journal-evidence-export');
  });

  it('keeps missing historical context explicit and identifies reversals', async () => {
    const container = await renderJournal({
      billNumber: null,
      userName: null,
      reversesEntryId: 'original',
    });
    const summary = container.querySelector('summary')!;
    expect(summary.textContent).toContain('Bill unavailable');
    expect(summary.textContent).toContain('User: Unavailable');
    expect(summary.textContent).toContain('reversal');
    expect(summary.textContent).not.toContain('internal-user');
  });

  it.each([
    ['PHARMACY_TENDER', 'Pharmacy tender cmvzinternaltender', 'Payment received · Cash'],
    ['PHARMACY_REFUND', 'Refund of tender cmvzinternaltender', 'Refund · Cash'],
  ])(
    'names the tender of %s entries, not its internal ID',
    async (sourceKind, description, label) => {
      const container = await renderJournal({ sourceKind, description, tenderName: 'Cash' });
      expect(container.querySelector('summary')!.textContent).toContain(label);
      expect(container.textContent).not.toContain('cmvz');
    }
  );

  it('retains raw audit fields and exact amounts in the evidence export', () => {
    const csv = journalEvidenceCsv({
      from: entry.occurredAt,
      to: new Date('2026-11-05T00:00:00Z'),
      page: 1,
      journalCount: 1,
      journal: [
        {
          ...entry,
          lines: entry.lines.map((line) => ({ ...line, amountMinor: String(line.amountMinor) })),
        },
      ],
    });
    for (const value of [
      'internal-entry',
      'internal-source',
      'PHARMACY_SALE_LINE',
      '2026-11-03T21:15:00.000Z',
      '12345',
      'SALES_REVENUE',
    ]) {
      expect(csv).toContain(`"${value}"`);
    }
  });
});
