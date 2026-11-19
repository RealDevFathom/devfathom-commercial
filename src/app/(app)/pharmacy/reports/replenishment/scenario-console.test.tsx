import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  replenishment: vi.fn(),
}));
const utils = vi.hoisted(() => ({
  client: {
    pharmacyMedicine: { search: { query: mocks.search } },
    pharmacyReports: { replenishment: { query: mocks.replenishment } },
  },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => utils,
  },
}));

// The seasonal calendar panel has its own tests and tRPC hooks.
vi.mock('./seasonal-calendar-panel', () => ({ SeasonalCalendarPanel: () => null }));

import { ScenarioConsole } from './scenario-console';

const props = {
  organizationId: 'org-1',
  branches: [{ id: 'branch-1', name: 'Central' }],
  financial: false,
  initialBranchId: 'branch-1',
  invalidInitialBranch: false,
  today: '2026-11-03',
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.search.mockReset();
  mocks.replenishment.mockReset();
  mocks.search.mockResolvedValue([
    { id: 'medicine-1', productName: 'Paracetamol 500 mg' },
    { id: 'medicine-2', productName: 'Paracetamol syrup' },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('replenishment medicine picker', () => {
  it('searches while the user types and selects directly from the result list', async () => {
    render(<ScenarioConsole {...props} />);

    const picker = screen.getByRole('combobox', { name: 'Find medicine' });
    fireEvent.change(picker, { target: { value: 'para' } });
    expect(mocks.search).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mocks.search).toHaveBeenCalledExactlyOnceWith(
      { query: 'para', limit: 25 },
      { signal: expect.anything() }
    );
    const results = screen.getByRole('listbox', { name: 'Medicine results' });
    fireEvent.click(within(results).getByRole('option', { name: 'Paracetamol 500 mg' }));

    expect(picker).toHaveValue('Paracetamol 500 mg');
    expect(screen.getByText('Selected Paracetamol 500 mg.')).toBeVisible();
    expect(screen.queryByRole('listbox', { name: 'Medicine results' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search medicines' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Medicine' })).not.toBeInTheDocument();
  });

  it('debounces continued typing so only the latest query is sent', async () => {
    render(<ScenarioConsole {...props} />);
    const picker = screen.getByRole('combobox', { name: 'Find medicine' });

    fireEvent.change(picker, { target: { value: 'par' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.change(picker, { target: { value: 'parac' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mocks.search).toHaveBeenCalledExactlyOnceWith(
      { query: 'parac', limit: 25 },
      { signal: expect.anything() }
    );
  });
});

async function typeAndSearch(text = 'para') {
  const input = screen.getByRole('combobox', { name: 'Find medicine' });
  input.focus();
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  return input;
}
it('selects with arrow keys and Enter while focus stays in the only medicine input', async () => {
  render(<ScenarioConsole {...props} />);
  const input = await typeAndSearch();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  const first = screen.getByRole('option', { name: 'Paracetamol 500 mg' });
  expect(first).toHaveAttribute('aria-selected', 'true');
  expect(input).toHaveAttribute('aria-activedescendant', first.id);
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  const second = screen.getByRole('option', { name: 'Paracetamol syrup' });
  expect(second).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input).toHaveValue('Paracetamol syrup');
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('button', { name: 'Read replenishment report' })).toBeEnabled();
  mocks.replenishment.mockRejectedValueOnce(new Error('Unavailable'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
    await Promise.resolve();
  });
  expect(mocks.replenishment).toHaveBeenCalledWith(
    expect.objectContaining({ branchId: 'branch-1', medicineId: 'medicine-2', horizonDays: 7 })
  );
});
it('supports reverse navigation, Home/End and IME without prematurely selecting', async () => {
  render(<ScenarioConsole {...props} />);
  const input = await typeAndSearch();
  fireEvent.keyDown(input, { key: 'ArrowUp' });
  expect(screen.getByRole('option', { name: 'Paracetamol syrup' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  fireEvent.keyDown(input, { key: 'Home' });
  expect(screen.getByRole('option', { name: 'Paracetamol 500 mg' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  fireEvent.keyDown(input, { key: 'End' });
  expect(screen.getByRole('option', { name: 'Paracetamol syrup' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(screen.getByRole('listbox')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Read replenishment report' })).toBeDisabled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input).toHaveValue('Paracetamol syrup');
});
it('closes on Escape or blur and reopens without committing a hidden option', async () => {
  render(<ScenarioConsole {...props} />);
  const input = await typeAndSearch();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute('aria-activedescendant');
  expect(input).toHaveValue('para');
  expect(screen.getByRole('button', { name: 'Read replenishment report' })).toBeDisabled();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(screen.getByRole('listbox')).toBeVisible();
  fireEvent.blur(input, { relatedTarget: screen.getByLabelText('History start') });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  fireEvent.focus(input);
  expect(screen.getByRole('listbox')).toBeVisible();
  fireEvent.keyDown(input, { key: 'Tab' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});
it('cancels the prior request and rejects late results when the query changes', async () => {
  let resolveOld!: (value: Array<{ id: string; productName: string }>) => void;
  mocks.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      })
  );
  render(<ScenarioConsole {...props} />);
  const input = await typeAndSearch('old');
  const signal = mocks.search.mock.calls[0]![1].signal as AbortSignal;
  fireEvent.change(input, { target: { value: 'new' } });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  await act(async () => resolveOld([{ id: 'stale', productName: 'Old private result' }]));
  expect(screen.queryByRole('option', { name: 'Old private result' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2);
});
it('keeps a late response closed after Escape and clears selection on edits', async () => {
  let resolve!: (value: Array<{ id: string; productName: string }>) => void;
  mocks.search.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  render(<ScenarioConsole {...props} />);
  const input = await typeAndSearch();
  fireEvent.keyDown(input, { key: 'Escape' });
  await act(async () => resolve([{ id: 'medicine-1', productName: 'Paracetamol 500 mg' }]));
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input).toHaveValue('Paracetamol 500 mg');
  fireEvent.change(input, { target: { value: '' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(screen.queryByText(/^Selected/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Read replenishment report' })).toBeDisabled();
  expect(mocks.search).toHaveBeenCalledOnce();
});
it('aborts on organization/scope remount and never shows results from the previous actor scope', async () => {
  let resolve!: (value: Array<{ id: string; productName: string }>) => void;
  mocks.search.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const view = render(<ScenarioConsole {...props} />);
  await typeAndSearch();
  const signal = mocks.search.mock.calls[0]![1].signal as AbortSignal;
  view.rerender(<ScenarioConsole {...props} organizationId="other-org" />);
  expect(signal.aborted).toBe(true);
  await act(async () => resolve([{ id: 'old', productName: 'Previous organization result' }]));
  expect(screen.getByRole('combobox', { name: 'Find medicine' })).toHaveValue('');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(screen.queryByText('Previous organization result')).not.toBeInTheDocument();
  expect(mocks.replenishment).not.toHaveBeenCalled();
});
it.each(['FORBIDDEN', 'INTERNAL_SERVER_ERROR'])(
  'shows a safe %s refusal and allows an explicit Enter retry',
  async (code) => {
    mocks.search.mockRejectedValueOnce({ data: { code }, message: 'Sensitive provider detail' });
    render(<ScenarioConsole {...props} />);
    const input = await typeAndSearch();
    expect(screen.queryByText('Sensitive provider detail')).not.toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read replenishment report' })).toBeDisabled();
    expect(
      screen.getByText(
        code === 'FORBIDDEN'
          ? 'Medicine search access denied. Ask your workspace administrator to check access.'
          : 'Medicine search unavailable. Press Enter in the search box to retry.'
      )
    ).toBeVisible();
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByRole('listbox')).toBeVisible();
    expect(mocks.search).toHaveBeenCalledTimes(2);
  }
);
it('handles empty results and blocks queries without an authorized branch or above the length bound', async () => {
  mocks.search.mockResolvedValueOnce([]);
  const view = render(<ScenarioConsole {...props} />);
  const input = await typeAndSearch();
  expect(screen.getByText('No matching medicines. Try another name or alias.')).toBeVisible();
  expect(input).toHaveAttribute('aria-expanded', 'false');
  fireEvent.change(input, { target: { value: 'a'.repeat(201) } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(mocks.search).toHaveBeenCalledOnce();
  view.rerender(<ScenarioConsole {...props} initialBranchId="" invalidInitialBranch />);
  expect(screen.getByRole('combobox', { name: 'Find medicine' })).toBeDisabled();
});
it('focuses the single medicine input when selection validation fails', () => {
  render(<ScenarioConsole {...props} />);
  fireEvent.submit(
    screen.getByRole('button', { name: 'Read replenishment report' }).closest('form')!
  );
  expect(screen.getByText('Search and select a medicine.')).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Find medicine' })).toHaveFocus();
  expect(mocks.replenishment).not.toHaveBeenCalled();
});

it('uses plain wording instead of statistics jargon', () => {
  const { container } = render(<ScenarioConsole {...props} financial />);
  const text = container.textContent ?? '';
  expect(text).toContain('Forecast from');
  expect(text).toContain('Your settings');
  expect(text).toContain('Based on the same weekday last week');
  expect(text).not.toContain('Weekly seasonal naive');
  expect(text).not.toContain('forecast origin');
  expect(text).not.toContain('USER_SUPPLIED_ASSUMPTIONS');
});

it('shows the planning basis in plain words once a report is returned', async () => {
  render(<ScenarioConsole {...props} financial />);
  const input = await typeAndSearch();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  const provenance = {
    kind: 'OBSERVED_TRANSACTIONS',
    reference: 'sales',
    readAt: 'x',
    sources: [],
  };
  const scope = { organizationId: 'org-1', branchId: 'branch-1', medicineId: 'medicine-1' };
  mocks.replenishment.mockImplementationOnce(
    async (input: { historyStartDate: string; originDate: string }) => ({
      scope,
      readAt: '2026-11-03T00:00:00Z',
      permissions: { financial: true, operational: true },
      observations: {
        demand: {
          scope,
          period: { startDate: input.historyStartDate, endDateExclusive: input.originDate },
          provenance,
          consumption: { observedCanonicalUnits: 0 },
          coverage: {},
          days: [],
          missingInputs: [],
        },
        supply: {
          scope,
          stock: [],
          excludedStock: [],
          inbound: [],
          limitations: [],
          constraints: {},
          inventorySource: { kind: 'x', reference: 'y', asOf: 'z' },
        },
        supplyCoverage: { status: 'UNVERIFIED', reason: '', recordedEligibleLots: 0 },
      },
      forecast: { status: 'INSUFFICIENT_EVIDENCE', result: null },
      backtest: { status: 'INELIGIBLE', result: null, reasons: [] },
      planning: {
        status: 'NOT_REQUESTED',
        basis: 'USER_SUPPLIED_ASSUMPTIONS',
        dailyDemandUnits: null,
        decision: null,
        goalComparison: null,
      },
      limitations: [],
    })
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
    await Promise.resolve();
  });
  const text = document.body.textContent ?? '';
  expect(text).toContain('Based on: Your settings');
  expect(text).not.toContain('USER_SUPPLIED_ASSUMPTIONS');
});

it('explains why financial planning is unavailable while keeping operational evidence accessible', () => {
  render(<ScenarioConsole {...props} financial={false} />);
  expect(screen.getByText(/Planning requires financial report access/)).toBeVisible();
  expect(screen.getByText(/monetary results are withheld/)).toBeVisible();
});

describe('scenario money typed as an amount', () => {
  async function openScenario(currency: string, timeZone?: string) {
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    mocks.replenishment.mockRejectedValue(new Error('not needed'));
    render(<ScenarioConsole {...props} financial timeZone={timeZone} />);
    const input = await typeAndSearch();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include a user-supplied scenario' }));
    const set = (label: string | RegExp, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    set('Scenario currency (three-letter code)', currency);
    set('Assumed daily demand (units)', '3');
    set('Current policy order (units)', '10');
    set('Proposed policy order (units)', '12');
    set('Order pack size (units)', '1');
    set('Minimum order (units)', '0');
    return set;
  }
  async function submit() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
      await Promise.resolve();
    });
  }

  it('sends the exact minor units for rupee amounts with up to two decimals', async () => {
    const set = await openScenario('PKR');
    set('Current selling price per unit (rupees)', '125.50');
    set('What-if selling price per unit (rupees)', '0.05');
    set('Sales goal (rupees, optional)', '1000000.00');
    set('Margin goal (rupees, optional)', '');
    set('Cost per unit (rupees, optional)', '99.9');
    set('Order budget (rupees, optional)', '0');
    await submit();
    expect(mocks.replenishment).toHaveBeenCalledOnce();
    const scenario = mocks.replenishment.mock.calls[0]![0].manualScenario;
    expect(scenario.currency).toBe('PKR');
    expect(scenario.pricing).toEqual({ currentUnitPriceMinor: 12550, proposedUnitPriceMinor: 5 });
    expect(scenario.goals).toEqual({ salesMinor: 100000000, marginMinor: null });
    expect(scenario.orderTerms.unitCostMinor).toBe(9990);
    expect(scenario.orderTerms.budgetMinor).toBe(0);
  });

  it.each([
    ['125.505', 'Use at most 2 decimal places'],
    ['-5', 'Enter an amount of 0 or more.'],
    ['', 'Enter an amount, for example 125.50.'],
  ])('refuses %s in a required price and sends nothing', async (raw, message) => {
    const set = await openScenario('PKR');
    set('Current selling price per unit (rupees)', raw);
    set('What-if selling price per unit (rupees)', '10');
    await submit();
    expect(mocks.replenishment).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Current selling price per unit (rupees)')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(document.body.textContent).toContain(message);
  });

  it('names the chosen currency, not rupees or paisa, for a non-PKR scenario', async () => {
    const set = await openScenario('USD');
    expect(document.body.textContent).not.toMatch(/paisa|rupee|minor units/i);
    set('Current selling price per unit (USD)', '2.75');
    set('What-if selling price per unit (USD)', '3');
    await submit();
    expect(mocks.replenishment.mock.calls[0]![0].manualScenario.pricing).toEqual({
      currentUnitPriceMinor: 275,
      proposedUnitPriceMinor: 300,
    });
  });

  it("reads assumed arrival and expiry on the organisation's clock, with no ISO example", async () => {
    const set = await openScenario('PKR', 'Asia/Karachi');
    const arrival = screen.getByLabelText('Assumed arrival (date and time, optional)');
    expect(arrival).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('History start')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Scenario starts on (a future day)')).toBeVisible();
    expect(document.body.textContent).toContain("organisation's clock (PKT)");
    expect(document.body.textContent).not.toMatch(/ISO instant|2026-09-16T12:00:00Z/);
    set('Current selling price per unit (rupees)', '10');
    set('What-if selling price per unit (rupees)', '12');
    // Karachi is UTC+5: 5 Nov 09:00 is 04:00 UTC; 1 Jan 00:30 is 19:30 UTC on 31 Dec.
    set('Assumed arrival (date and time, optional)', '2026-11-05T09:00');
    set('Assumed expiry (date and time, optional)', '2027-01-01T00:30');
    await submit();
    expect(mocks.replenishment.mock.calls[0]![0].manualScenario.orderTerms).toMatchObject({
      arrivalAt: '2026-11-05T04:00:00.000Z',
      expiresAt: '2026-12-31T19:30:00.000Z',
    });
  });

  it('refuses an arrival before the scenario starts in plain words', async () => {
    const set = await openScenario('PKR', 'Asia/Karachi');
    set('Current selling price per unit (rupees)', '10');
    set('What-if selling price per unit (rupees)', '12');
    // 4 Nov 04:00 in Karachi is 3 Nov 23:00 UTC, before the 4 Nov scenario start.
    set('Assumed arrival (date and time, optional)', '2026-11-04T04:00');
    await submit();
    expect(mocks.replenishment).not.toHaveBeenCalled();
    expect(screen.getByText('Arrival must be on or after the planning origin.')).toBeVisible();
  });
});

describe("DEV-944 history ends on the shop's today", () => {
  async function read(now: string, today: string, timeZone?: string) {
    vi.setSystemTime(new Date(now));
    mocks.replenishment.mockRejectedValue(new Error('not needed'));
    render(<ScenarioConsole {...props} today={today} timeZone={timeZone} />);
    const input = await typeAndSearch();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read replenishment report' }));
      await Promise.resolve();
    });
  }

  it('sends a history ending on the Karachi today at 19:30 UTC, as the server accepts', async () => {
    // 00:30 on 19 Nov in Karachi.
    await read('2026-11-18T19:30:00.000Z', '2026-11-19', 'Asia/Karachi');
    expect(mocks.replenishment).toHaveBeenCalledOnce();
    expect(mocks.replenishment.mock.calls[0]![0]).toMatchObject({ originDate: '2026-11-19' });
    expect(document.body.textContent).toContain(
      "demand coverage and the history use your organisation's days (PKT)"
    );
  });

  it('refuses a history ending on a Karachi day that has not begun at 18:59 UTC', async () => {
    // 23:59 on 18 Nov in Karachi.
    await read('2026-11-18T18:59:00.000Z', '2026-11-19', 'Asia/Karachi');
    expect(mocks.replenishment).not.toHaveBeenCalled();
    expect(screen.getByText('History must end no later than today.')).toBeVisible();
  });

  it.each([undefined, 'UTC'])('keeps the UTC day for zone %s', async (zone) => {
    await read('2026-11-18T19:30:00.000Z', '2026-11-19', zone);
    expect(mocks.replenishment).not.toHaveBeenCalled();
    expect(screen.getByText('History must end no later than today.')).toBeVisible();
  });
});
