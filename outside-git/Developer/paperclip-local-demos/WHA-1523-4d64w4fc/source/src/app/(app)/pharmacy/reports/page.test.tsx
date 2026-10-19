import { cleanup, render, screen, within } from '@testing-library/react';
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { DailyWorkPack, type DailyWorkPackProps } from './daily-work-pack';

const { createTRPCContext } = vi.hoisted(() => ({
  createTRPCContext: vi.fn(async () => ({
    entitlements: { organizationId: 'org-1' },
    organization: { id: 'org-1', currency: 'PKR', askFathomEnabled: false } as {
      id: string;
      currency?: string | null;
      askFathomEnabled?: boolean;
    } | null,
  })),
}));

const commandCentre = vi.fn(async () => ({
  freshness: { status: 'CURRENT', asOf: '2026-09-04T10:00:00Z', source: 'ledger' },
  metrics: {
    salesMinor: 10000 as number | null,
    marginMinor: 2500,
    cashMinor: 6000,
    cashVarianceMinor: 0,
    refundsMinor: 0,
    openStockSignals: 1,
    recommendedOrders: 1,
    expiryValueMinor30: 0,
    expiryValueMinor90: 0,
    safetyQueue: 7,
  },
}));
const branches = vi.fn(async () => ({ branches: [{ id: 'b1', name: 'Main' }] }));
type WorkPackReader = ReturnType<typeof pharmacyReportsRouter.createCaller>['dailyWorkPack'];
const dailyWorkPack = vi.fn<WorkPackReader>(async (input) => ({
  version: 1,
  mode: 'read-only-preparation',
  scope: { organizationId: 'org-1', branchIds: input.branchId ? [input.branchId] : ['b1'] },
  period: { from: input.from, to: input.to },
  asOf: input.asOf,
  readAt: input.asOf,
  permissions: { operational: true, financial: false },
  completeness: {
    status: 'unknown',
    allClear: false,
    uniqueProblemCount: null,
    additiveSavings: false,
    definition: 'Signals may overlap; empty reads do not prove all clear.',
  },
  sources: [],
  groups: [],
  missingInputs: [],
}));
const refreshAnomalies = vi.fn(async () => ({ evaluated: 1, signals: [] }));
const proposeExpiryReturn = vi.fn(async () => ({}));
vi.mock('@/server/trpc', () => ({ createTRPCContext }));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: {
    createCaller: () => ({
      branches,
      dailyWorkPack,
      commandCentre,
      anomalySignals: async () => [
        {
          id: 'anomaly_1',
          branchId: 'b1',
          kind: 'CASH_VARIANCE',
          status: 'OPEN',
          severity: 'REVIEW',
          scope: { branchId: 'b1' },
          exactNumbers: { expectedMinor: 10_000, countedMinor: 8_000, varianceMinor: -2_000 },
          explanation:
            'The close count differs from expected cash. Review the close evidence; no posting is created by this signal.',
          dataWindowStart: new Date('2026-09-01T00:00:00Z'),
          dataWindowEnd: new Date('2026-09-05T00:00:00Z'),
          sourceObservedAt: new Date('2026-09-04T10:00:00Z'),
          policyVersion: 'AI04-2026-09-04',
          estimateMethod: null,
          estimateWindow: null,
          estimateExclusions: null,
          estimateConfidence: null,
        },
      ],
      expiryAdvice: async () => [
        {
          lotId: 'lot-1',
          branchId: 'b1',
          medicineName: 'High-value medicine',
          batchNumber: 'B-1',
          supplierId: 'supplier-1',
          supplierName: 'Supplier',
          stockLocationId: 'location-1',
          onHandUnits: 90,
          unitCostMinor: 500,
          expiresAt: new Date('2026-10-05T00:00:00Z'),
          soldUnits: 10,
          historyDays: 30,
          returnWindowDays: 45,
          coldChain: false,
          classification: 'RETURNABLE',
          observedUnitsPerDay: 0.33,
          projectedClearAt: new Date('2027-06-01T00:00:00Z'),
          returnWindowStartsAt: new Date('2026-08-21T00:00:00Z'),
          valueAtRiskMinor: 40_000,
          projectedUnsoldUnits: 80,
          proposalAllowed: true,
          explanation: 'Observed 10 units over 30 days; projected clear after expiry.',
        },
      ],
      proposeExpiryReturn,
      refreshAnomalies,
      acknowledgeAnomaly: async () => ({}),
      snoozeAnomaly: async () => ({}),
      digestOverview: async () => ({
        branches: [{ id: 'b1', name: 'Main' }],
        settings: [],
        history: [],
        channels: { capture: { enabled: true }, whatsapp: { enabled: false, configured: false } },
      }),
      updateDigestSetting: async () => ({}),
      packAuthenticationFlags: async () => [],
      acknowledgePackAuthenticationFlag: async () => ({}),
      catalog: async () => ({
        permissions: { operational: true, financial: true },
        reports: [
          {
            key: 'sales-margin',
            label: 'Sales and margin',
            metrics: ['salesMinor'],
            filters: ['branch', 'date', 'supplier', 'ingredient', 'batch'],
          },
        ],
        metrics: [
          {
            key: 'salesMinor',
            label: "Today's sales",
            definition: 'Completed sales.',
            source: 'pharmacy_sales',
            scope: 'selected branches',
            permission: 'reports:financial',
            drillThrough: '/pharmacy/reports?section=sales',
          },
        ],
      }),
    }),
  },
}));

