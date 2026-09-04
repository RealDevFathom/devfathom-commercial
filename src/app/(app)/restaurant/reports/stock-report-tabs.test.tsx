import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StockReportTabs } from './stock-report-tabs';

describe('StockReportTabs', () => {
  it('exposes labelled keyboard tabs and switches report panels', () => {
    render(
      <StockReportTabs
        wastage={<p>Wastage report content</p>}
        movements={<p>Movement report content</p>}
      />
    );

    expect(screen.getByRole('tablist', { name: 'Stock reports' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Wastage' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Stock movement' }));
    expect(screen.getByRole('tab', { name: 'Stock movement' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByText('Movement report content')).toBeVisible();
  });
});
