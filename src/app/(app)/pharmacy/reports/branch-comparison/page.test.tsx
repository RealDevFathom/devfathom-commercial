import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const context = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn(async () => context.value) }));
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

afterEach(() => {
  cleanup();
  context.value = {};
});

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
    expect(within(region).getByRole('columnheader', { name: /Khata overdue/ })).toBeVisible();
  });

  it('states the period and the organization currency the figures use', async () => {
    context.value = {
      organization: { id: 'org-a', currency: 'PKR' },
      entitlements: { organizationId: 'org-a' },
    };
    render(
      await BranchComparisonPage({
        searchParams: Promise.resolve({ from: '2026-10-26', to: '2026-11-01' }),
      })
    );
    expect(
      screen.getByText(/Figures cover 26 Oct 2026 – 1 Nov 2026 \(inclusive\)/)
    ).toHaveTextContent('Amounts in PKR');
    expect(screen.getByRole('columnheader', { name: 'Sales (PKR)' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to reports' })).toHaveAttribute(
      'href',
      '/pharmacy/reports?from=2026-10-26&to=2026-11-01'
    );
  });

  it('says the currency is unknown rather than asserting one from another organization', async () => {
    context.value = {
      organization: { id: 'org-b', currency: 'USD' },
      entitlements: { organizationId: 'org-a' },
    };
    render(
      await BranchComparisonPage({
        searchParams: Promise.resolve({ from: '2026-10-01', to: '2026-10-07' }),
      })
    );
    expect(screen.getByText(/Currency unknown/)).toBeVisible();
    expect(screen.queryByText(/USD/)).not.toBeInTheDocument();
  });
});
