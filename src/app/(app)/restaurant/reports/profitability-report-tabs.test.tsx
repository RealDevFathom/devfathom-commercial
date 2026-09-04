import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProfitabilityReportTabs } from './profitability-report-tabs';

describe('ProfitabilityReportTabs', () => {
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
