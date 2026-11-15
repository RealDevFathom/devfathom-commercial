import { render, screen, within } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const actor = vi.hoisted(() => ({ role: 'ADMIN' }));
const signalStaff = vi.hoisted(() => ({ userId: 'cashier_1' as string | undefined }));
const reportModules = vi.hoisted(() => ({ enabled: ['pharmacy-reports'] }));
const reportBranches = vi.fn(async () => ({ branches: [{ id: 'b1', name: 'Main' }] }));
const expiryError = vi.hoisted(() => ({ value: null as Error | null }));
const suppliers = vi.hoisted(() => vi.fn());
const demandAggregate = vi.hoisted(() => vi.fn());
const extraCatalog = vi.hoisted(() => ({
  reports: [] as Array<{ key: string; label: string; metrics: string[]; filters: string[] }>,
  metrics: [] as Array<Record<string, string | null>>,
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
    organization: { id: 'org-a', currency: 'PKR', timezone: 'Asia/Karachi' },
    entitlements: {
      organizationId: 'org-a',
      enabledModules: reportModules.enabled,
      modules: [{ key: 'pharmacy-reports', name: 'Pharmacy Reports' }],
    },
    session: { user: actor },
  })),
}));
vi.mock('@/server/routers/pharmacy-sales', () => ({
  pharmacySalesRouter: {
    createCaller: () => ({
      demandAggregate: demandAggregate.mockImplementation(
        async ({ from, to }: { from: Date; to: Date }) => ({
          label: 'Estimate',
          method: 'Explicit POS-10 events grouped by requested item and cause',
          window: { from, to },
          exclusions: ['searches without an explicit event', 'abandoned carts'],
          confidence: 'observed-events-only',
          rows: [],
        })
      ),
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
      branches: reportBranches,
      suppliers,
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
      expiryAdvice: async () => {
        if (expiryError.value) throw expiryError.value;
        return [
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
        ];
      },
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
          ...extraCatalog.reports,
        ],
        metrics: [
          ...extraCatalog.metrics,
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

import PharmacyReportsPage from './page';

describe('pharmacy report catalog filters', () => {
  beforeEach(() => {
    actor.role = 'ADMIN';
    signalStaff.userId = 'cashier_1';
    reportModules.enabled = ['pharmacy-reports'];
    reportBranches.mockClear();
    commandCentre.mockClear();
    expiryError.value = null;
    suppliers.mockResolvedValue([{ id: 'sup1', name: 'Acme Distribution' }]);
    extraCatalog.reports = [];
    extraCatalog.metrics = [];
  });

  it.each([
    [{ branch: 'b1' }, '/pharmacy/inventory/expiry?within=180&branch=b1'],
    [{}, '/pharmacy/inventory/expiry?within=180'],
  ])(
    'drills expiry value 180 days into the expiry board in the report branch scope (%o)',
    async (searchParams, href) => {
      extraCatalog.reports = [
        {
          key: 'stock-expiry',
          label: 'Stock and expiry',
          metrics: ['expiryValueMinor180'],
          filters: ['branch'],
        },
      ];
      extraCatalog.metrics = [
        {
          key: 'expiryValueMinor180',
          label: 'Expiry value · 180 days',
          definition: 'Available stock expiring within 180 days.',
          source: 'pharmacy_stock_balances',
          scope: 'selected branches at read time',
          permission: 'reports:operational',
          drillThrough: '/pharmacy/inventory/expiry?within=180',
        },
      ];

      render(await PharmacyReportsPage({ searchParams: Promise.resolve(searchParams) }));

      const card = screen.getByRole('heading', { name: 'Expiry value · 180 days' }).parentElement!;
      expect(within(card).getByRole('link', { name: 'Drill through' })).toHaveAttribute(
        'href',
        href
      );
    }
  );

  it('names the missing reports capability and who can grant it', async () => {
    actor.role = 'MEMBER';
    reportBranches.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission for this action.' })
    );

    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText(/You need the operational reports permission/)).toHaveTextContent(
      'Ask your workspace administrator to grant it.'
    );
    expect(commandCentre).not.toHaveBeenCalled();
  });

  it.each([
    'The Pharmacy Reports module is not enabled for this organization.',
    'Pharmacy reports are not licensed.',
  ])('names the missing reports module for an authorized administrator (%s)', async (message) => {
    reportModules.enabled = [];
    reportBranches.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN', message }));

    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText(/Pharmacy Reports module is not enabled/)).toHaveTextContent(
      'Ask your workspace administrator to enable it.'
    );
    expect(screen.queryByText(/You need the operational reports permission/)).toBeNull();
    expect(commandCentre).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Database unavailable'),
    new TRPCError({
      code: 'FORBIDDEN',
      message: 'Change your temporary password before continuing.',
    }),
  ])('does not describe an unrelated report failure as missing access (%s)', async (error) => {
    reportModules.enabled = [];
    reportBranches.mockRejectedValueOnce(error);

    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText(/Reports could not be loaded. Try again/)).toBeVisible();
    expect(screen.queryByText(/operational reports permission|Pharmacy Reports module/)).toBeNull();
    expect(screen.queryByText('Database unavailable')).toBeNull();
    expect(commandCentre).not.toHaveBeenCalled();
  });

  it('asks an unauthenticated report viewer to sign in again', async () => {
    reportBranches.mockRejectedValueOnce(new TRPCError({ code: 'UNAUTHORIZED' }));

    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Sign in again to access pharmacy reports.')).toBeVisible();
    expect(commandCentre).not.toHaveBeenCalled();
  });

  it('defaults the period to the Karachi business day after midnight PKT, not the UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 01:30 PKT on 15 November is still 14 November in UTC.
    vi.setSystemTime(new Date('2026-11-14T20:30:00.000Z'));
    try {
      render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    } finally {
      vi.useRealTimers();
    }
    expect(commandCentre).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-11-09', to: '2026-11-15' })
    );
    // Demand logged at 00:00–04:59 PKT on the 9th belongs to the period: bound it on the Karachi clock.
    expect(demandAggregate).toHaveBeenCalledWith({
      branchId: 'b1',
      from: new Date('2026-11-08T19:00:00.000Z'),
      to: new Date('2026-11-15T19:00:00.000Z'),
    });
    expect(screen.getByLabelText('To')).toHaveValue('2026-11-15');
    expect(screen.getByText('As of 4 Sep 2026, 3:00 PM PKT')).toBeVisible();
    expect(
      screen.getByText(/to the start of the day after the last, in PKT\. Finance/)
    ).toBeVisible();
    expect(screen.queryByText(/UTC posting dates/)).toBeNull();
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
    expect(screen.getByLabelText('Supplier')).toHaveValue('sup1');
    expect(screen.getByLabelText('Branch')).toHaveValue('b1');
    expect(screen.getByRole('option', { name: 'Main' })).toHaveProperty('selected', true);
    expect(screen.getByRole('option', { name: 'Acme Distribution' })).toHaveProperty(
      'selected',
      true
    );
    expect(screen.getByRole('option', { name: 'All suppliers' })).toHaveValue('');
    expect(screen.getByLabelText('Ingredient ID')).toHaveValue('ing1');
    expect(screen.getByLabelText('Batch ID')).toHaveValue('lot1');
    expect(commandCentre).toHaveBeenCalledWith(
      expect.objectContaining({ supplierId: 'sup1', ingredientId: 'ing1', batchId: 'lot1' })
    );
    expect(screen.getByText('Source:').parentElement).toHaveTextContent('pharmacy_sales');
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

  it('preserves supplier filtering without exposing raw IDs when names cannot load', async () => {
    suppliers.mockRejectedValue(new Error('private database detail'));
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ supplier: 'sup1' }) }));
    const filter = screen.getByLabelText('Supplier');
    expect(filter).toHaveAccessibleName('Supplier');
    expect(filter).toHaveAccessibleDescription(
      'Supplier names could not load. Apply filters again to retry.'
    );
    expect(filter).toHaveValue('sup1');
    expect(
      within(filter).getByRole('option', { name: 'Selected supplier unavailable' })
    ).toHaveProperty('selected', true);
    expect(
      screen.getByText('Supplier names could not load. Apply filters again to retry.')
    ).toBeVisible();
    expect(screen.queryByText('sup1')).not.toBeInTheDocument();
    expect(screen.queryByText('private database detail')).not.toBeInTheDocument();
  });

  it('keeps the supplier filter named and described when lookup fails without a selection', async () => {
    suppliers.mockRejectedValue(new Error('private database detail'));
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
    const filter = screen.getByRole('combobox', { name: /^Supplier$/ });
    expect(filter).toHaveValue('');
    expect(filter).toHaveAccessibleDescription(
      'Supplier names could not load. Apply filters again to retry.'
    );
    expect(within(filter).getByRole('option', { name: 'All suppliers' })).toHaveProperty(
      'selected',
      true
    );
    expect(
      within(filter).queryByRole('option', { name: 'Selected supplier unavailable' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('private database detail')).not.toBeInTheDocument();
  });

  it('explains expiry loading failures without presenting them as permission restrictions', async () => {
    expiryError.value = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'private detail' });
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Expiry advice could not load. Apply the filters again to retry. No stock or supplier-return data was changed.'
    );
    expect(screen.queryByText(/Financial report and owner permissions/)).not.toBeInTheDocument();
    expect(screen.queryByText('private detail')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create draft proposal' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply filters' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Selected period at a glance' })).toBeVisible();
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)(
    'keeps %s expiry access restrictions separate from loading failures',
    async (code) => {
      expiryError.value = new TRPCError({ code });
      render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
      expect(screen.getByText(/Financial report and owner permissions/)).toBeVisible();
      expect(screen.queryByText(/Expiry advice could not load/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Create draft proposal' })
      ).not.toBeInTheDocument();
    }
  );

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
});
