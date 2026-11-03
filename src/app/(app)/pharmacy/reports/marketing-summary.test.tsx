import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MarketingSummary } from './marketing-summary';
afterEach(cleanup);
it('links the selected branch and explains unavailable evidence without zero totals', () => {
  render(<MarketingSummary report={null} money={String} branch="branch-a" />);
  expect(screen.getByRole('link', { name: 'Review campaigns' })).toHaveAttribute(
    'href',
    '/pharmacy/marketing?branch=branch-a'
  );
  expect(screen.getByText(/Nothing is shown as zero/)).toBeInTheDocument();
});
it('shows signed margin and labels sandbox and unverified attribution separately', () => {
  const report = {
    period: { from: '2026-10-01', to: '2026-10-08', timezone: 'UTC' },
    cutoff: '2026-10-09T00:00:00Z',
    prepared: 5,
    providerAccepted: 1,
    delivered: 1,
    failed: 0,
    unknown: 4,
    contradictory: 0,
    consentOptOuts: 0,
    unassignedConsentOptOuts: 2,
    sandbox: { captures: 3, delivered: 2, failed: 1, unknown: 0 },
    attribution: {
      attributedReceipts: 1,
      recoveredSalesMinor: 800,
      recoveredMarginMinor: -50,
      excludedUnverifiedLinks: 2,
      excludedCompetingLinks: 0,
    },
    definitions: { attribution: 'Observational receipt links; no causal uplift claim.' },
    exclusions: [{ reason: 'OPTED_OUT', count: 2 }],
  };
  render(
    <MarketingSummary financial report={report as never} money={(value) => `${value} minor`} />
  );
  expect(screen.getByText('-50 minor')).toBeInTheDocument();
  expect(screen.getByText(/Test sends: 3 sent, 2 delivered, 1 failed/)).toBeInTheDocument();
  expect(
    screen.getByText(/supplier, ingredient and batch filters do not/)
  ).toBeInTheDocument();
  expect(screen.getByText(/does not prove the message caused the purchase/)).toBeInTheDocument();
  expect(screen.getByText('Opted out: 2')).toBeInTheDocument();
  expect(screen.getByText('Messages prepared')).toBeInTheDocument();
  const text = document.body.textContent ?? '';
  for (const jargon of ['Prepared captures', 'Contradictory evidence', 'Sandbox only', 'cutoff'])
    expect(text).not.toContain(jargon);
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
});