import ReportsPage from './page';

// Resolve the async server child for DOM assertions; production uses the page's Suspense boundary.
async function resolveServerChild(node: ReactNode): Promise<ReactNode> {
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === DailyWorkPack)
    return DailyWorkPack((node as ReactElement<DailyWorkPackProps>).props);
  if (!node.props.children) return node;
  const children = await Promise.all(Children.toArray(node.props.children).map(resolveServerChild));
  return cloneElement(node, {}, ...children);
}
async function PharmacyReportsPage(props: Parameters<typeof ReportsPage>[0]) {
  return resolveServerChild(await ReportsPage(props));
}

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('pharmacy report catalog filters', () => {
  it('connects the typed read with current server as-of and chat disabled, preserving follow-up and refresh scope', async () => {
    const before = Date.now();
    render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({
          branch: 'b1',
          from: '2026-09-01',
          to: '2026-09-04',
          supplier: 'supplier&1',
          ingredient: 'ingredient1',
          batch: 'batch1',
        }),
      })
    );
    expect(dailyWorkPack).toHaveBeenCalledTimes(1);
    const input = dailyWorkPack.mock.calls[0]![0];
    expect(input).toEqual({
      branchId: 'b1',
      from: '2026-09-01',
      to: '2026-09-04',
      asOf: expect.any(String),
    });
    expect(Date.parse(input.asOf)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(input.asOf)).toBeLessThanOrEqual(Date.now());
    expect(screen.getByRole('heading', { name: 'Daily work pack' })).toBeVisible();
    expect(screen.getByText(/Operational evidence only/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Supplier-credit follow-up' })).toHaveAttribute(
      'href',
      '/pharmacy/reports/supplier-credit-follow-up?branch=b1&from=2026-09-01&to=2026-09-04'
    );
    const form = screen.getByRole('button', { name: 'Refresh daily work pack' }).closest('form')!;
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/pharmacy/reports#daily-work-pack');
    expect(Object.fromEntries(new FormData(form))).toEqual({
      branch: 'b1',
      from: '2026-09-01',
      to: '2026-09-04',
      supplier: 'supplier&1',
      ingredient: 'ingredient1',
      batch: 'batch1',
    });
    expect(refreshAnomalies).not.toHaveBeenCalled();
    expect(proposeExpiryReturn).not.toHaveBeenCalled();
  });

  it('keeps figures when the work-pack read fails and exposes a scoped read retry', async () => {
    dailyWorkPack.mockRejectedValueOnce(new Error('private work-pack failure'));
    render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({ branch: 'b1', from: '2026-09-01', to: '2026-09-04' }),
      })
    );
    expect(screen.getByText('Sales', { exact: true })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Daily work pack could not load');
    expect(screen.getByRole('button', { name: 'Retry daily work pack' })).toBeEnabled();
    expect(screen.queryByText(/private work-pack failure/)).not.toBeInTheDocument();
  });

  it.each([
    { branch: 'outside' },
    { branch: ['b1', 'outside'] },
    { from: ['2026-09-01', '2026-09-02'] },
  ])('does not query work-pack sources for unauthorized or ambiguous scope %j', async (query) => {
    render(await PharmacyReportsPage({ searchParams: Promise.resolve(query) }));
    expect(dailyWorkPack).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Daily work pack unavailable' })).toBeVisible();
  });

  it('carries all supported filters and exposes the metric contract', async () => {
    render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({
          branch: 'b1',
          from: '2026-09-01',
          to: '2026-09-04',
          supplier: 'sup1',
          ingredient: 'ing1',
          batch: 'lot1',
        }),
      })
    );
    expect(screen.getByLabelText('Branch')).toHaveValue('b1');
    expect(screen.getByRole('option', { name: 'Main' })).toHaveProperty('selected', true);
    expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-09-04');
    expect(screen.getByLabelText('Supplier ID')).toHaveValue('sup1');
    expect(screen.getByLabelText('Ingredient ID')).toHaveValue('ing1');
    expect(screen.getByLabelText('Batch ID')).toHaveValue('lot1');
    expect(commandCentre).toHaveBeenCalledWith({
      branchId: 'b1',
      from: '2026-09-01',
      to: '2026-09-04',
      supplierId: 'sup1',
      ingredientId: 'ing1',
      batchId: 'lot1',
    });
    expect(screen.getByText('Source:').parentElement).toHaveTextContent('pharmacy_sales');
    expect(screen.getByRole('heading', { name: 'Daily owner digest' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Anomaly review signals' })).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Expiry and supplier-return advisor' })
    ).toBeVisible();
    const advisor = screen.getByText('High-value medicine').closest('article')!;
    expect(within(advisor).getByText('B-1')).toBeVisible();
    expect(within(advisor).getByText('90 units')).toBeVisible();
    expect(within(advisor).getByText('PKR 400.00')).toBeVisible();
    expect(advisor.querySelector('input[name="branchId"]')).toHaveValue('b1');
    expect(advisor.querySelector('input[name="lotId"]')).toHaveValue('lot-1');
    for (const [label, figure] of [
      ['Sales', 'PKR 100.00'],
      ['Gross margin', 'PKR 25.00'],
      ['Cash', 'PKR 60.00'],
      ['Cash variance', 'PKR 0.00'],
      ['Refunds', 'PKR 0.00'],
      ['Open stock signals', '1'],
      ['Recommended orders', '1'],
      ['Expiry ≤30d', 'PKR 0.00'],
      ['Expiry ≤90d', 'PKR 0.00'],
    ]) {
      const card = screen.getByText(label, { exact: true }).closest('[data-slot="stat"]')!;
      expect(within(card as HTMLElement).getByText(figure, { exact: true })).toBeVisible();
    }
    expect(screen.queryByRole('button', { name: /export|download/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /export|download/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft proposal' })).toBeVisible();
    expect(screen.getByText(/never rank staff, imply misconduct/)).toBeVisible();
    expect(screen.getByText(/no posting is created by this signal/)).toBeVisible();
    expect(screen.getByLabelText('Acknowledgement reason')).toBeRequired();
    expect(screen.getByLabelText('Snooze reason')).toBeRequired();
    expect(screen.getByRole('heading', { name: 'Digest history' })).toBeVisible();
    expect(
      screen.getByText(
        'No digests captured yet. Turn on a branch digest; history appears after its scheduled time.'
      )
    ).toBeVisible();
  });

  it('preserves scope and suppresses success and figures when the report rejects', async () => {
    commandCentre.mockRejectedValueOnce(new Error('synthetic report failure'));
    render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({
          branch: 'b1',
          from: '2026-09-01',
          to: '2026-09-04',
          batch: 'lot1',
        }),
      })
    );
    expect(screen.getByRole('heading', { name: 'Report could not load' })).toBeVisible();
    expect(screen.getByLabelText('Branch')).toHaveValue('b1');
    expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-09-04');
    expect(screen.getByLabelText('Batch ID')).toHaveValue('lot1');
    expect(screen.queryByText('Current', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Sales', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('synthetic report failure')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply filters' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Daily work pack' })).toBeVisible();
    expect(dailyWorkPack).toHaveBeenCalledTimes(1);
  });

  it('does not label a historical report as today', async () => {
    render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({
          branch: 'b1',
          from: '2020-01-01',
          to: '2020-01-31',
        }),
      })
    );
    expect(screen.getByText('Sales', { exact: true })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Today at a glance' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Selected period at a glance' })).toBeVisible();
    expect(screen.getByText(/Report period: 2020-01-01 to 2020-01-31/)).toHaveTextContent(
      'Branch scope: Main'
    );
    expect(screen.queryByText("Today's sales")).not.toBeInTheDocument();
  });

  it('preserves nonzero minor units in the displayed sales value', async () => {
    const base = await commandCentre.getMockImplementation()!();
    commandCentre.mockResolvedValueOnce({
      ...base,
      metrics: { ...base.metrics, salesMinor: 10001 },
    });
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
    const card = screen.getByText('Sales', { exact: true }).closest('[data-slot="stat"]')!;
    expect(within(card as HTMLElement).getByText('PKR 100.01', { exact: true })).toBeVisible();
  });

  it('uses the authenticated organization currency for every formatted amount and discloses its historical basis', async () => {
    createTRPCContext.mockResolvedValueOnce({
      entitlements: { organizationId: 'org-1' },
      organization: { id: 'org-1', currency: 'USD' },
    });
    const base = await commandCentre.getMockImplementation()!();
    commandCentre.mockResolvedValueOnce({
      ...base,
      metrics: {
        ...base.metrics,
        salesMinor: 10001,
        marginMinor: -1,
        cashMinor: 123456,
        cashVarianceMinor: -123456,
        refundsMinor: Number.MAX_SAFE_INTEGER,
        expiryValueMinor30: Number.MAX_SAFE_INTEGER + 1,
        expiryValueMinor90: 1,
      },
    });
    render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({ from: '2020-01-01', to: '2020-01-31' }),
      })
    );
    for (const [label, figure] of [
      ['Sales', 'USD 100.01'],
      ['Gross margin', 'USD -0.01'],
      ['Cash', 'USD 1,234.56'],
      ['Cash variance', 'USD -1,234.56'],
      ['Refunds', 'USD 90,071,992,547,409.91'],
      ['Expiry ≤30d', '—'],
      ['Expiry ≤90d', 'USD 0.01'],
    ]) {
      const card = screen.getByText(label, { exact: true }).closest('[data-slot="stat"]')!;
      expect(within(card as HTMLElement).getByText(figure, { exact: true })).toBeVisible();
    }
    const advisor = screen.getByText('High-value medicine').closest('article')!;
    expect(within(advisor).getByText('USD 400.00')).toBeVisible();
    expect(screen.getByText(/Report period: 2020-01-01 to 2020-01-31/)).toHaveTextContent(
      'Currency basis: current organization setting (USD); historical transaction currency is not verified.'
    );
    expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
    expect(createTRPCContext).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    null,
    { id: 'org-1' },
    { id: 'org-1', currency: null },
    { id: 'org-1', currency: '' },
    { id: 'org-1', currency: 'invalid' },
    { id: 'other-org', currency: 'USD' },
  ])(
    'shows explicit unknown currency for unavailable or mismatched organization %j',
    async (organization) => {
      createTRPCContext.mockResolvedValueOnce({
        entitlements: { organizationId: 'org-1' },
        organization,
      });
      const base = await commandCentre.getMockImplementation()!();
      commandCentre.mockResolvedValueOnce({
        ...base,
        metrics: { ...base.metrics, salesMinor: 10001 },
      });
      render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
      const card = screen.getByText('Sales', { exact: true }).closest('[data-slot="stat"]')!;
      expect(within(card as HTMLElement).getByText('100.01 (currency unknown)')).toBeVisible();
      const advisor = screen.getByText('High-value medicine').closest('article')!;
      expect(within(advisor).getByText('400.00 (currency unknown)')).toBeVisible();
      expect(screen.getByText(/Currency unknown: an authoritative currency/)).toBeVisible();
      expect(screen.queryByText(/PKR|USD/)).not.toBeInTheDocument();
    }
  );

  it.each([
    [null, '—'],
    [-1, 'PKR -0.01'],
    [-123456, 'PKR -1,234.56'],
    [Number.MAX_SAFE_INTEGER, 'PKR 90,071,992,547,409.91'],
    [Number.MAX_SAFE_INTEGER + 1, '—'],
    [NaN, '—'],
  ])('formats minor units %s without rounding or inventing zero', async (salesMinor, expected) => {
    const base = await commandCentre.getMockImplementation()!();
    commandCentre.mockResolvedValueOnce({ ...base, metrics: { ...base.metrics, salesMinor } });
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
    const card = screen.getByText('Sales', { exact: true }).closest('[data-slot="stat"]')!;
    expect(within(card as HTMLElement).getByText(expected, { exact: true })).toBeVisible();
  });

  it.each(['b1', undefined])(
    'labels safety independently of branch %s and without backend scope metadata',
    async (branch) => {
      render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch }) }));
      const card = screen
        .getByText('Organization-wide safety queue')
        .closest('[data-slot="stat"]')!;
      expect(within(card as HTMLElement).getByText('7', { exact: true })).toBeVisible();
      expect(card).not.toHaveTextContent('Selected branch');
      expect(screen.getByText(/The selected branch does not apply to this queue/)).toBeVisible();
      if (!branch)
        expect(screen.getAllByText('All available branches · ledger source')).toHaveLength(9);
    }
  );

  it.each([
    ['2026-09-04', '2026-09-01'],
    ['2026-02-30', '2026-03-04'],
    ['invalid', '2026-03-04'],
  ])('rejects invalid range %s to %s without fetching figures', async (from, to) => {
    render(
      await PharmacyReportsPage({ searchParams: Promise.resolve({ from, to, branch: 'b1' }) })
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Enter valid dates');
    expect(screen.getByLabelText('From')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Branch')).toHaveValue('b1');
    expect(commandCentre).not.toHaveBeenCalled();
    expect(dailyWorkPack).not.toHaveBeenCalled();
    expect(screen.queryByText('Sales', { exact: true })).not.toBeInTheDocument();
  });

  it('shows the no-branches state without fetching figures', async () => {
    branches.mockResolvedValueOnce({ branches: [] });
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'No reportable branches' })).toBeVisible();
    expect(commandCentre).not.toHaveBeenCalled();
    expect(dailyWorkPack).not.toHaveBeenCalled();
  });

  it('does not badge stale source data as current', async () => {
    const base = await commandCentre.getMockImplementation()!();
    commandCentre.mockResolvedValueOnce({
      ...base,
      freshness: { ...base.freshness, status: 'STALE' },
    });
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('STALE', { exact: true })).toBeVisible();
    expect(screen.queryByText('Current', { exact: true })).not.toBeInTheDocument();
  });

  it('shows permission failure without exposing data or internal errors', async () => {
    branches.mockRejectedValueOnce(new Error('private internal error'));
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Reports unavailable' })).toBeVisible();
    expect(screen.queryByText('private internal error')).not.toBeInTheDocument();
    expect(commandCentre).not.toHaveBeenCalled();
    expect(dailyWorkPack).not.toHaveBeenCalled();
  });
});
