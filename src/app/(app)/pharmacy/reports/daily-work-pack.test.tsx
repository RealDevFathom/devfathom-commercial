import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DailyWorkPack, DailyWorkPackLoading, type DailyWorkPackProps } from './daily-work-pack';

type Pack = Awaited<ReturnType<DailyWorkPackProps['read']>>;
const from = '2026-09-01';
const to = '2026-09-04';
const time = '2026-09-12T10:00:00.000Z';
function fixture(): Pack {
  return {
    version: 1,
    mode: 'read-only-preparation',
    scope: { organizationId: 'org1', branchIds: ['b1'] },
    period: { from, to },
    asOf: time,
    readAt: time,
    permissions: { operational: true, financial: true },
    completeness: {
      status: 'partial',
      allClear: false,
      uniqueProblemCount: null,
      additiveSavings: false,
      definition: 'Signals may overlap across sources. Amounts are never additive savings.',
    },
    sources: [
      {
        id: 'b1:anomalies',
        kind: 'anomalies',
        scope: { organizationId: 'org1', branchId: 'b1' },
        status: 'available',
        coverage: 'partial',
        returnedRows: 200,
        rowLimit: 200,
        limitReached: true,
        timeBasis: 'Persisted records matching the exact requested data window; not refreshed.',
        window: { from: from + 'T00:00:00.000Z', toExclusive: '2026-09-05T00:00:00.000Z' },
        evaluatedAsOf: null,
        readAt: time,
        freshness: 'persisted-unverified',
        missingInputs: ['200-row source cap reached; further records may be omitted.'],
      },
      {
        id: 'b1:expiry',
        kind: 'expiry',
        scope: { organizationId: 'org1', branchId: 'b1' },
        status: 'unavailable',
        coverage: 'partial',
        returnedRows: null,
        rowLimit: null,
        limitReached: false,
        timeBasis: 'Current balances with trailing 30-day sales. Requested period is not applied.',
        window: null,
        evaluatedAsOf: time,
        readAt: time,
        freshness: 'live-inputs-not-historical',
        missingInputs: ['Expiry source unavailable.'],
      },
    ],
    groups: [
      {
        key: 'anomaly-review',
        section: 'finance-compliance',
        tasks: [
          {
            id: 'task1',
            branchId: 'b1',
            title: 'Review recorded financial exceptions',
            evidence: [
              {
                id: 'evidence1',
                sourceId: 'b1:anomalies',
                reference: { kind: 'anomaly', id: 'anomaly1' },
                state: 'STALE',
                counts: { missingUnits: 0 },
                amounts: [
                  {
                    key: 'varianceMinor',
                    value: -12345,
                    unit: 'minor',
                    currency: null,
                    definition: 'Counted less expected cash; not profit.',
                  },
                ],
                observedAt: time,
                computedAt: null,
                freshnessSeconds: 0,
                dueAt: null,
                missingInputs: ['Verify stale source facts.'],
              },
            ],
            missingInputs: ['Recorded exceptions are not established loss.'],
            nextActions: [
              {
                kind: 'review',
                label: 'Review recorded exceptions',
                href: '/pharmacy/reports?branch=b1&from=2026-09-01&to=2026-09-04',
                createsAction: false,
              },
            ],
          },
        ],
      },
    ],
    missingInputs: [{ sourceId: 'b1:expiry', reason: 'Expiry source unavailable.' }],
  };
}
function props(pack = fixture()): DailyWorkPackProps {
  return {
    read: vi.fn<DailyWorkPackProps['read']>().mockResolvedValue(pack),
    filters: { branchId: 'b1', from, to },
    branches: [{ id: 'b1', name: 'Main' }],
    refreshFields: { branch: 'b1', from, to, supplier: 'supplier1' },
  };
}
afterEach(cleanup);

