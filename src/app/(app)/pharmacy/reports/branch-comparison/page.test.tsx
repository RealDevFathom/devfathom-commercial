import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn().mockResolvedValue({}) }));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: {
    createCaller: () => ({
      branchComparison: async () => ({
        estimateMethod: 'Sum of recorded values.',
        estimateExclusions: ['events without a recorded value'],
        rows: [
          {
            branchId: 'north',
            branchName: 'North',
            salesMinor: 10000,
            marginMinor: 2500,
            lostDemandEstimateMinor: 1200,
            lostDemandRecordedEvents: 3,
            expiryAtRiskMinor: 900,
            khataAgingMinor: 400,
          },
        ],
      }),
    }),
  },
}));

import BranchComparisonPage from './page';

describe('branch comparison accessibility', () => {
  it('provides a named keyboard focus target for scrolling to off-screen metrics', async () => {
    render(
      await BranchComparisonPage({
        searchParams: Promise.resolve({ from: '2026-10-01', to: '2026-10-07' }),
      })
    );

    const region = screen.getByRole('region', { name: 'Branch performance' });
    expect(region).toHaveAttribute('tabindex', '0');
    region.focus();
    expect(region).toHaveFocus();
    expect(within(region).getByRole('table')).toBeVisible();
    expect(within(region).getByRole('columnheader', { name: 'Khata overdue' })).toBeVisible();
  });
});
