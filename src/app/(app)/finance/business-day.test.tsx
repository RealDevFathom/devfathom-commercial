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