describe('daily work pack report section', () => {
  it('renders an independent accessible loading state with refresh disabled', () => {
    render(<DailyWorkPackLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading permitted work-pack sources');
    expect(screen.getByRole('button', { name: 'Refresh daily work pack' })).toBeDisabled();
    expect(document.getElementById('daily-work-pack')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows evidence-linked tasks, each source clock and cap, partial failure, and non-additive semantics', async () => {
    render(await DailyWorkPack(props()));
    expect(screen.getByText(/^Requested period:/)).toHaveTextContent(
      '2026-09-01 to 2026-09-04. Branch scope: Main'
    );
    expect(screen.getByText(/Signals may overlap/)).toHaveTextContent('never additive savings');
    expect(screen.getByText(/Supplier, ingredient and batch filters/)).toBeVisible();
    expect(screen.getByText(/No money or time saved is calculated/)).toBeVisible();
    expect(screen.getByText('Expiry source unavailable.')).toBeVisible();
    expect(screen.getByText(/Returned rows: Unavailable/)).toBeVisible();
    expect(screen.getByText(/Returned rows: 200/)).toHaveTextContent('Row limit: 200');
    expect(screen.getByText(/200-row source cap reached/)).toBeVisible();
    expect(screen.getByText(/Window: 2026-09-01/)).toHaveTextContent(
      '2026-09-05T00:00:00.000Z (exclusive end)'
    );
    expect(screen.getByText(/Window: 2026-09-01/)).toHaveTextContent(
      'Persisted; freshness unverified'
    );
    fireEvent.click(screen.getByText('Evidence and missing inputs'));
    const sourceLink = screen.getByRole('link', { name: 'Source: Recorded anomalies' });
    expect(sourceLink).toHaveAttribute('href', '#work-pack-source-b1%3Aanomalies');
    expect(
      document.getElementById(decodeURIComponent(sourceLink.getAttribute('href')!.slice(1)))
    ).toHaveTextContent('Recorded anomalies · Main');
    expect(screen.getByText('-123.45 (currency unknown)')).toBeVisible();
    expect(screen.getByText('Counted less expected cash; not profit.')).toBeVisible();
    expect(screen.getByText(/Observed:/)).toHaveTextContent('Source freshness seconds: 0');
    expect(screen.getByText(/Observed:/)).toHaveTextContent('Computed: Unavailable');
    expect(screen.getByText('Verify stale source facts.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review recorded exceptions' })).toHaveAttribute(
      'href',
      fixture().groups[0]!.tasks[0]!.nextActions[0]!.href
    );
    expect(
      screen.queryByRole('button', { name: /draft|refresh signals|send/i })
    ).not.toBeInTheDocument();
  });

  it.each([
    [0, '0.00 (currency unknown)'],
    [-1, '-0.01 (currency unknown)'],
    [Number.MAX_SAFE_INTEGER, '90071992547409.91 (currency unknown)'],
    [Number.MAX_SAFE_INTEGER + 1, '—'],
    [NaN, '—'],
  ])(
    'preserves integer minor amount %s without inventing source currency',
    async (value, expected) => {
      const pack = fixture();
      pack.groups[0]!.tasks[0]!.evidence[0]!.amounts![0]!.value = value as number;
      render(await DailyWorkPack(props(pack)));
      fireEvent.click(screen.getByText('Evidence and missing inputs'));
      expect(screen.getByText(expected)).toBeVisible();
      expect(screen.queryByText(/PKR|USD/)).not.toBeInTheDocument();
    }
  );

  it('distinguishes known zero rows from unavailable sources when no evidence returns', async () => {
    const pack = fixture();
    pack.groups[0]!.tasks[0]!.evidence = [];
    pack.sources[0]!.returnedRows = 0;
    pack.sources[0]!.limitReached = false;
    render(await DailyWorkPack(props(pack)));
    expect(screen.getByRole('status')).toHaveTextContent('not an all-clear result');
    expect(screen.getByText(/Returned rows: 0/)).toBeVisible();
    expect(screen.getByText(/Returned rows: Unavailable/)).toBeVisible();
    expect(screen.queryByText('Evidence and missing inputs')).not.toBeInTheDocument();
  });

  it('renders only operational contract data and sends no client financial authority', async () => {
    const pack = fixture();
    pack.permissions.financial = false;
    pack.sources = [];
    pack.groups = [];
    pack.missingInputs = [];
    const input = props(pack);
    render(await DailyWorkPack(input));
    expect(input.read).toHaveBeenCalledExactlyOnceWith({
      branchId: 'b1',
      from,
      to,
      asOf: expect.any(String),
    });
    expect(screen.getByText(/Financial sources were not queried for your role/)).toBeVisible();
    expect(
      screen.queryByText(/varianceMinor|anomaly1|Supplier credit|Expiry advice/)
    ).not.toBeInTheDocument();
  });

  it('keeps errors private and uses a scoped GET retry with a new server timestamp on reread', async () => {
    const input = props();
    vi.mocked(input.read).mockRejectedValueOnce(new Error('secret database details'));
    const before = Date.now();
    render(await DailyWorkPack(input));
    expect(screen.getByRole('alert')).toHaveTextContent('Daily work pack could not load');
    expect(screen.queryByText(/secret database/)).not.toBeInTheDocument();
    const form = screen.getByRole('button', { name: 'Retry daily work pack' }).closest('form')!;
    expect(form).toHaveAttribute('method', 'get');
    expect(Object.fromEntries(new FormData(form))).toEqual(input.refreshFields);
    expect(within(form).queryByRole('textbox')).not.toBeInTheDocument();
    cleanup();
    render(await DailyWorkPack(input));
    expect(input.read).toHaveBeenCalledTimes(2);
    for (const [request] of vi.mocked(input.read).mock.calls) {
      expect(Date.parse(request.asOf)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(request.asOf)).toBeLessThanOrEqual(Date.now());
    }
    expect(screen.getByRole('button', { name: 'Refresh daily work pack' })).toBeEnabled();
  });
});
