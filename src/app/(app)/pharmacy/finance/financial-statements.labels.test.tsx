import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FinancialStatements } from './financial-statements';

const refund = {
  id: 'entry_1',
  sourceId: 'refund_1',
  sourceKind: 'PHARMACY_REFUND',
  description: 'Refund of tender cmvz1abcdefghijklmnopqrst',
  occurredAt: new Date('2026-11-03T21:15:00Z'),
  currency: 'PKR',
  reversesEntryId: null,
  actorId: 'user_1',
  userName: 'Saad',
  billNumber: 42,
  lines: [
    { id: 'cash', accountCode: 'CASH', side: 'CREDIT', amountMinor: 500, lotId: null },
    { id: 'stock', accountCode: 'INVENTORY', side: 'DEBIT', amountMinor: 500, lotId: 'lot_1' },
  ],
};

async function render(journalLabels?: unknown) {
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
          freshness: { retrievedAt: refund.occurredAt },
          definition: 'Posted journal',
          journal: [refund],
          journalLabels,
        }),
      } as never,
    })
  );
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('journal payment method and lot names', () => {
  it('titles a refund by how it was paid and names the lot instead of its id', async () => {
    const container = await render({
      paymentMethods: { entry_1: 'Cash' },
      lots: { lot_1: 'Panadol · batch B12' },
    });
    expect(container.querySelector('summary')!.textContent).toContain('Refund · Cash');
    const lines = container.querySelector('details ul')!.textContent;
    expect(lines).toContain('Panadol · batch B12');
    expect(lines).not.toContain('lot_1');
  });

  it('keeps the plain source label and lot reference when no names were resolved', async () => {
    const container = await render({ paymentMethods: {}, lots: {} });
    const summary = container.querySelector('summary')!.textContent;
    expect(summary).toContain('Refund · Bill 42');
    expect(summary).not.toContain('Refund · Cash');
    expect(container.querySelector('details ul')!.textContent).toContain('lot lot_1');
  });
});
