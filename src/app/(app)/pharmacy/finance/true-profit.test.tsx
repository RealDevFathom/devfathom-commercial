import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrueProfitSection } from './ledger-reports';

const branch = { id: 'branch_1', name: 'Main' };

function report(by: 'item' | 'category' | 'hour' | 'staff', rows: unknown[]) {
  return {
    scope: { organizationId: 'org_1', branchId: 'branch_1' },
    timezone: 'UTC' as const,
    moneyUnit: 'integer_minor' as const,
    currency: 'PKR',
    currencyStatus: 'not_recorded_by_ledger_reader' as const,
    definition: 'Posted revenue less discounts less landed COGS.',
    source: 'finance_journal_lines' as const,
    coverage: {
      basis: 'posted_entries_only' as const,
      completeness: 'unknown' as const,
      costCoverage: 'unknown' as const,
      refunds: 'included_only_when_posted_as_reversals' as const,
      emptyRows: 'no_matching_postings_not_proof_of_zero_activity' as const,
    },
    freshness: { retrievedAt: new Date('2026-11-15T00:00:00Z'), latestPostingAt: null },
    period: {
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-08T00:00:00Z'),
      bounds: '[from,to)' as const,
    },
    hourTimezone: 'Asia/Karachi' as const,
    by,
    rows,
  };
}

function render(markup: string) {
  const container = document.createElement('div');
  container.innerHTML = markup;
  return container;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('DEV-77 true profit section', () => {
  it('reads true profit by item for the ledger period and shows named rows', async () => {
    const trueProfit = vi.fn().mockResolvedValue(
      report('item', [
        {
          key: 'med_a',
          label: 'Example tablets',
          revenueMinor: 60_000,
          discountMinor: 1_000,
          cogsMinor: 40_000,
          grossMarginMinor: 19_000,
        },
      ])
    );
    const view = render(
      renderToStaticMarkup(
        await TrueProfitSection({
          caller: { trueProfit } as never,
          branch,
          from: '2026-11-01',
          to: '2026-11-08',
        })
      )
    );
    expect(trueProfit).toHaveBeenCalledWith({
      branchId: 'branch_1',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-08T00:00:00.000Z',
      by: 'item',
    });
    expect(view.textContent).toContain('Example tablets (med_a)');
    expect(view.textContent).toContain('True profit');
    expect(view.textContent).toContain('190.00');
    expect(view.textContent).toContain('Landed COGS');
  });

  it('labels sale hours with the reporting clock', async () => {
    const trueProfit = vi.fn().mockResolvedValue(
      report('hour', [
        {
          key: '09:00',
          label: null,
          revenueMinor: 100,
          discountMinor: 0,
          cogsMinor: 40,
          grossMarginMinor: 60,
        },
      ])
    );
    const view = render(
      renderToStaticMarkup(
        await TrueProfitSection({ caller: { trueProfit } as never, branch, by: 'hour' })
      )
    );
    expect(trueProfit).toHaveBeenCalledWith(expect.objectContaining({ by: 'hour' }));
    expect(view.textContent).toContain('Asia/Karachi');
    expect(view.textContent).toContain('09:00');
  });

  it('runs no query for an unlisted grouping and says why', async () => {
    const trueProfit = vi.fn();
    const view = render(
      renderToStaticMarkup(
        await TrueProfitSection({ caller: { trueProfit } as never, branch, by: 'lot' })
      )
    );
    expect(trueProfit).not.toHaveBeenCalled();
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('listed profit grouping');
  });

  it('keeps the other report filters when the grouping changes', async () => {
    const trueProfit = vi.fn().mockResolvedValue(report('staff', []));
    const view = render(
      renderToStaticMarkup(
        await TrueProfitSection({
          caller: { trueProfit } as never,
          branch,
          by: 'staff',
          preserved: { ledgerBy: 'batch', marginFrom: undefined },
        })
      )
    );
    const form = view.querySelector('form')!;
    expect(form.getAttribute('method')).toBe('get');
    expect(form.querySelector('input[name="ledgerBy"]')?.getAttribute('value')).toBe('batch');
    expect(form.querySelector('input[name="marginFrom"]')).toBeNull();
    expect(form.querySelector('select[name="profitBy"]')).not.toBeNull();
  });

  it('shows a permission message instead of totals when access is denied', async () => {
    const trueProfit = vi.fn().mockRejectedValue({ code: 'FORBIDDEN' });
    const view = render(
      renderToStaticMarkup(await TrueProfitSection({ caller: { trueProfit } as never, branch }))
    );
    expect(view.textContent).toContain('Permission required');
    expect(view.textContent).not.toContain('Landed COGS');
  });
});
