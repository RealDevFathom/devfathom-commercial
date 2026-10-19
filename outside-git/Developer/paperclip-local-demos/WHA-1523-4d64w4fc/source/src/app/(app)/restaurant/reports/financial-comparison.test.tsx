import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import type {
  RestaurantFinancialComparison as Report,
  RestaurantFinancialDriver,
} from '@/lib/restaurant/financial-comparison';
import { FinancialComparison } from './financial-comparison';

const keys: RestaurantFinancialDriver[] = [
  'netSales',
  'grossSales',
  'refundTotal',
  'discountTotal',
  'compTotal',
  'cashVariance',
  'cashExpected',
  'cashCounted',
  'taxTotal',
  'serviceChargeTotal',
  'tipTotal',
  'deliveryFeeSales',
  'deliveryFeeRefunds',
  'voidTotal',
];
const drivers = Object.fromEntries(
  keys.map((key) => [
    key,
    {
      definition: `Definition: ${key}`,
      current: null,
      previous: null,
      absoluteChange: null,
      percentageChange: null,
    },
  ])
) as Report['drivers'];
const report: Report = {
  scope: { organizationId: 'org-1', branchIds: ['branch-1'] },
  currency: 'PKR',
  currencyBasis: 'Current organization currency; historical currency is not pinned.',
  moneyUnit: 'DECIMAL_MAJOR',
  periodBasis: 'BUSINESS_DATE',
  periods: {
    current: { from: '2026-09-01', to: '2026-09-07' },
    previous: { from: '2026-08-25', to: '2026-08-31' },
    daysPerPeriod: 7,
  },
  source: 'readPaymentsReport: authoritative daily-close chain tips',
  asOf: '2026-09-08T00:00:00.000Z',
  observedThrough: '2026-09-08T00:00:01.000Z',
  consistency: { snapshotGuaranteed: false, limitation: 'Not a historical snapshot.' },
  coverage: {
    current: {
      status: 'PARTIAL',
      closedDayCount: 2,
      expectedDayCount: 7,
      missingClosedDayCount: 5,
      staleDayCount: 0,
      unprojectedDayCount: 1,
      correctedDayCount: 0,
    },
    previous: {
      status: 'CURRENT',
      closedDayCount: 7,
      expectedDayCount: 7,
      missingClosedDayCount: 0,
      staleDayCount: 0,
      unprojectedDayCount: 0,
      correctedDayCount: 0,
    },
  },
  coverageDefinition:
    'Missing days are not imputed; partial changes are not full-period comparisons.',
  cashCountCoverage: {
    current: {
      status: 'COMPLETE',
      drawerSessionCount: 3,
      missingCountSessionCount: 0,
      unverifiedCloseSessionCount: 0,
      mismatchedCloseDayCount: 0,
      definition:
        'Current counts verified against source closes; missing branch-days stay missing.',
    },
    previous: {
      status: 'COMPLETE',
      drawerSessionCount: 7,
      missingCountSessionCount: 0,
      unverifiedCloseSessionCount: 0,
      mismatchedCloseDayCount: 0,
      definition: 'Previous counts verified against source closes; no historical snapshot.',
    },
  },
  discountRate: {
    unit: 'PERCENT',
    current: '12.35',
    previous: '10.00',
    percentagePointChange: '2.34',
    definition: '100 * settled discounts / settled gross sales, for observed closed branch-days.',
    changeDefinition: 'Current minus previous in percentage points, from unrounded ratios.',
    unavailableReason: { current: null, previous: null },
  },
  changeDefinition: 'Current minus previous; null percentage for zero or unavailable baseline.',
  drivers: {
    ...drivers,
    netSales: {
      definition: 'Settled gross sales less comps and discounts; refunds separate.',
      current: '9007199254740993.01',
      previous: '9007199254740993.00',
      absoluteChange: '0.01',
      percentageChange: '0.00',
    },
    refundTotal: {
      definition: 'Refunds on processing date.',
      current: '12.5',
      previous: '0',
      absoluteChange: '12.5',
      percentageChange: null,
    },
    cashVariance: {
      definition: 'Counted minus expected cash.',
      current: '-0.01',
      previous: '0',
      absoluteChange: '-0.01',
      percentageChange: null,
    },
  },
  refundAdjustedNetSales: null,
  refundAdjustedNetSalesUnavailableReason:
    'Refund allocations are unavailable; refunds stay separate.',
};
const props: ComponentProps<typeof FinancialComparison> = {
  canFinancial: true,
  posEnabled: true,
  failed: false,
  from: '2026-09-01',
  to: '2026-09-07',
  branchLabel: 'Branch One',
  report,
};

