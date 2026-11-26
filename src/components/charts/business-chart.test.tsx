import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BusinessChart } from './business-chart';
it('gives keyboard users the same selectable zero and unknown chart values', () => {
  const select = vi.fn();
  render(
    <BusinessChart
      title="Daily sales"
      points={[
        { label: 'Monday', value: 0 },
        { label: 'Tuesday', value: null },
      ]}
      empty="No sales"
      format={String}
      onSelect={select}
    />
  );
  fireEvent.click(screen.getByText('Chart values and details'));
  fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
  expect(select).toHaveBeenCalledWith({ label: 'Monday', value: 0 });
  expect(screen.getByText('Unavailable')).toBeVisible();
});
