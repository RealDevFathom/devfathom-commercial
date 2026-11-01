import { cleanup, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const actor = vi.hoisted(() => ({ role: 'ADMIN' }));
const signalStaff = vi.hoisted(() => ({ userId: 'cashier_1' as string | undefined }));
const branchList = vi.hoisted(() => ({
  value: [{ id: 'b1', name: 'Main' }] as { id: string; name: string }[],
}));
const optionDb = vi.hoisted(() => ({
  pharmacySupplier: {
    findMany: vi.fn(async (_args: unknown) => [
      { id: 'sup1', name: 'Acme Distributors', active: true },
      { id: 'sup2', name: 'Old Supplier', active: false },
    ]),
  },
  ingredient: {
    findMany: vi.fn(async (_args: unknown) => [{ id: 'ing1', name: 'Paracetamol' }]),
  },
  pharmacyManufacturingBatch: {
    findMany: vi.fn(async (_args: unknown) => [
      {
        id: 'lot1',
        batchNumber: 'B-1',
        expiresAt: new Date('2027-03-31T00:00:00Z'),
        medicine: { productName: 'Panadol 500mg' },
      },
    ]),
  },
}));

const commandCentre = vi.fn(async () => ({
  freshness: { status: 'CURRENT', asOf: '2026-09-04T10:00:00Z', source: 'ledger' },
  metrics: {
    salesMinor: 10000,
    marginMinor: 2500,
    cashMinor: 6000,
    cashVarianceMinor: 0,
    refundsMinor: 0,
    openStockSignals: 1,
    recommendedOrders: 1,
    expiryValueMinor30: 0,
    expiryValueMinor90: 0,
  },
}));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn(async () => ({
    organization: { id: 'org-a', currency: 'PKR' },
    entitlements: { organizationId: 'org-a' },
    session: { user: actor },
    db: optionDb,
  })),
}));
vi.mock('@/server/routers/pharmacy-sales', () => ({
  pharmacySalesRouter: {
    createCaller: () => ({
      demandAggregate: async ({ from, to }: { from: Date; to: Date }) => ({
        label: 'Estimate',
        method: 'Explicit POS-10 events grouped by requested item and cause',
        window: { from, to },
        exclusions: ['searches without an explicit event', 'abandoned carts'],
        confidence: 'observed-events-only',
        rows: [],
      }),
    }),
  },
}));
// The installed Next Vitest guide excludes async RSC rendering; this case covers sibling reports.
vi.mock('./daily-work-pack', () => ({
  DailyWorkPack: () => null,
  DailyWorkPackLoading: () => null,
}));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: {
    createCaller: () => ({
      branches: async () => ({ branches: branchList.value }),
      commandCentre,
      anomalySignals: async () => [
        {
          id: 'anomaly_1',
          branchId: 'b1',
          kind: 'CASH_VARIANCE',
          status: 'OPEN',
          severity: 'REVIEW',
          scope: { branchId: 'b1', userId: signalStaff.userId },
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
      proposeExpiryReturn: async () => ({}),
      refreshAnomalies: async () => ({ evaluated: 1, signals: [] }),
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
        permissions: { operational: true, financial: true, owner: true },
        reports: [
          {
            key: 'sales-margin',
            label: 'Sales and margin',
            metrics: ['salesMinor'],
            filters: ['branch', 'date', 'supplier', 'ingredient', 'batch'],
          },
          {
            key: 'inventory-expiry',
            label: 'Inventory and expiry',
            metrics: ['expiryValueMinor60'],
            filters: ['branch', 'ingredient', 'batch'],
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
          {
            key: 'expiryValueMinor60',
            label: 'Expiry value · 60 days',
            definition: 'On-hand units expiring within 60 days.',
            source: 'pharmacy_stock_balances',
            scope: 'selected branches at read time',
            permission: 'reports:operational',
            drillThrough: '/pharmacy/inventory',
          },
        ],
      }),
    }),
  },
}));

import PharmacyReportsPage from './page';

