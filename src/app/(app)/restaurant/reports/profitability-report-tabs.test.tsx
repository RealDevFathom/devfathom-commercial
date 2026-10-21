import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ProfitabilityReportTabs,
  type ProfitabilityDiagnostics,
} from './profitability-report-tabs';

const ready: Extract<ProfitabilityDiagnostics, { status: 'ready' }> = {
  status: 'ready',
  currency: null,
  scopeLabel: 'Selected branch',
  recipeCostFreshness: null,
  report: {
    range: { from: '2026-09-01', to: '2026-09-12', branchIds: ['branch'] },
    products: [],
    uncostedProducts: [],
    truncated: true,
  },
};
function show(diagnostics?: ProfitabilityDiagnostics) {
  return render(
    <ProfitabilityReportTabs
      foodCost={<p>Food</p>}
      dishProfitability={<p>Dish</p>}
      catering={<p>Catering</p>}
      diagnostics={diagnostics}
    />
  );
}

describe('ProfitabilityReportTabs', () => {
  it('preserves caller states when diagnostics are omitted or unavailable', () => {
    const view = show();
    expect(screen.queryByText('Recipe review priorities')).not.toBeInTheDocument();
    view.unmount();
    show({ status: 'unavailable', reason: 'Financial permission required.' });
    expect(screen.getByRole('status')).toHaveTextContent('Financial permission required.');
    expect(screen.queryByText(/Theoretical contribution =/)).not.toBeInTheDocument();
  });
  it('states scope, unknown metadata, sample limits and empty data honestly', () => {
    show(ready);
    expect(screen.getByText(/2026-09-01 to 2026-09-12/)).toHaveTextContent(
      'Selected branch · Currency unknown'
    );
    expect(screen.getByText(/Recipe-cost freshness unavailable/)).toBeVisible();
    expect(screen.getByText('Partial sample')).toBeVisible();
    expect(screen.getByText(/omitted sales may change priorities/)).toBeVisible();
    expect(screen.getByText(/No sales rows in this period/)).toBeVisible();
  });
  it('renders exact contribution and keyboard-reachable bounded tables in either relevant tab', () => {
    show({
      ...ready,
      currency: 'PKR',
      report: {
        ...ready.report,
        products: [
          {
            productId: 'dish',
            productName: 'Dish A',
            categoryId: null,
            categoryName: 'Food',
            quantity: '2',
            netSales: '1.01',
            theoreticalCost: '2.02',
            grossMargin: '-1.01',
            marginPerItem: '-0.51',
            foodCostPercent: '200',
          },
        ],
      },
    });
    expect(
      screen.getByRole('region', { name: 'Negative theoretical contributions' })
    ).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('cell', { name: 'PKR -1.01' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Dish profitability' }));
    expect(screen.getByRole('cell', { name: 'PKR -1.01' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Catering' }));
    expect(screen.queryByText('Recipe review priorities')).not.toBeInTheDocument();
  });
  it('shows an error instead of ranked amounts for invalid ranges', () => {
    show({
      ...ready,
      report: { ...ready.report, range: { ...ready.report.range, from: 'invalid' } },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Diagnostics unavailable');
    expect(screen.queryByText(/Theoretical contribution =/)).not.toBeInTheDocument();
  });
  it('exposes labelled keyboard tabs and switches report panels', () => {
    render(
      <ProfitabilityReportTabs
        catering={<p>Catering report content</p>}
        dishProfitability={<p>Dish profitability content</p>}
        foodCost={<p>Food cost report content</p>}
      />
    );

    expect(screen.getByRole('tablist', { name: 'Profitability reports' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Food cost' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Catering' }));
    expect(screen.getByRole('tab', { name: 'Catering' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Catering report content')).toBeVisible();
  });
});
