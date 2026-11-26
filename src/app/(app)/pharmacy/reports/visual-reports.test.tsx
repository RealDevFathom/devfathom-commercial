import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('@/lib/trpc', () => ({ trpc: { pharmacyReports: { visualChart: { useQuery: read } } } }));
import { VisualReports } from './visual-reports';

it('compares recorded sales against an empty prior period and opens the selected previous day', () => {
  read.mockImplementation(({ previous, bucket, chart }) => ({
    data: {
      period: previous
        ? { from: '2026-11-23', to: '2026-11-23' }
        : { from: '2026-11-24', to: '2026-11-24' },
      rows:
        previous || bucket
          ? []
          : [
              {
                key: '2026-11-24',
                label: '2026-11-24',
                value: chart === 'salesPayment' ? 800 : 1000,
                amount: chart === 'salesPayment' ? 800 : 1000,
                base: 0,
                excluded: 0,
              },
            ],
    },
  }));
  render(
    <VisualReports
      initialPeriod={{ from: '2026-11-24', to: '2026-11-24' }}
      initialReport="Sales"
      branches={[{ id: 'main', name: 'Main' }]}
      currency="PKR"
      today="2026-11-24"
    />
  );
  expect(screen.getByText('Up PKR 10.00')).toBeVisible();
  expect(screen.getByText('Payments received')).toBeVisible();
  const figure = screen.getByRole('figure', { name: 'Sales by day' });
  fireEvent.click(within(figure).getByText('Chart values and details'));
  fireEvent.click(within(figure).getByRole('button', { name: 'Previous period, 2026-11-23' }));
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ previous: true, bucket: '2026-11-23' }),
    expect.anything()
  );
});
