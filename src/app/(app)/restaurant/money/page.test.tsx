import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/restaurant/money/money-console', () => ({
  MoneyConsole: ({ initialTab }: { initialTab: string }) => <div>Initial tab: {initialTab}</div>,
}));

import RestaurantMoneyPage from './page';

describe('RestaurantMoneyPage', () => {
  it('opens a validated URL-driven ledger tab', async () => {
    render(
      await RestaurantMoneyPage({
        searchParams: Promise.resolve({ tab: 'daily-close' }),
      })
    );
    expect(screen.getByText('Initial tab: daily-close')).toBeInTheDocument();
  });

  it.each([{ tab: 'unknown' }, { tab: ['daily-close', 'bills'] }, {}])(
    'falls back to Bills for an invalid or missing tab',
    async (searchParams) => {
      render(await RestaurantMoneyPage({ searchParams: Promise.resolve(searchParams) }));
      expect(screen.getByText('Initial tab: bills')).toBeInTheDocument();
    }
  );
});
