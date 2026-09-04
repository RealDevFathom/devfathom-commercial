import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const query = (data: unknown, overrides = {}) => ({
  data,
  error: null,
  isLoading: false,
  refetch: vi.fn(),
  ...overrides,
});
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyReports: { getPreferences: { setData: vi.fn() } } }),
    pharmacyReports: {
      branches: { useQuery: () => query({ branches: [{ id: 'b1', name: 'Main' }] }) },
      catalog: {
        useQuery: () =>
          query({ metrics: [], reports: [], permissions: { operational: true, financial: false } }),
      },
      getPreferences: { useQuery: () => query(undefined) },
      updatePreferences: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
      },
      commandCentre: {
        useQuery: () =>
          query({
            freshness: { asOf: '2026-09-04T10:00:00Z', source: 'transactional pharmacy ledgers' },
            permissions: { operational: true, financial: false },
            metrics: {},
          }),
      },
    },
  },
}));

import { PharmacyDashboardContent } from './pharmacy-dashboard-content';

describe('PharmacyDashboardContent states', () => {
  it('fails financial widgets closed while keeping operational widgets usable', () => {
    render(<PharmacyDashboardContent role="ADMIN" />);
    expect(screen.getAllByText('Restricted').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/reports:financial is required/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Stock actions' })).toBeVisible();
    expect(screen.queryByText('PKR 0')).not.toBeInTheDocument();
  });
});