describe('pharmacy report catalog filters', () => {
  beforeEach(() => {
    cleanup();
    actor.role = 'ADMIN';
    signalStaff.userId = 'cashier_1';
    branchList.value = [{ id: 'b1', name: 'Main' }];
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
    // Name pickers submit the same IDs the filters always accepted.
    expect(screen.getByLabelText('Supplier')).toHaveValue('sup1');
    expect(screen.getByLabelText('Ingredient')).toHaveValue('ing1');
    expect(screen.getByLabelText('Batch')).toHaveValue('lot1');
    expect(screen.getByRole('option', { name: 'Acme Distributors' })).toHaveValue('sup1');
    expect(screen.getByRole('option', { name: 'Old Supplier (inactive)' })).toHaveValue('sup2');
    expect(screen.getByRole('option', { name: 'Paracetamol' })).toHaveValue('ing1');
    expect(
      screen.getByRole('option', { name: 'Panadol 500mg · batch B-1 · expires 31 Mar 2027' })
    ).toHaveValue('lot1');
    expect(screen.queryByLabelText(/ID$/)).not.toBeInTheDocument();
    expect(optionDb.pharmacySupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a' } })
    );
    expect(commandCentre).toHaveBeenCalledWith(
      expect.objectContaining({ supplierId: 'sup1', ingredientId: 'ing1', batchId: 'lot1' })
    );
    expect(screen.getAllByText('Source:')[0]!.parentElement).toHaveTextContent('pharmacy_sales');
    expect(screen.getByRole('heading', { name: 'Daily owner digest' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Anomaly review signals' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open related audit trail' })).toHaveAttribute(
      'href',
      '/audit-logs?actorId=cashier_1'
    );
    expect(
      screen.getByRole('heading', { name: 'Expiry and supplier-return advisor' })
    ).toBeVisible();
    expect(screen.getByText('High-value medicine')).toBeVisible();
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

  it('explains audit access to non-admin report viewers without offering an inaccessible link', async () => {
    actor.role = 'MANAGER';
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    expect(screen.getByRole('heading', { name: 'Anomaly review signals' })).toBeVisible();
    expect(screen.getByText('Staff drill-down · cashier_1')).toBeVisible();
    expect(screen.getByText('Related audit trail requires an administrator.')).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Open related audit trail' })
    ).not.toBeInTheDocument();
  });

  it('links signals without staff attribution to the supported audit search filter', async () => {
    signalStaff.userId = undefined;
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    expect(screen.getByRole('link', { name: 'Open related audit trail' })).toHaveAttribute(
      'href',
      '/audit-logs?search=anomaly_1'
    );
  });

  it('offers the sub-reports as header actions styled like every other Studio control', async () => {
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    const header = document.querySelector('[data-slot="page-header"]')!;
    const subReports = within(header as HTMLElement).getByRole('navigation', {
      name: 'Sub-reports',
    });
    const links = within(subReports).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Replenishment',
      'Repeat purchasing',
      'Supplier-credit follow-up',
      'Compare branches',
    ]);
    expect(links[0]).toHaveAttribute('href', '/pharmacy/reports/replenishment?branch=b1');
    expect(links[1]).toHaveAttribute('href', '/pharmacy/reports/repeat-purchasing?branch=b1');
    // Button geometry, not bare underlined text.
    for (const link of links) {
      expect(link.className).toContain('border');
      expect(link.className).not.toMatch(/(^|\s)underline(\s|$)/);
    }
  });

  it('keeps a filtered ID selectable when it is not in the loaded list', async () => {
    render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({ branch: 'b1', supplier: 'sup-archived' }),
      })
    );
    expect(screen.getByLabelText('Supplier')).toHaveValue('sup-archived');
    expect(
      screen.getByRole('option', { name: 'Selected supplier (not in this list)' })
    ).toBeInTheDocument();
  });

  it('shows the period summary before the marketing and work-pack panels', async () => {
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    const headings = screen.getAllByRole('heading', { level: 2 }).map((item) => item.textContent);
    const summary = headings.indexOf('Selected period at a glance');
    expect(summary).toBeGreaterThan(headings.indexOf('Report filters'));
    expect(summary).toBeLessThan(headings.indexOf('Marketing evidence'));
    expect(summary).toBeLessThan(headings.indexOf('Observed unmet demand'));
  });

  it('opens the expiry board filtered to the drill-through window and branch', async () => {
    branchList.value = [
      { id: 'b1', name: 'Main' },
      { id: 'b2', name: 'North' },
    ];
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b2' }) }));
    const expiryCard = screen.getByRole('heading', { name: 'Expiry value · 60 days' })
      .parentElement as HTMLElement;
    expect(within(expiryCard).getByRole('link', { name: 'Drill through' })).toHaveAttribute(
      'href',
      '/pharmacy/inventory/expiry?within=60&branch=b2'
    );
    expect(screen.getByRole('link', { name: 'Open 30-day expiry board' })).toHaveAttribute(
      'href',
      '/pharmacy/inventory/expiry?within=30&branch=b2'
    );
    cleanup();
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('link', { name: 'Open 90-day expiry board' })).toHaveAttribute(
      'href',
      '/pharmacy/inventory/expiry?within=90'
    );
  });

  it('shows the only branch by name instead of a branch picker', async () => {
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole('combobox', { name: 'Branch' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Main').length).toBeGreaterThan(0);
    const subReports = screen.getByRole('navigation', { name: 'Sub-reports' });
    expect(within(subReports).getByRole('link', { name: 'Replenishment' })).toHaveAttribute(
      'href',
      '/pharmacy/reports/replenishment?branch=b1'
    );
    // The sole branch is drilled to directly.
    expect(screen.getByRole('link', { name: 'Open 30-day expiry board' })).toHaveAttribute(
      'href',
      '/pharmacy/inventory/expiry?within=30&branch=b1'
    );
  });

  it('offers the branch picker when there are several branches', async () => {
    branchList.value = [
      { id: 'b1', name: 'Main' },
      { id: 'b2', name: 'North' },
    ];
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveValue('');
    expect(
      within(screen.getByRole('navigation', { name: 'Sub-reports' })).getByRole('link', {
        name: 'Replenishment',
      })
    ).toHaveAttribute('href', '/pharmacy/reports/replenishment');
  });
});
