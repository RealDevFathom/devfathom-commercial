import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MarketingSummary } from './marketing-summary';
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
it('links the selected branch and explains unavailable evidence without zero totals', () => {
  render(<MarketingSummary report={null} money={String} branch="branch-a" />);
  expect(screen.getByRole('link', { name: 'Review campaigns' })).toHaveAttribute(
    'href',
    '/pharmacy/marketing?branch=branch-a'
  );
  expect(screen.getByText(/No zero totals inferred/)).toBeInTheDocument();
});
it.each(['development', 'test', 'production'])(
  'keeps live evidence and signed margin while limiting sandbox counts in %s',
  (environment) => {
    vi.stubEnv('NODE_ENV', environment);
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
    if (environment === 'production') {
      expect(screen.queryByText(/Sandbox only:/)).not.toBeInTheDocument();
    } else {
      expect(screen.getByText(/Sandbox only: 3 captures/)).toBeInTheDocument();
    }
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.getByText(/Excluded unverified links: 2/)).toBeInTheDocument();
    expect(
      screen.getByText(/Supplier, ingredient and batch filters do not scope/)
    ).toBeInTheDocument();
    expect(screen.getByText(/no causal uplift claim/)).toBeInTheDocument();
  }
);

it('uses shop language for the campaign heading', () => {
  render(<MarketingSummary report={null} money={String} />);
  expect(screen.getByRole('heading', { name: 'Campaign results' })).toBeVisible();
  expect(screen.queryByText('Marketing evidence')).not.toBeInTheDocument();
});

it('DEV-943: names the organisation zone the period was counted in', () => {
  const report = {
    period: { from: '2026-11-13', to: '2026-11-19', timezone: 'Asia/Karachi' },
    cutoff: '2026-11-19T19:00:00Z',
    prepared: 0,
    providerAccepted: 0,
    delivered: 0,
    failed: 0,
    unknown: 0,
    contradictory: 0,
    consentOptOuts: 0,
    unassignedConsentOptOuts: 0,
    sandbox: { captures: 0, delivered: 0, failed: 0, unknown: 0 },
    attribution: {
      attributedReceipts: 0,
      recoveredSalesMinor: 0,
      recoveredMarginMinor: 0,
      excludedUnverifiedLinks: 0,
      excludedCompetingLinks: 0,
    },
    definitions: {},
    exclusions: [],
  };
  const { unmount } = render(<MarketingSummary report={report as never} money={String} />);
  expect(screen.getByText(/2026-11-13–2026-11-19 \(PKT/)).toBeInTheDocument();
  unmount();
  render(
    <MarketingSummary
      report={{ ...report, period: { ...report.period, timezone: 'UTC' } } as never}
      money={String}
    />
  );
  expect(screen.getByText(/2026-11-13–2026-11-19 \(UTC/)).toBeInTheDocument();
});
