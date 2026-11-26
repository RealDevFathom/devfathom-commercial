import { selectFieldControl } from '@/lib/testing/select-field';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const actor = vi.hoisted(() => ({ id: 'user_1', role: 'ADMIN' }));
const signalStaff = vi.hoisted(() => ({ userId: 'cashier_1' as string | undefined }));
const reportModules = vi.hoisted(() => ({ enabled: ['pharmacy-reports'] }));
const reportBranches = vi.fn(async () => ({ branches: [{ id: 'b1', name: 'Main' }] }));
const expiryError = vi.hoisted(() => ({ value: null as Error | null }));
const expiryEmpty = vi.hoisted(() => ({ value: false }));
const suppliers = vi.hoisted(() => vi.fn());
const demandAggregate = vi.hoisted(() => vi.fn());
const staffingSuggestions = vi.hoisted(() => vi.fn(async () => null));
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
const reportAccess = vi.hoisted(() => ({
  can: vi.fn(async (..._args: unknown[]) => true),
  session: true,
}));
vi.mock('@/lib/abac', () => ({
  can: reportAccess.can,
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn(async () => ({
    db: {},
    requestMeta: { ip: null, userAgent: null },
    organization: { id: 'org-a', currency: 'PKR', timezone: 'Asia/Karachi' },
    entitlements: {
      organizationId: 'org-a',
      enabledModules: reportModules.enabled,
      modules: [{ key: 'pharmacy-reports', name: 'Pharmacy Reports' }],
    },
    session: reportAccess.session ? { user: actor } : null,
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
      staffingSuggestions,
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
        if (expiryEmpty.value) return [];
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
      // Mirrors the reader: pack scans record no supplier, so a supplier filter reads null.
      packAuthenticationFlags: async (input: { supplierId?: string }) =>
        input.supplierId ? null : [],
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

import PharmacyReportsPage from './operations/page';

/** True only when both a Chromium binary and Poppler's pdftotext can run here. Mirrors the
 * browser lookup in tests/helpers/pharmacy-report-print.ts, including Playwright's bundled one. */
function pdfToolsAvailable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/opt/pw-browsers/chromium',
    chromium.executablePath(),
  ];
  const hasChromium = candidates.some((path) => !!path && existsSync(path));
  return hasChromium && spawnSync('pdftotext', ['-v']).error === undefined;
}

describe('pharmacy report catalog filters', () => {
  beforeEach(() => {
    actor.role = 'ADMIN';
    reportAccess.can.mockReset().mockResolvedValue(true);
    reportAccess.session = true;
    signalStaff.userId = 'cashier_1';
    reportModules.enabled = ['pharmacy-reports'];
    reportBranches.mockClear();
    commandCentre.mockClear();
    expiryError.value = null;
    expiryEmpty.value = false;
    suppliers.mockResolvedValue([{ id: 'sup1', name: 'Acme Distribution' }]);
    extraCatalog.reports = [];
    extraCatalog.metrics = [];
  });

  it('DEV-61 puts summary figures before caveats and supporting reports', async () => {
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    const summary = screen.getByRole('heading', { name: 'Selected period at a glance' });
    const sales = within(summary.closest('[data-slot="section-card"]')!).getByText('PKR 100.00');
    const caveat = screen.getByText(/Currency basis: current organization setting/);
    expect(sales.compareDocumentPosition(caveat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const demand = screen.getByRole('heading', { name: 'Observed unmet demand' });
    expect(summary.compareDocumentPosition(demand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('DEV-61 exports CSV that records every active report filter', async () => {
    let blob: Blob | undefined;
    Object.assign(URL, {
      createObjectURL: (value: Blob) => {
        blob = value;
        return 'blob:csv';
      },
      revokeObjectURL: () => {},
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      render(
        await PharmacyReportsPage({
          searchParams: Promise.resolve({
            branch: 'b1',
            from: '2026-11-01',
            to: '2026-11-07',
            supplier: 's-x',
            ingredient: 'ing-9',
            batch: 'batch-3',
          }),
        })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
      const csv = await blob!.text();
      expect(csv).toContain('"Branch","Main"');
      expect(csv).not.toContain('"Branch","b1"');
      expect(csv).toContain('"Supplier","s-x"');
      expect(csv).toContain('"Ingredient ID","ing-9"');
      expect(csv).toContain('"Batch ID","batch-3"');
      expect(csv).toContain('"From","2026-11-01"');
      expect(click).toHaveBeenCalledOnce();
    } finally {
      click.mockRestore();
    }
  });

  it('DEV-61 defaults the only authorized branch and the recent workspace week', async () => {
    reportBranches.mockResolvedValueOnce({ branches: [{ id: 'b1', name: 'Main' }] });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T21:00:00Z'));
    try {
      render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
      expect(selectFieldControl(screen.getByRole('combobox', { name: 'Branch' }))).toHaveValue(
        'b1'
      );
      expect(commandCentre).toHaveBeenCalledWith({
        branchId: 'b1',
        from: '2026-11-11',
        to: '2026-11-17',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('DEV-61 marks the report for print with summary first and print rules in the stylesheet', async () => {
    const { container } = render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({ branch: 'b1', from: '2026-09-01', to: '2026-09-04' }),
      })
    );
    const root = container.querySelector('[data-report-print]');
    expect(root).not.toBeNull();
    const summary = within(root as HTMLElement).getByRole('heading', {
      name: 'Selected period at a glance',
    });
    expect(
      within(summary.closest('[data-slot="section-card"]')!).getByText('PKR 100.00')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toHaveClass('print:hidden');
    expect(screen.getByRole('button', { name: 'Export CSV' })).toHaveClass('print:hidden');
    const css = readFileSync('src/app/globals.css', 'utf8');
    const printBlock = css.slice(css.indexOf('body:has([data-report-print])'));
    expect(printBlock).toContain('color-scheme: light !important');
    expect(printBlock).toContain('[data-report-print]');
  });

  // The Chromium/Poppler regression needs binaries that the main unit-suite lane does not install
  // (QA installs Chromium only later), so it runs where both exist and is skipped with a reason
  // elsewhere; the plain test above keeps the print behaviour covered everywhere.
  const pdfToolsMissing = !pdfToolsAvailable();
  it.skipIf(pdfToolsMissing)(
    'DEV-61 preserves off-screen report sections in Chromium A4 PDFs across the Studio matrix',
    async () => {
      const { verifyReportPrint } =
        await import('../../../../../tests/helpers/pharmacy-report-print');
      const { container } = render(
        await PharmacyReportsPage({
          searchParams: Promise.resolve({ branch: 'b1', from: '2026-09-01', to: '2026-09-04' }),
        })
      );
      await verifyReportPrint(container.innerHTML);
    },
    120_000
  );

  it('DEV-61 prints the loaded report without changing its selected filters', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    try {
      render(
        await PharmacyReportsPage({
          searchParams: Promise.resolve({ branch: 'b1', from: '2026-09-01', to: '2026-09-04' }),
        })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
      expect(print).toHaveBeenCalledOnce();
      expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
      expect(screen.getByLabelText('To')).toHaveValue('2026-09-04');
    } finally {
      print.mockRestore();
    }
  });

  it('DEV-61 does not offer printing for an invalid range or failed report', async () => {
    const first = render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({ from: '2026-09-05', to: '2026-09-01' }),
      })
    );
    expect(screen.queryByRole('button', { name: 'Print / Save as PDF' })).toBeNull();
    first.unmount();
    commandCentre.mockRejectedValueOnce(new Error('Unavailable'));
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    expect(screen.queryByRole('button', { name: 'Print / Save as PDF' })).toBeNull();
  });

  it.each([
    [{ branch: 'b1' }, '/pharmacy/inventory/expiry?within=180&branch=b1'],
    [{}, '/pharmacy/inventory/expiry?within=180'],
  ])(
    'drills expiry value 180 days into the expiry board in the report branch scope (%o)',
    async (searchParams, href) => {
      // This case exercises all-branch drill-through; a sole branch now auto-selects.
      reportBranches.mockResolvedValueOnce({
        branches: [
          { id: 'b1', name: 'Main' },
          { id: 'b2', name: 'Second' },
        ],
      });
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

  it('locks a member without the reports permission before any report read (DEV-35)', async () => {
    actor.role = 'MANAGER';
    reportAccess.can.mockResolvedValue(false);

    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText(/You need the operational reports permission/)).toBeVisible();
    expect(reportAccess.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_1' }),
      'reports:operational',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(reportBranches).not.toHaveBeenCalled();
    expect(commandCentre).not.toHaveBeenCalled();
  });

  it('asks a signed-out visitor to sign in before any report read (DEV-35)', async () => {
    reportAccess.session = false;

    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Sign in again to access pharmacy reports.')).toBeVisible();
    expect(reportAccess.can).not.toHaveBeenCalled();
    expect(reportBranches).not.toHaveBeenCalled();
  });

  it('renders a sales detail section for ?section=sales and not otherwise', async () => {
    render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({ section: 'sales', branch: 'b1' }),
      })
    );
    const detail = screen.getByRole('heading', {
      name: 'Sales and margin for the selected period',
    });
    expect(detail.closest('[id="sales"]')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Back to overview' })).toHaveAttribute(
      'href',
      '/pharmacy/reports?branch=b1'
    );
  });

  it('omits the sales detail section without ?section=sales', async () => {
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({}) }));
    expect(
      screen.queryByRole('heading', { name: 'Sales and margin for the selected period' })
    ).toBeNull();
  });

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
    expect(staffingSuggestions).toHaveBeenCalledWith({
      branchId: 'b1',
      from: '2026-11-09',
      to: '2026-11-15',
      receiptsPerStaffHour: 12,
      minimumStaff: 1,
    });
    expect(screen.getByLabelText('To')).toHaveValue('2026-11-15');
    expect(screen.getByText('Updated 4 Sep 2026, 3:00 PM PKT')).toBeVisible();
    const calculation = screen
      .getByText(/to the start of the day after the last, in PKT\. Finance/)
      .closest('details')!;
    expect(calculation).not.toHaveAttribute('open');
    calculation.open = true;
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
    expect(
      selectFieldControl(
        screen.getByLabelText('Supplier', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('sup1');
    expect(
      selectFieldControl(
        screen.getByLabelText('Branch', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('b1');
    expect(screen.getByRole('option', { hidden: true, name: 'Main' })).toHaveProperty(
      'selected',
      true
    );
    expect(screen.getByRole('option', { hidden: true, name: 'Acme Distribution' })).toHaveProperty(
      'selected',
      true
    );
    expect(screen.getByRole('option', { hidden: true, name: 'All suppliers' })).toHaveValue('');
    expect(screen.getByLabelText('Ingredient ID')).toHaveValue('ing1');
    expect(screen.getByLabelText('Batch ID')).toHaveValue('lot1');
    expect(commandCentre).toHaveBeenCalledWith(
      expect.objectContaining({ supplierId: 'sup1', ingredientId: 'ing1', batchId: 'lot1' })
    );
    // DEV-256: a filter that cannot apply is explained, never shown as unfiltered flags.
    expect(screen.getByText('Pack authentication flags')).toBeVisible();
    expect(screen.getByText(/these flags cannot be filtered by supplier/)).toBeVisible();
    expect(screen.queryByText('No pack authentication flags match these branches.')).toBeNull();
    expect(screen.getByText('Source:').parentElement).toHaveTextContent('sales');
    expect(screen.getByText('Source:').parentElement).not.toHaveTextContent('pharmacy_sales');
    expect(screen.getByText('Access:').parentElement).toHaveTextContent('Financial reports');
    expect(screen.queryByText(/reports:financial/)).not.toBeInTheDocument();
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
    const filter = screen.getByLabelText('Supplier', {
      selector: ':not([data-select-field-native][aria-hidden="true"])',
    });
    expect(filter).toHaveAccessibleName('Supplier');
    expect(filter).toHaveAccessibleDescription(
      'Supplier names could not load. Apply filters again to retry.'
    );
    expect(selectFieldControl(filter)).toHaveValue('sup1');
    expect(
      within(selectFieldControl(filter)).getByRole('option', {
        hidden: true,
        name: 'Selected supplier unavailable',
      })
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
    expect(selectFieldControl(filter)).toHaveValue('');
    expect(filter).toHaveAccessibleDescription(
      'Supplier names could not load. Apply filters again to retry.'
    );
    expect(
      within(selectFieldControl(filter)).getByRole('option', {
        hidden: true,
        name: 'All suppliers',
      })
    ).toHaveProperty('selected', true);
    expect(
      within(selectFieldControl(filter)).queryByRole('option', {
        hidden: true,
        name: 'Selected supplier unavailable',
      })
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

  it.each([
    new Error('private database detail'),
    new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'private database detail' }),
  ])('logs an unexpected expiry failure on the server without exposing it: %s', async (error) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expiryError.value = error;
      render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
      expect(log).toHaveBeenCalledWith('[pharmacy-reports] Expiry advice failed', error);
      expect(screen.getByRole('alert')).toHaveTextContent('Expiry advice could not load.');
      expect(screen.queryByText(/private database detail/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Financial report and owner permissions/)).not.toBeInTheDocument();
    } finally {
      log.mockRestore();
    }
  });

  it('shows an empty expiry result without an error or permission warning', async () => {
    expiryEmpty.value = true;
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    expect(
      screen.getByText('No future-expiry lots with available stock match this scope.')
    ).toBeVisible();
    expect(screen.queryByText(/Expiry advice could not load/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Financial report and owner permissions/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create draft proposal' })).not.toBeInTheDocument();
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

  // DEV-845: observed demand is a manager or owner report; others never see an error for it.
  it.each([{ branch: 'b1' }, {}])(
    'hides observed demand from a reports viewer without the manager capability (%o)',
    async (searchParams) => {
      actor.role = 'EMPLOYEE';
      demandAggregate.mockClear();
      reportAccess.can.mockImplementation(
        async (...args: unknown[]) => args[1] !== 'pharmacy:manage'
      );

      render(await PharmacyReportsPage({ searchParams: Promise.resolve(searchParams) }));

      expect(reportAccess.can).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user_1' }),
        'pharmacy:manage',
        undefined,
        expect.objectContaining({ source: 'TRPC' })
      );
      expect(demandAggregate).not.toHaveBeenCalled();
      expect(screen.queryByRole('heading', { name: 'Observed unmet demand' })).toBeNull();
      expect(screen.queryByText(/Demand unavailable/)).toBeNull();
      expect(screen.queryByText(/Choose one authorized branch to view recorded/)).toBeNull();
    }
  );

  it('hides observed demand when the demand report refuses the viewer', async () => {
    demandAggregate.mockClear();
    demandAggregate.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' })
    );

    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));

    expect(demandAggregate).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'Observed unmet demand' })).toBeNull();
    expect(screen.queryByText(/Demand unavailable/)).toBeNull();
  });

  it('shows observed demand to a manager, and a real failure as an alert', async () => {
    demandAggregate.mockClear();
    demandAggregate.mockRejectedValueOnce(new Error('Database unavailable'));

    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));

    expect(screen.getByRole('heading', { name: 'Observed unmet demand' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/Demand unavailable/);
  });

  it('links signals without staff attribution to the supported audit search filter', async () => {
    signalStaff.userId = undefined;
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    expect(screen.getByRole('link', { name: 'Open related audit trail' })).toHaveAttribute(
      'href',
      '/audit-logs?search=anomaly_1'
    );
  });

  it('shows the anomaly data window on the workspace clock, not the server locale', async () => {
    render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    expect(
      screen.getByText(
        /Window 1 Sep 2026, 5:00 AM PKT–5 Sep 2026, 5:00 AM PKT · source observed 4 Sep 2026, 3:00 PM PKT/
      )
    ).toBeInTheDocument();
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

  describe('KPI review flags and unavailable values (DEV-733)', () => {
    const kpi = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="stat"]')).find(
        (stat) => stat.querySelector('.eyebrow')?.textContent === label
      )!;
    const withMetrics = (metrics: Record<string, number | null>) =>
      commandCentre.mockResolvedValueOnce({
        freshness: { status: 'CURRENT', asOf: '2026-09-04T10:00:00Z', source: 'ledger' },
        metrics: {
          salesMinor: 212_197,
          marginMinor: 2500,
          cashMinor: 6000,
          cashVarianceMinor: 0,
          refundsMinor: 0,
          openStockSignals: 1,
          recommendedOrders: 1,
          expiryValueMinor30: 0,
          expiryValueMinor90: 0,
          ...metrics,
        },
      } as never);

    it('flags abnormal refunds in amber and short cash in red with visible labels', async () => {
      withMetrics({ refundsMinor: 82_797, cashVarianceMinor: -400 });
      render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));

      const refunds = kpi('Refunds');
      expect(refunds).toHaveAttribute('data-flagged', 'true');
      expect(refunds.querySelector('.stat-figure')).toHaveClass('text-warning');
      expect(within(refunds).getByText('Review')).toBeVisible();
      expect(
        within(refunds).getByText(
          'Refunds are 39.02% of sales, at or above the 10.00% review threshold.'
        )
      ).toBeVisible();

      const variance = kpi('Cash variance');
      expect(variance).toHaveAttribute('data-flagged', 'true');
      expect(variance.querySelector('.stat-figure')).toHaveTextContent('PKR 4 short');
      expect(variance.querySelector('.stat-figure')).toHaveClass('text-destructive');
      expect(within(variance).getByText('Review')).toBeVisible();
    });

    it('leaves normal figures unflagged', async () => {
      render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));
      for (const label of ['Refunds', 'Cash variance', 'Sales']) {
        expect(kpi(label)).not.toHaveAttribute('data-flagged');
        expect(kpi(label).querySelector('.stat-figure')).not.toHaveClass('text-warning');
      }
    });

    it('shows a cash variance with no final close as not computed, never 0.00', async () => {
      withMetrics({ cashVarianceMinor: null });
      render(await PharmacyReportsPage({ searchParams: Promise.resolve({ branch: 'b1' }) }));

      const variance = kpi('Cash variance');
      expect(variance.querySelector('.stat-figure')).toHaveTextContent('—');
      expect(variance).not.toHaveTextContent('0.00');
      expect(
        within(variance).getByText('Not computed · no final day close in period')
      ).toBeVisible();
      expect(variance).not.toHaveAttribute('data-flagged');
    });
  });
  it('shows a concise owner period with calculation caveats under a disclosure', async () => {
    render(
      await PharmacyReportsPage({
        searchParams: Promise.resolve({ from: '2026-10-28', to: '2026-11-03', branch: '' }),
      })
    );
    const owner = screen
      .getByRole('heading', { name: 'Selected period at a glance' })
      .closest<HTMLDivElement>('[data-slot="section-card"]')!;
    expect(within(owner).getByText('28 Oct – 3 Nov · All branches')).toBeVisible();
    expect(
      within(owner)
        .getByText(/historical transaction currency is not verified/)
        .closest('details')
    ).not.toBeNull();
    expect(within(owner).getByText('How is this calculated?')).toHaveAttribute(
      'class',
      expect.stringContaining('focus-visible')
    );
    expect(within(owner).queryByText(/All available branches · ledger source/)).toBeNull();
  });
});

it('opens the visual reports without reading the legacy command centre', async () => {
  reportAccess.can.mockResolvedValue(true);
  reportAccess.session = true;
  commandCentre.mockClear();
  const { default: VisualEntry } = await import('./page');
  const element = await VisualEntry({ searchParams: Promise.resolve({}) });
  expect(commandCentre).not.toHaveBeenCalled();
  expect(element).toBeDefined();
});