describe('Financial comparison contract presentation', () => {
  it('renders exact current/previous amounts and service deltas with currency and definitions', () => {
    render(<FinancialComparison {...props} />);
    const sales = within(screen.getByRole('row', { name: /Settled net sales/ }));
    expect(sales.getByText('PKR 9007199254740993.01')).toBeInTheDocument();
    expect(sales.getByText('PKR 9007199254740993.00')).toBeInTheDocument();
    expect(sales.getByText('PKR 0.01')).toBeInTheDocument();
    expect(sales.getByText('0.00%')).toBeInTheDocument();
    expect(sales.getByText(report.drivers.netSales.definition)).toBeInTheDocument();
    const refunds = within(screen.getByRole('row', { name: /^Refunds / }));
    expect(refunds.getAllByText('PKR 12.50')).toHaveLength(2);
    expect(refunds.getByText('Unavailable — zero or missing baseline')).toBeInTheDocument();
    expect(screen.getAllByText('PKR -0.01')).toHaveLength(2);
    expect(
      screen.getByText(/Current period: 2026-09-01 to 2026-09-07 · Scope: Branch One/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Previous period: 2026-08-25 to 2026-08-31/)).toBeInTheDocument();
    expect(screen.getByText('2/7 branch-days closed')).toBeInTheDocument();
    expect(screen.getByText('7/7 branch-days closed')).toBeInTheDocument();
    expect(screen.getByText(report.coverageDefinition)).toBeInTheDocument();
    expect(screen.getByText(/Paid-in cash is not sales/)).toBeInTheDocument();
    expect(screen.getByText(/As of: 2026-09-08T00:00:00.000Z/)).toBeInTheDocument();
    expect(screen.getByText(report.consistency.limitation)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Financial comparison drivers' })).toHaveAttribute(
      'tabindex',
      '0'
    );
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(15);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it.each([
    [{ canFinancial: false }, /Permission required/],
    [{ posEnabled: false }, /Restaurant POS is not included/],
    [{ failed: true }, /could not load/],
    [{ validationError: 'Choose a valid report period.' }, /Choose a valid report period/],
    [{ report: null }, /No financial comparison is available/],
  ])('hides finance in unavailable states %j', (overrides, message) => {
    render(<FinancialComparison {...props} {...overrides} />);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('PKR 9007199254740993.01')).not.toBeInTheDocument();
  });

  it('shows no-history coverage without replacing nulls with zero', () => {
    render(
      <FinancialComparison
        {...props}
        report={{
          ...report,
          drivers,
          coverage: {
            ...report.coverage,
            previous: {
              ...report.coverage.previous,
              closedDayCount: 0,
              missingClosedDayCount: 7,
              status: 'NO_CLOSED_DAYS',
            },
          },
        }}
      />
    );
    expect(screen.getByText(/Insufficient data/)).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable')).toHaveLength(42);
    expect(screen.queryByText('PKR 0.00')).not.toBeInTheDocument();
  });

  it('preserves supplied deltas without recomputing and formats exponential strings exactly', () => {
    render(
      <FinancialComparison
        {...props}
        report={{
          ...report,
          currency: null,
          drivers: {
            ...report.drivers,
            netSales: { ...report.drivers.netSales, current: '1e+21', absoluteChange: '123.45' },
          },
        }}
      />
    );
    expect(screen.getByText('Currency unknown 1000000000000000000000.00')).toBeInTheDocument();
    expect(screen.getByText('Currency unknown 123.45')).toBeInTheDocument();
  });
});

describe('Delivered comparison contract', () => {
  it('renders supplied percent rates and percentage-point change without arithmetic', () => {
    render(<FinancialComparison {...props} />);
    expect(screen.getByText('12.35%')).toBeVisible();
    expect(screen.getByText('10.00%')).toBeVisible();
    // Rounded display rates differ by 2.35; the service supplies the unrounded-ratio delta.
    expect(screen.getByText('2.34 percentage points')).toBeVisible();
    expect(screen.queryByText('2.35 percentage points')).not.toBeInTheDocument();
    expect(screen.getByText(report.discountRate.definition)).toBeVisible();
    expect(screen.getByText(report.discountRate.changeDefinition)).toBeVisible();
    expect(
      screen.queryByText(/Discount rate is unavailable in this source/)
    ).not.toBeInTheDocument();
  });

  it.each(['current', 'previous'] as const)(
    'preserves an unavailable %s rate and its reason independently of a valid zero rate',
    (period) => {
      render(
        <FinancialComparison
          {...props}
          report={{
            ...report,
            discountRate: {
              ...report.discountRate,
              current: '0.00',
              previous: '0.00',
              [period]: null,
              percentagePointChange: null,
              unavailableReason: {
                current: null,
                previous: null,
                [period]: 'Settled gross sales must be positive to define the discount rate.',
              },
            },
          }}
        />
      );
      const unavailable = screen.getByText(`${period} discount rate`).parentElement!;
      expect(within(unavailable).getByText('Unavailable')).toBeVisible();
      expect(within(unavailable).getByText(/Settled gross sales must be positive/)).toBeVisible();
      expect(screen.getAllByText('0.00%')).toHaveLength(2); // sales delta plus valid zero rate
      expect(
        within(screen.getByText('Change in percentage points').parentElement!).getByText(
          'Unavailable'
        )
      ).toBeVisible();
      expect(screen.queryByText('0.00 percentage points')).not.toBeInTheDocument();
    }
  );

  it.each(['INCOMPLETE', 'NO_CLOSED_DAYS'] as const)(
    'shows %s cash coverage and keeps missing counted cash and variance null',
    (status) => {
      render(
        <FinancialComparison
          {...props}
          report={{
            ...report,
            cashCountCoverage: {
              ...report.cashCountCoverage,
              current: {
                ...report.cashCountCoverage.current,
                status,
                drawerSessionCount: status === 'INCOMPLETE' ? 3 : 0,
                missingCountSessionCount: status === 'INCOMPLETE' ? 1 : 0,
                unverifiedCloseSessionCount: status === 'INCOMPLETE' ? 2 : 0,
                mismatchedCloseDayCount: status === 'INCOMPLETE' ? 1 : 0,
              },
            },
            drivers: {
              ...report.drivers,
              cashCounted: { ...drivers.cashCounted, previous: '0.00' },
              cashVariance: { ...drivers.cashVariance, previous: '0.00' },
            },
          }}
        />
      );
      expect(screen.getByText(status.replaceAll('_', ' '))).toBeVisible();
      expect(screen.getByText('COMPLETE')).toBeVisible();
      expect(screen.getByText(report.cashCountCoverage.current.definition)).toBeVisible();
      expect(screen.getByText(report.cashCountCoverage.previous.definition)).toBeVisible();
      expect(
        screen.getByText(
          status === 'INCOMPLETE'
            ? '3 drawer sessions · 1 missing counts · 2 unverified closes · 1 mismatched close days'
            : '0 drawer sessions · 0 missing counts · 0 unverified closes · 0 mismatched close days'
        )
      ).toBeVisible();
      for (const name of [/^Counted cash /, /^Cash variance /]) {
        const row = within(screen.getByRole('row', { name }));
        expect(row.getAllByText('Unavailable')).toHaveLength(2);
        expect(row.getByText('PKR 0.00')).toBeVisible();
        expect(row.getByText('Unavailable — zero or missing baseline')).toBeVisible();
      }
    }
  );
});
