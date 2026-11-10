import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createTRPCContext, branchComparison } = vi.hoisted(() => ({
  createTRPCContext: vi.fn(),
  branchComparison: vi.fn(),
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext }));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: { createCaller: () => ({ branchComparison }) },
}));

import BranchComparisonPage from './page';

const comparison = {
  estimateMethod: 'Sum of recorded values.',
  estimateExclusions: ['events without a recorded value'],
  rows: [
    {
      branchId: 'north',
      branchName: 'North',
      salesMinor: 123456,
      marginMinor: 2500,
      lostDemandEstimateMinor: 1200,
      lostDemandRecordedEvents: 3,
      expiryAtRiskMinor: 900,
      khataAgingMinor: 400,
    },
  ],
};

async function renderComparison() {
  render(
    await BranchComparisonPage({
      searchParams: Promise.resolve({ from: '2026-10-01', to: '2026-10-07' }),
    })
  );
  return within(screen.getByRole('row', { name: /^North / }));
}

beforeEach(() => {
  createTRPCContext.mockReset().mockResolvedValue({
    organization: { id: 'org-a', currency: 'PKR' },
    entitlements: { organizationId: 'org-a' },
  });
  branchComparison.mockReset().mockResolvedValue(comparison);
});
afterEach(cleanup);

describe('branch comparison currency', () => {
  it.each(['PKR', 'USD'])('identifies %s on every monetary metric', async (currency) => {
    createTRPCContext.mockResolvedValue({
      organization: { id: 'org-a', currency },
      entitlements: { organizationId: 'org-a' },
    });
    const row = await renderComparison();
    for (const amount of ['1,234.56', '25.00', '12.00', '9.00', '4.00']) {
      expect(row.getByText(`${currency} ${amount}`, { exact: false })).toBeVisible();
    }
    expect(row.getByText(`${currency} 12.00 (3 events)`)).toBeVisible();
    expect(screen.getByText(/Currency basis: current organization setting/)).toHaveTextContent(
      `Currency basis: current organization setting (${currency}); historical transaction currency is not verified.`
    );
  });

  it.each([null, '', 'pkr', 'PKR<script>'])(
    'labels unknown currency explicitly when the setting is %s',
    async (currency) => {
      createTRPCContext.mockResolvedValue({
        organization: { id: 'org-a', currency },
        entitlements: { organizationId: 'org-a' },
      });
      const row = await renderComparison();
      for (const amount of ['1,234.56', '25.00', '12.00', '9.00', '4.00']) {
        expect(row.getByText(`${amount} (currency unknown)`, { exact: false })).toBeVisible();
      }
      expect(screen.getByText(/Currency unknown: an authoritative currency/)).toBeVisible();
    }
  );

  it('does not use another organization’s currency', async () => {
    createTRPCContext.mockResolvedValue({
      organization: { id: 'org-b', currency: 'USD' },
      entitlements: { organizationId: 'org-a' },
    });
    const row = await renderComparison();
    expect(row.getByRole('cell', { name: '1,234.56 (currency unknown)' })).toBeVisible();
    expect(screen.queryByText(/USD/)).not.toBeInTheDocument();
  });

  it('does not invent currency when the organization is unavailable', async () => {
    createTRPCContext.mockResolvedValue({
      organization: null,
      entitlements: { organizationId: 'org-a' },
    });
    const row = await renderComparison();
    expect(row.getByRole('cell', { name: '1,234.56 (currency unknown)' })).toBeVisible();
  });

  it('keeps unavailable amounts distinct from zero and preserves negative margins', async () => {
    branchComparison.mockResolvedValue({
      ...comparison,
      rows: [{ ...comparison.rows[0], salesMinor: 0, marginMinor: -2500, khataAgingMinor: null }],
    });
    const row = await renderComparison();
    expect(row.getByRole('cell', { name: 'PKR 0.00' })).toBeVisible();
    expect(row.getByRole('cell', { name: 'PKR -25.00' })).toBeVisible();
    expect(row.getByRole('cell', { name: '—' })).toBeVisible();
  });
});
