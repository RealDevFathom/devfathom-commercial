import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { EntitlementsProvider } from '@/components/entitlements-provider';
import { FinanceContent } from './finance-content';
vi.mock('@/lib/trpc', () => {
  const query = { useQuery: () => ({ data: [] }) };
  return {
    trpc: {
      useUtils: () => ({}),
      finance: {
        getFinancialSummary: { useQuery: () => ({}) },
        getRecurringExpenses: {
          useQuery: () => ({
            data: [
              {
                id: 'w',
                name: 'Weekly hosting',
                amount: 10,
                category: 'HOSTING',
                nextDueDate: new Date('2020-01-01'),
                intervalLabel: 'Interval not supported',
              },
              {
                id: 'm',
                name: 'Monthly hosting',
                amount: 20,
                category: 'HOSTING',
                nextDueDate: new Date('2020-01-01'),
                intervalLabel: 'monthly',
              },
            ],
          }),
        },
        createRecurringExpense: { useMutation: () => ({}) },
        deleteRecurringExpense: { useMutation: () => ({}) },
        postDueRecurringExpenses: {
          useMutation: () => ({ data: { unsupported: [{ id: 'w', name: 'Weekly hosting' }] } }),
        },
        getBudgetVsActuals: query,
        getTransactions: query,
        createTransaction: { useMutation: () => ({}) },
      },
      projects: { getAll: query },
      clients: { getAll: query },
    },
  };
});
it('opens the new transaction form on the business date at 00:30 in Karachi', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-11-02T00:30:00+05:00'));
    const { container } = render(
      <EntitlementsProvider
        value={{
          organizationId: 'org',
          seatLimit: 1,
          activeSeats: 1,
          modules: [],
          enabledModules: [],
          limits: {},
          timeZone: 'Asia/Karachi',
        }}
      >
        <FinanceContent />
      </EntitlementsProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add Transaction' }));
    expect(container.querySelector('input[type=date]')).toHaveValue('2026-11-02');
  } finally {
    vi.useRealTimers();
  }
});

it('renders both charges and names the unsupported charge in the posting result', async () => {
  render(<FinanceContent />);
  fireEvent.click(screen.getByRole('tab', { name: 'Recurring' }));
  expect(await screen.findByText('Monthly hosting')).toBeVisible();
  expect(screen.getByText('Interval not supported')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent(
    '1 charge not posted: their billing interval is not monthly, quarterly or yearly. Delete and add them again with one of those.'
  );
  expect(screen.getByRole('status')).toHaveTextContent('Weekly hosting');
});
