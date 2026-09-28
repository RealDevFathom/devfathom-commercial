import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import type { readFoodCostReport } from '@/lib/restaurant/reports';

const nextLink = vi.hoisted(() => vi.fn());
const reportMocks = vi.hoisted(() => ({
  can: vi.fn(),
  context: vi.fn(),
  payments: vi.fn(),
  financialComparison: vi.fn(),
  overview: vi.fn(),
  branches: vi.fn(),
  foodCost: vi.fn(),
  dishProfitability: vi.fn(),
  stockLocations: vi.fn(),
  inventory: vi.fn(),
  wastage: vi.fn(),
  stockMovements: vi.fn(),
  profitabilityTabs: vi.fn(),
  hasModule: vi.fn((modules: string[], name: string) => modules.includes(name)),
}));

vi.mock('next/link', () => ({ default: nextLink }));
vi.mock('@/lib/abac', () => ({ can: reportMocks.can, subjectFromSession: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: reportMocks.context }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: reportMocks.hasModule,
}));
vi.mock('@/server/routers/restaurant-reports', () => ({
  restaurantReportsRouter: { createCaller: () => reportMocks },
}));
vi.mock('./profitability-report-tabs', async (importOriginal) => {
  const original = await importOriginal<typeof import('./profitability-report-tabs')>();
  return {
    ...original,
    ProfitabilityReportTabs: (props: ComponentProps<typeof original.ProfitabilityReportTabs>) => {
      reportMocks.profitabilityTabs(props);
      return <original.ProfitabilityReportTabs {...props} />;
    },
  };
});

import { ExportLink } from './export-link';
import RestaurantReportsPage from './page';

async function renderPage(query: Record<string, string | undefined> = {}) {
  const page = RestaurantReportsPage({
    searchParams: Promise.resolve({
      branch: 'branch-1',
      from: '2026-09-01',
      to: '2026-09-07',
      stockLocation: undefined,
      ...query,
    }),
  });
  const child = page.props.children as ReactElement<
    Record<string, unknown>,
    (props: Record<string, unknown>) => Promise<ReactNode>
  >;
  return render(await child.type(child.props));
}

describe('Restaurant financial report integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reportMocks.context.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      db: {},
      requestMeta: {},
      entitlements: ['restaurant-pos'],
    });
    reportMocks.can.mockImplementation(async (_subject, action) =>
      ['reports:financial', 'reports:operational'].includes(action)
    );
    reportMocks.branches.mockResolvedValue({
      branches: [{ id: 'branch-1', name: 'Branch One' }],
      canAllBranches: false,
    });
    reportMocks.payments.mockResolvedValue(null);
    reportMocks.financialComparison.mockResolvedValue(null);
    reportMocks.overview.mockResolvedValue(null);
  });

  it('exposes a meaningful Suspense loading state', () => {
    const page = RestaurantReportsPage({
      searchParams: Promise.resolve({
        branch: undefined,
        from: undefined,
        to: undefined,
        stockLocation: undefined,
      }),
    });
    render(page.props.fallback);
    expect(screen.getByRole('status')).toHaveTextContent('Loading reports and authorized filters');
  });

  it('uses the existing authorized branch and date filters exactly', async () => {
    await renderPage({ branch: 'unauthorized-branch' });
    expect(reportMocks.payments).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-1',
      from: '2026-09-01',
      to: '2026-09-07',
    });
    expect(reportMocks.financialComparison).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-1',
      from: '2026-09-01',
      to: '2026-09-07',
    });
    expect(screen.getByRole('heading', { name: 'Financial comparison' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply filters' })).toHaveAttribute('type', 'submit');
    expect(screen.getByLabelText('From date')).toHaveValue('2026-09-01');
  });

  it('allows all branches only when the server authorizes that scope', async () => {
    reportMocks.branches.mockResolvedValue({
      branches: [{ id: 'branch-1', name: 'Branch One' }],
      canAllBranches: true,
    });
    await renderPage({ branch: 'all' });
    expect(reportMocks.financialComparison).toHaveBeenCalledExactlyOnceWith({
      from: '2026-09-01',
      to: '2026-09-07',
    });
  });

  it('bounds comparison to 45 days while preserving existing reports up to 90 days', async () => {
    await renderPage({ from: '2026-08-01', to: '2026-09-15' });
    expect(reportMocks.financialComparison).not.toHaveBeenCalled();
    expect(reportMocks.payments).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-1',
      from: '2026-08-01',
      to: '2026-09-15',
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Financial comparison is limited to 45 days per period'
    );
  });

  it('presents comparison reader failure with a filter retry action', async () => {
    reportMocks.financialComparison.mockRejectedValueOnce(new Error('reader unavailable'));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Financial data could not load. Apply the filters again to retry.'
    );
  });

  it('does not read financial data for operational-only users', async () => {
    reportMocks.can.mockImplementation(
      async (_subject, action) => action === 'reports:operational'
    );
    await renderPage();
    expect(reportMocks.payments).not.toHaveBeenCalled();
    expect(reportMocks.financialComparison).not.toHaveBeenCalled();
    expect(
      screen.getByText('Permission required: reports:financial is required.')
    ).toBeInTheDocument();
  });

  it('does not read payments when POS is unavailable', async () => {
    reportMocks.context.mockResolvedValue({
      session: { user: {} },
      db: {},
      requestMeta: {},
      entitlements: [],
    });
    await renderPage();
    expect(reportMocks.payments).not.toHaveBeenCalled();
    expect(reportMocks.financialComparison).not.toHaveBeenCalled();
  });

  it.each([
    { from: '2026-09-08', to: '2026-09-01' },
    { from: '2026-02-30' },
    { from: '2026-01-01', to: '2026-09-01' },
  ])('rejects invalid dates before report reads: %j', async (query) => {
    await renderPage(query);
    expect(reportMocks.payments).not.toHaveBeenCalled();
    expect(reportMocks.overview).not.toHaveBeenCalled();
    expect(reportMocks.financialComparison).not.toHaveBeenCalled();
    expect(screen.getByLabelText('From date')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('To date')).toHaveAttribute(
      'aria-describedby',
      'report-date-error'
    );
  });
});

