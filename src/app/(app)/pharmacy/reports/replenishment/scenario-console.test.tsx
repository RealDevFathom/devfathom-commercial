import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PharmacyReplenishmentReport,
  PharmacyReplenishmentReportInput,
} from '@/lib/pharmacy/replenishment-report';
import type { ReplenishmentDecision } from '@/lib/pharmacy/forecasting';
import { ScenarioConsole } from './scenario-console';

const { search, read } = vi.hoisted(() => ({ search: vi.fn(), read: vi.fn() }));
// Only the existing catalog search and report query are available to this consumer.
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      client: {
        pharmacyMedicine: { search: { query: search } },
        pharmacyReports: { replenishment: { query: read } },
      },
    }),
  },
}));
const props = {
  organizationId: 'o1',
  branches: [
    { id: 'b1', name: 'Main' },
    { id: 'b2', name: 'Second' },
  ],
  financial: true,
  initialBranchId: 'b1',
  invalidInitialBranch: false,
  today: '2026-09-14',
};
function report(input: PharmacyReplenishmentReportInput): PharmacyReplenishmentReport {
  const scope = { organizationId: 'o1', branchId: input.branchId, medicineId: input.medicineId };
  const readAt = '2026-09-14T12:00:00.000Z';
  return {
    scope,
    readAt,
    permissions: { operational: true, financial: true },
    observations: {
      demand: {
        scope,
        period: { startDate: input.historyStartDate, endDateExclusive: input.originDate },
        provenance: {
          kind: 'OBSERVED_TRANSACTIONS',
          readAt,
          reference: 'Completed sale lines and stockout captures',
          historicalVersionsAvailable: false,
          sources: ['completed sales', 'stockout events'],
        },
        consumption: { timeBasis: 'SALE_BUSINESS_DATE', observedCanonicalUnits: null, days: [] },
        days: [
          {
            date: input.historyStartDate,
            timeBasis: 'UTC_DAY',
            state: 'UNKNOWN',
            observedCanonicalUnits: null,
            lineCount: 0,
            stockoutEventCount: 0,
            estimatedDemandUnits: null,
            knownAt: null,
          },
        ],
        coverage: {
          requestedDays: 7,
          businessConsumptionDays: 0,
          utcConsumptionDays: 0,
          observedDemandDays: 0,
          unknownDays: 7,
          censoredDays: 0,
          sourceLineRows: 0,
          sourceStockoutRows: 0,
          qualifyingLineCount: 0,
          excludedLineCount: 0,
          excludedStockoutCount: 0,
          missingBusinessDateLineCount: 0,
          missingCompletedAtLineCount: 0,
          factsAfterReadAtLineCount: 0,
          factsAtOrAfterOriginLineCount: 0,
          businessUtcDateMismatchLineCount: 0,
        },
        missingInputs: ['Full-day availability is missing.'],
        backtestEligibility: { eligible: false, reasons: ['Historical versions are unavailable.'] },
      },
      supply: {
        scope,
        inventorySource: {
          kind: 'OBSERVED_TRANSACTIONS',
          reference: 'Current inventory records',
          asOf: readAt,
        },
        stock: [],
        inbound: [],
        excludedStock: [],
        constraints: { budgetMinor: null, storageLimitUnits: null },
        limitations: ['Inbound arrival may be unknown.'],
      },
      supplyCoverage: {
        status: 'UNKNOWN',
        recordedEligibleLots: 0,
        reason: 'Stock completeness is unverified. Empty reads do not establish zero inventory.',
      },
    },
    forecast: { status: 'INSUFFICIENT_EVIDENCE', result: null },
    backtest: {
      status: 'INELIGIBLE',
      result: null,
      reasons: ['Historical versions are unavailable.'],
    },
    planning: {
      status: input.manualScenario ? 'INSUFFICIENT_STOCK_EVIDENCE' : 'NOT_REQUESTED',
      basis: 'USER_SUPPLIED_ASSUMPTIONS',
      dailyDemandUnits: null,
      decision: null,
    },
    limitations: ['No order, reservation or approval is created.'],
  };
}
function decision(scope: PharmacyReplenishmentReport['scope']): ReplenishmentDecision {
  const source = {
    kind: 'MANUAL_SCENARIO' as const,
    reference: 'Supplied assumptions',
    asOf: '2026-09-14T12:00:00.000Z',
  };
  const period = { startDate: '2026-09-15', endDateExclusive: '2026-09-22' };
  return {
    label: 'CONDITIONAL_SCENARIO',
    inventorySource: source,
    demand: {
      label: 'CONDITIONAL_SCENARIO',
      scope,
      source,
      timeBasis: 'UTC_DAY_START',
      originDate: period.startDate,
      period,
      historyPeriod: { startDate: '2026-09-14', endDateExclusive: '2026-09-15' },
      coverage: {
        observedDays: 1,
        unknownDays: 0,
        closedDays: 0,
        censoredDays: 0,
        excludedFutureOrUnavailableRows: 0,
      },
      days: [],
      assumptions: [],
      unknowns: [],
    },
    money: {
      currency: 'USD',
      scale: 'MINOR_UNITS',
      definition: 'Committed cash excludes historic inventory cost.',
      period,
      scope,
      source,
      coverage: 'SUPPLIED_ORDER_TERMS_ONLY',
    },
    policySource: 'MANUAL_SCENARIO',
    selectedSource: 'MANUAL_SCENARIO',
    approvalRequired: true,
    scenarios: [
      {
        policy: 'PROPOSED',
        order: {
          status: 'UNKNOWN',
          requestedUnits: 20,
          quantityUnits: null,
          committedCashMinor: null,
          reasons: ['Budget is missing.'],
        },
        outcome: null,
        days: [],
        allocations: [],
      },
    ],
    excludedStock: [],
    excludedInbound: [],
    assumptions: ['Constant demand is an assumption.'],
    unknowns: ['Scenario coverage is not empirical performance.'],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-14T12:00:00.000Z'));
  search.mockResolvedValue([
    { id: 'm1', productName: 'Medicine one' },
    { id: 'm2', productName: 'Medicine two' },
  ]);
  read.mockImplementation(async (input: PharmacyReplenishmentReportInput) => report(input));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const edit = (name: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
async function selectMedicine() {
  edit('Find medicine', 'Medicine');
  fireEvent.click(screen.getByRole('button', { name: 'Search medicines' }));
  await screen.findByRole('option', { name: 'Medicine one' });
  edit('Medicine', 'm1');
}
async function loadReport() {
  fireEvent.click(screen.getByRole('button', { name: /^(Read|Retry) replenishment report$/ }));
  await screen.findByRole('heading', { name: 'Observed evidence' });
}
function manualInputs() {
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include a user-supplied scenario' }));
  edit('Scenario currency (three-letter code)', 'USD');
  edit('Assumed daily demand (units)', '5');
  edit('Current policy order (units)', '10');
  edit('Proposed policy order (units)', '20');
  edit('Order pack size (units)', '1');
  edit('Minimum order (units)', '0');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('Replenishment observations and planning', () => {
  it('requires explicit active scope and shows a useful no-branches state', () => {
    const view = render(<ScenarioConsole {...props} initialBranchId="" invalidInitialBranch />);
    expect(screen.getByRole('alert')).toHaveTextContent('requested branch is unavailable');
    expect(screen.getByRole('button', { name: 'Read replenishment report' })).toBeDisabled();
    expect(screen.getByLabelText('Find medicine')).toBeDisabled();
    view.rerender(<ScenarioConsole {...props} branches={[]} />);
    expect(screen.getByRole('heading', { name: 'No reportable branches' })).toBeVisible();
    expect(read).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
  it('reads the exact scope/window/method with no caller authority, timestamps or manual assertion', async () => {
    render(<ScenarioConsole {...props} />);
    await selectMedicine();
    await loadReport();
    expect(search).toHaveBeenCalledWith({ query: 'Medicine', limit: 25 });
    expect(read).toHaveBeenCalledExactlyOnceWith({
      branchId: 'b1',
      medicineId: 'm1',
      historyStartDate: '2026-09-07',
      originDate: '2026-09-14',
      horizonDays: 7,
      method: 'RECENT_MEAN',
    });
    expect(screen.getByText('Main · Medicine one')).toBeVisible();
    expect(screen.getByText(/As of report read: 2026-09-14T12:00:00.000Z/)).toBeVisible();
  });
  it('keeps null consumption and absent stock unknown, forecast insufficient and backtest ineligible', async () => {
    render(<ScenarioConsole {...props} />);
    await selectMedicine();
    await loadReport();
    const consumption = screen
      .getByText('Recorded consumption (business dates)')
      .closest('[data-slot="stat"]')!;
    expect(within(consumption as HTMLElement).getByText('Unknown')).toBeVisible();
    expect(screen.getByText('Forecast: INSUFFICIENT_EVIDENCE')).toBeVisible();
    expect(screen.getByText('Backtest: INELIGIBLE')).toBeVisible();
    expect(screen.getByText('UNKNOWN stock completeness')).toBeVisible();
    expect(screen.getByText(/Available stock quantity: Unknown/)).toBeVisible();
    expect(screen.getByText('Full-day availability is missing.')).toBeVisible();
    expect(screen.getByText(/Supply provenance: OBSERVED_TRANSACTIONS/)).toBeVisible();
  });
  it('separates manual input from observations and preserves nullable unknown order terms', async () => {
    render(<ScenarioConsole {...props} />);
    await selectMedicine();
    manualInputs();
    await loadReport();
    expect(read.mock.calls[0][0].manualScenario).toEqual({
      originDate: '2026-09-15',
      dailyDemandUnits: 5,
      currentQuantityUnits: 10,
      proposedQuantityUnits: 20,
      currency: 'USD',
      orderTerms: {
        packSize: 1,
        minimumOrderUnits: 0,
        unitCostMinor: null,
        budgetMinor: null,
        storageLimitUnits: null,
        arrivalAt: null,
        expiresAt: null,
      },
    });
    expect(screen.getByText(/Basis: USER_SUPPLIED_ASSUMPTIONS/)).toBeVisible();
    expect(screen.getByText('INSUFFICIENT_STOCK_EVIDENCE')).toBeVisible();
    expect(screen.getByText(/Unknown inventory cannot become a zero-stock scenario/)).toBeVisible();
    expect(screen.getByText('Forecast: INSUFFICIENT_EVIDENCE')).toBeVisible();
  });
  it('renders conditional policy outcomes and unknown cash without inventing financial zeros', async () => {
    read.mockImplementation(async (input: PharmacyReplenishmentReportInput) => {
      const result = report(input);
      result.planning = {
        status: 'AVAILABLE',
        basis: 'USER_SUPPLIED_ASSUMPTIONS',
        dailyDemandUnits: 5,
        decision: decision(result.scope),
      };
      return result;
    });
    render(<ScenarioConsole {...props} />);
    await selectMedicine();
    manualInputs();
    await loadReport();
    expect(screen.getByText(/CONDITIONAL_SCENARIO · Assumed daily demand: 5/)).toBeVisible();
    expect(screen.getByText('Committed order cash').nextElementSibling).toHaveTextContent(
      'Unknown'
    );
    expect(screen.getByText(/Outcome unknown/)).toBeVisible();
    expect(screen.getByText('Budget is missing.')).toBeVisible();
    expect(screen.queryByText('USD 0.00')).not.toBeInTheDocument();
  });
  it.each(['local', 'response'])(
    'redacts planning for %s permission even if a decision is present',
    async (permission) => {
      read.mockImplementation(async (input: PharmacyReplenishmentReportInput) => {
        const result = report(input);
        const value = decision(result.scope);
        value.money.currency = 'ZZZ';
        result.planning = {
          status: 'AVAILABLE',
          basis: 'USER_SUPPLIED_ASSUMPTIONS',
          dailyDemandUnits: 99999,
          decision: value,
        };
        if (permission === 'response') result.permissions.financial = false;
        return result;
      });
      render(<ScenarioConsole {...props} financial={permission !== 'local'} />);
      await selectMedicine();
      await loadReport();
      expect(screen.getAllByText('REDACTED').length).toBeGreaterThan(0);
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.queryByText(/ZZZ|99999/)).not.toBeInTheDocument();
      expect(screen.queryByText('Committed order cash')).not.toBeInTheDocument();
    }
  );
  it('keeps numeric fields blank while typing and focuses invalid required input before any query', async () => {
    render(<ScenarioConsole {...props} />);
    await selectMedicine();
    manualInputs();
    edit('Assumed daily demand (units)', '');
    expect(screen.getByLabelText('Assumed daily demand (units)')).toHaveValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Assumed daily demand (units)')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(screen.getByLabelText('Assumed daily demand (units)')).toHaveFocus();
    edit('Assumed daily demand (units)', '0');
    await loadReport();
    expect(read.mock.calls[0][0].manualScenario.dailyDemandUnits).toBe(0);
  });
  it.each([
    ['Planning / forecast horizon (days)', '367'],
    ['Planning / forecast horizon (days)', '1.5'],
    ['History start (UTC)', '2026-01-01'],
    ['History end / forecast origin (exclusive, UTC)', '2026-09-15'],
    ['Scenario origin (future UTC day)', '2026-09-14'],
    ['Scenario origin (future UTC day)', '2026-11-01'],
    ['Assumed daily demand (units)', '9007199254740991'],
    ['Unit cost (integer minor units) (optional)', '-1'],
    ['Scenario currency (three-letter code)', 'usd'],
    ['Assumed arrival (ISO instant, optional)', '2026-09-15T12:00:00'],
    ['Assumed arrival (ISO instant, optional)', '2026-09-14T12:00:00Z'],
  ])('rejects invalid %s = %s without report reads', async (field, value) => {
    render(<ScenarioConsole {...props} />);
    await selectMedicine();
    manualInputs();
    edit(field, value);
    fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByLabelText(field)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Correct the marked inputs');
  });
  it('shows report loading, suppresses private errors, and supports an explicit fresh retry', async () => {
    const pending = deferred<PharmacyReplenishmentReport>();
    read.mockReturnValueOnce(pending.promise);
    render(<ScenarioConsole {...props} />);
    await selectMedicine();
    fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
    expect(screen.getByText(/Reading authorized evidence/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reading replenishment report…' })).toBeDisabled();
    await act(async () => pending.reject(new Error('private database error')));
    expect(screen.getByRole('alert')).toHaveTextContent('could not load');
    expect(screen.queryByText('private database error')).not.toBeInTheDocument();
    await loadReport();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('shows denied report state and clears previous evidence during retry', async () => {
    render(<ScenarioConsole {...props} />);
    await selectMedicine();
    await loadReport();
    read.mockRejectedValueOnce({ data: { code: 'FORBIDDEN' }, message: 'private role' });
    fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Report access denied')
    );
    expect(screen.queryByRole('heading', { name: 'Observed evidence' })).not.toBeInTheDocument();
  });
  it.each(['branch', 'date', 'horizon', 'method', 'medicine', 'assumptions'])(
    'discards pending report when %s changes, including changing back',
    async (field) => {
      const pending = deferred<PharmacyReplenishmentReport>();
      read.mockReturnValueOnce(pending.promise);
      render(<ScenarioConsole {...props} />);
      await selectMedicine();
      fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
      const input = read.mock.calls[0][0];
      if (field === 'branch') {
        edit('Branch', 'b2');
        edit('Branch', 'b1');
      }
      if (field === 'date') {
        edit('History start (UTC)', '2026-09-08');
        edit('History start (UTC)', '2026-09-07');
      }
      if (field === 'horizon') {
        edit('Planning / forecast horizon (days)', '8');
        edit('Planning / forecast horizon (days)', '7');
      }
      if (field === 'method') {
        edit('Forecast method', 'WEEKLY_SEASONAL_NAIVE');
        edit('Forecast method', 'RECENT_MEAN');
      }
      if (field === 'medicine') {
        edit('Medicine', 'm2');
        edit('Medicine', 'm1');
      }
      if (field === 'assumptions') {
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('checkbox'));
      }
      await act(async () => pending.resolve(report(input)));
      expect(screen.queryByRole('heading', { name: 'Observed evidence' })).not.toBeInTheDocument();
      expect(screen.getByText(/Inputs changed. Previous results are hidden/)).toBeVisible();
    }
  );
  it('an older request cannot overwrite a newer completed report', async () => {
    const pending = deferred<PharmacyReplenishmentReport>();
    read.mockReturnValueOnce(pending.promise);
    render(<ScenarioConsole {...props} />);
    await selectMedicine();
    fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
    const input = read.mock.calls[0][0];
    edit('Medicine', 'm2');
    await loadReport();
    await act(async () => pending.resolve(report(input)));
    expect(screen.getByText('Main · Medicine two')).toBeVisible();
    expect(screen.queryByText('Main · Medicine one')).not.toBeInTheDocument();
  });
  it.each(['organizationId', 'branchId', 'medicineId', 'period'])(
    'rejects a mismatched response %s',
    async (key) => {
      read.mockImplementation(async (input: PharmacyReplenishmentReportInput) => {
        const result = report(input);
        if (key === 'period') result.observations.demand.period.startDate = '2020-01-01';
        else result.scope[key as keyof typeof result.scope] = 'foreign';
        return result;
      });
      render(<ScenarioConsole {...props} />);
      await selectMedicine();
      fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not load'));
      expect(screen.queryByRole('heading', { name: 'Observed evidence' })).not.toBeInTheDocument();
    }
  );
  it('discards results when refreshed tenant authority changes', async () => {
    const view = render(<ScenarioConsole {...props} />);
    await selectMedicine();
    await loadReport();
    view.rerender(<ScenarioConsole {...props} organizationId="o2" financial={false} />);
    expect(screen.queryByRole('heading', { name: 'Observed evidence' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Medicine')).toHaveValue('');
    expect(screen.getByText('REDACTED')).toBeVisible();
  });
  it.each(['empty', 'error', 'denied'])(
    'provides useful medicine search %s feedback',
    async (state) => {
      if (state === 'empty') search.mockResolvedValueOnce([]);
      if (state === 'error') search.mockRejectedValueOnce(new Error('private search failure'));
      if (state === 'denied') search.mockRejectedValueOnce({ data: { code: 'UNAUTHORIZED' } });
      render(<ScenarioConsole {...props} />);
      edit('Find medicine', 'missing');
      fireEvent.click(screen.getByRole('button', { name: 'Search medicines' }));
      await screen.findByText(
        state === 'empty'
          ? /No matching medicines/
          : state === 'error'
            ? /Medicine search unavailable/
            : /Medicine search access denied/
      );
      expect(screen.getByRole('button', { name: 'Read replenishment report' })).toBeDisabled();
      expect(screen.queryByText('private search failure')).not.toBeInTheDocument();
    }
  );
  it('drops stale catalog results after search or branch changes', async () => {
    const pending = deferred<MedicineResult[]>();
    search.mockReturnValueOnce(pending.promise);
    render(<ScenarioConsole {...props} />);
    edit('Find medicine', 'Medicine');
    fireEvent.click(screen.getByRole('button', { name: 'Search medicines' }));
    expect(screen.getByText('Searching permitted medicines…')).toBeVisible();
    edit('Find medicine', 'new');
    edit('Branch', 'b2');
    await act(async () => pending.resolve([{ id: 'old', productName: 'Stale medicine' }]));
    expect(screen.queryByRole('option', { name: 'Stale medicine' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Medicine')).toBeDisabled();
  });
});
type MedicineResult = { id: string; productName: string };