describe('Profitability diagnostics caller', () => {
  const modules = ['restaurant-pos', 'restaurant-menu', 'restaurant-inventory'];
  const foodCost: Awaited<ReturnType<typeof readFoodCostReport>> = {
    range: { branchIds: ['branch-1'], from: '2026-09-01', to: '2026-09-07' },
    totals: {
      netSales: '4.04',
      costedNetSales: '1.01',
      uncostedNetSales: '3.03',
      theoreticalCost: '2.02',
      foodCostPercent: '200',
      grossMargin: '-1.01',
    },
    products: [
      {
        productId: 'dish',
        productName: 'Dish A',
        categoryId: null,
        categoryName: 'Food',
        quantity: '2',
        netSales: '1.01',
        theoreticalCost: '2.02',
        foodCostPercent: '200',
        grossMargin: '-1.01',
        marginPerItem: '-0.51',
      },
    ],
    uncostedProducts: [
      {
        productId: 'gap',
        productName: 'Dish B',
        categoryName: 'Food',
        branchNames: 'Branch One',
        quantity: '1',
        netSales: '3.03',
        reason: 'NO_RECIPE',
        missingIngredientCount: 0,
      },
    ],
    branches: [],
    categories: [],
    truncated: true,
  };
  const context = (entitlements = modules) => ({
    session: { user: { id: 'user-1' } },
    db: {},
    requestMeta: {},
    entitlements,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    reportMocks.context.mockResolvedValue(context());
    reportMocks.can.mockImplementation(async (_subject, action) =>
      ['reports:financial', 'reports:operational'].includes(action)
    );
    reportMocks.branches.mockResolvedValue({
      branches: [{ id: 'branch-1', name: 'Branch One' }],
      canAllBranches: false,
    });
    for (const reader of [
      reportMocks.payments,
      reportMocks.financialComparison,
      reportMocks.overview,
      reportMocks.dishProfitability,
      reportMocks.inventory,
      reportMocks.wastage,
      reportMocks.stockMovements,
    ]) {
      reader.mockResolvedValue(null);
    }
    reportMocks.stockLocations.mockResolvedValue([]);
    reportMocks.foodCost.mockResolvedValue(foodCost);
  });

  it.each([false, true])(
    'passes the authorized serialized food-cost result once with AI disabled (all branches: %s)',
    async (all) => {
      reportMocks.branches.mockResolvedValue({
        branches: [{ id: 'branch-1', name: 'Branch One' }],
        canAllBranches: all,
      });
      await renderPage({ branch: all ? 'all' : 'unauthorized-branch' });
      expect(reportMocks.foodCost).toHaveBeenCalledExactlyOnceWith({
        ...(all ? {} : { branchId: 'branch-1' }),
        from: '2026-09-01',
        to: '2026-09-07',
      });
      const diagnostics = reportMocks.profitabilityTabs.mock.lastCall![0].diagnostics;
      expect(diagnostics).toEqual({
        status: 'ready',
        report: {
          range: foodCost.range,
          products: foodCost.products,
          uncostedProducts: foodCost.uncostedProducts,
          truncated: true,
        },
        currency: null,
        scopeLabel: all ? 'All active authorized branches' : 'Branch One',
        recipeCostFreshness: null,
      });
      expect(diagnostics.report.products).toBe(foodCost.products);
      expect(diagnostics.report.uncostedProducts).toBe(foodCost.uncostedProducts);
      expect(JSON.parse(JSON.stringify(diagnostics))).toEqual(diagnostics);
      expect(screen.getByRole('heading', { name: 'Recipe review priorities' })).toBeVisible();
      expect(screen.getByText(/Recipe-cost freshness unavailable/)).toBeVisible();
      expect(screen.getByText(/Currency unknown · Business dates/)).toBeVisible();
      expect(reportMocks.can.mock.calls.map((call) => call[1])).toEqual([
        'reports:operational',
        'reports:financial',
        'workforce:rates',
        'catering:read',
      ]);
      expect(
        reportMocks.hasModule.mock.calls.some((call) => /assistant|ask-fathom/i.test(call[1]))
      ).toBe(false);
    }
  );

  it('omits diagnostics and the food-cost read when financial permission is denied', async () => {
    reportMocks.can.mockImplementation(
      async (_subject, action) => action === 'reports:operational'
    );
    await renderPage();
    expect(reportMocks.foodCost).not.toHaveBeenCalled();
    expect(reportMocks.profitabilityTabs.mock.lastCall![0].diagnostics).toBeUndefined();
    expect(screen.queryByText('Recipe review priorities')).not.toBeInTheDocument();
    expect(screen.getAllByText('reports:financial is required.').length).toBeGreaterThan(0);
    expect(reportMocks.overview).toHaveBeenCalledTimes(1);
  });

  it.each(modules)('omits diagnostics and the food-cost read without %s', async (missing) => {
    reportMocks.context.mockResolvedValue(context(modules.filter((module) => module !== missing)));
    await renderPage();
    expect(reportMocks.foodCost).not.toHaveBeenCalled();
    expect(reportMocks.profitabilityTabs.mock.lastCall![0].diagnostics).toBeUndefined();
    expect(screen.queryByText('Recipe review priorities')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Restaurant POS, Menu and Inventory are required for theoretical food costing/
      )
    ).toBeVisible();
  });

  it('preserves the existing error notice and omits diagnostics when food cost fails', async () => {
    reportMocks.foodCost.mockRejectedValueOnce(new Error('reader unavailable'));
    await renderPage();
    expect(reportMocks.foodCost).toHaveBeenCalledTimes(1);
    expect(reportMocks.profitabilityTabs.mock.lastCall![0].diagnostics).toBeUndefined();
    expect(screen.getByText(/Food-cost data could not be loaded/)).toBeVisible();
    expect(screen.queryByText('Recipe review priorities')).not.toBeInTheDocument();
  });

  it('does not read or expose diagnostics for invalid report dates', async () => {
    await renderPage({ from: '2026-02-30' });
    expect(reportMocks.foodCost).not.toHaveBeenCalled();
    expect(reportMocks.profitabilityTabs.mock.lastCall![0].diagnostics).toBeUndefined();
    expect(screen.getByLabelText('From date')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps diagnostics usable with unknown currency when comparison fails', async () => {
    reportMocks.financialComparison.mockRejectedValueOnce(new Error('comparison unavailable'));
    await renderPage();
    expect(reportMocks.profitabilityTabs.mock.lastCall![0].diagnostics.currency).toBeNull();
    expect(screen.getByRole('heading', { name: 'Recipe review priorities' })).toBeVisible();
    expect(reportMocks.foodCost).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing 90-day food-cost scope independent of the comparison limit', async () => {
    const range = { ...foodCost.range, from: '2026-08-01', to: '2026-09-15' };
    reportMocks.foodCost.mockResolvedValue({ ...foodCost, range });
    await renderPage({ from: range.from, to: range.to });
    expect(reportMocks.financialComparison).not.toHaveBeenCalled();
    expect(reportMocks.foodCost).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-1',
      from: range.from,
      to: range.to,
    });
    expect(reportMocks.profitabilityTabs.mock.lastCall![0].diagnostics.report.range).toEqual(range);
    expect(screen.getByRole('heading', { name: 'Recipe review priorities' })).toBeVisible();
  });
});

describe('Restaurant reports CSV downloads', () => {
  it('renders exact native download links without invoking Next Link prefetch navigation', () => {
    const sections = [
      'overview',
      'payments',
      'food-cost',
      'dish-profitability',
      'catering',
      'inventory',
      'purchasing',
      'workforce',
      'sop',
    ] as const;

    render(
      <>
        {sections.map((section) => (
          <ExportLink
            key={section}
            section={section}
            branch="branch-1"
            from="2026-08-01"
            to="2026-08-30"
          />
        ))}
      </>
    );

    expect(nextLink).not.toHaveBeenCalled();
    const links = screen.getAllByRole('link', { name: 'Export CSV' });
    expect(links).toHaveLength(sections.length);
    sections.forEach((section, index) => {
      expect(links[index]).toHaveAttribute('download');
      expect(links[index]).toHaveAttribute(
        'href',
        `/api/restaurant/reports/export?section=${section}&branch=branch-1&from=2026-08-01&to=2026-08-30`
      );
    });
  });
});
