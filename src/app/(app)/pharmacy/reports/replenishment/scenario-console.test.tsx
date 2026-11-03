import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const search = vi.fn();
  const report = vi.fn();
  return {
    search,
    report,
    utils: {
      client: {
        pharmacyMedicine: { search: { query: search } },
        pharmacyReports: { replenishment: { query: report } },
      },
    },
  };
});
vi.mock('@/lib/trpc', () => ({ trpc: { useUtils: () => mocks.utils } }));

import { ScenarioConsole } from './scenario-console';

const props = {
  organizationId: 'organization-a',
  branches: [
    { id: 'branch-a', name: 'Main branch' },
    { id: 'branch-b', name: 'Second branch' },
  ],
  financial: true,
  initialBranchId: 'branch-a',
  invalidInitialBranch: false,
  today: '2026-11-03',
};
const medicines = [
  { id: 'medicine-a', productName: 'Paracetamol 500 mg' },
  { id: 'medicine-b', productName: 'Panadol 500 mg' },
];
const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
const input = () => screen.getByRole('combobox', { name: 'Find medicine' });
const readButton = () => screen.getByRole('button', { name: 'Read replenishment report' });
const form = () => readButton().closest('form')!;
const selectedId = () => new FormData(form()).get('medicineId');
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const advance = (ms = 250) => act(() => vi.advanceTimersByTimeAsync(ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function chooseMedicine() {
  type('pa');
  await advance();
  fireEvent.click(screen.getByRole('option', { name: medicines[0].productName }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
  mocks.search.mockReset().mockResolvedValue(medicines);
  mocks.report.mockReset().mockReturnValue(new Promise(() => {}));
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (scrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoView);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

describe('replenishment medicine combobox', () => {
  it('preserves the initial branch without inventing an incoming medicine selection', async () => {
    render(<ScenarioConsole {...props} />);
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveValue('branch-a');
    expect(input()).toHaveValue('');
    expect(input()).toBeEnabled();
    expect(input()).toHaveAttribute('aria-autocomplete', 'list');
    expect(selectedId()).toBe('');
    expect(readButton()).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Search medicines' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Medicine' })).not.toBeInTheDocument();
    await advance(500);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('requires two trimmed characters and restarts the 250ms debounce on each edit', async () => {
    render(<ScenarioConsole {...props} />);
    type(' p ');
    await advance();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(input()).toHaveAccessibleDescription('Type at least 2 characters to find a medicine.');
    type(' pa ');
    await advance(200);
    type(' pan ');
    await advance(249);
    expect(mocks.search).not.toHaveBeenCalled();
    await advance(1);
    expect(mocks.search).toHaveBeenCalledExactlyOnceWith({ query: 'pan', limit: 25 });
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2);
    expect(input()).toHaveAccessibleDescription(
      '2 matches (maximum 25). Refine the search if needed.'
    );
  });

  it('announces pending and empty results; Escape stays closed after a pending response', async () => {
    const request = deferred<typeof medicines>();
    mocks.search.mockReturnValueOnce(request.promise);
    render(<ScenarioConsole {...props} />);
    type('absent');
    await advance();
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
    expect(input()).toHaveAccessibleDescription('Searching permitted medicines…');
    fireEvent.keyDown(input(), { key: 'Escape' });
    await act(async () => request.resolve([]));
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input()).toHaveAccessibleDescription(
      'No matching medicines. Try another name or alias.'
    );
  });

  it('selects by click, keeps focus and the medicine ID, and does not search the selected label', async () => {
    render(<ScenarioConsole {...props} />);
    await chooseMedicine();
    expect(input()).toHaveFocus();
    expect(input()).toHaveValue('Paracetamol 500 mg');
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    expect(selectedId()).toBe('medicine-a');
    expect(readButton()).toBeEnabled();
    await advance(1000);
    expect(mocks.search).toHaveBeenCalledTimes(1);
    act(() => screen.getByLabelText('History start (UTC)').focus());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    act(() => input().focus());
    expect(screen.getByRole('option', { name: 'Paracetamol 500 mg' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(selectedId()).toBe('medicine-a');
    fireEvent.click(input());
    expect(screen.getByRole('listbox')).toBeVisible();
  });

  it('navigates with arrows and selects with Enter without submitting the report', async () => {
    render(<ScenarioConsole {...props} />);
    type('pa');
    await advance();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(selectedId()).toBe('');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input()).toHaveAttribute('aria-activedescendant', 'replenishment-medicine-option-1');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input()).toHaveAttribute('aria-activedescendant', 'replenishment-medicine-option-0');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    expect(selectedId()).toBe('');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input()).toHaveValue('Panadol 500 mg');
    expect(selectedId()).toBe('medicine-b');
    expect(input()).not.toHaveAttribute('aria-activedescendant');
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('ignores superseded responses and clears selection when the query is edited', async () => {
    const old = deferred<typeof medicines>();
    mocks.search.mockReturnValueOnce(old.promise);
    render(<ScenarioConsole {...props} />);
    type('old');
    await advance();
    type('pa');
    await advance();
    fireEvent.click(screen.getByRole('option', { name: 'Panadol 500 mg' }));
    await act(async () => old.resolve([{ id: 'old', productName: 'Old result' }]));
    expect(input()).toHaveValue('Panadol 500 mg');
    expect(selectedId()).toBe('medicine-b');
    type('p');
    expect(selectedId()).toBe('');
    expect(readButton()).toBeDisabled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await advance();
    expect(mocks.search).toHaveBeenCalledTimes(2);
  });

  it.each(['INTERNAL_SERVER_ERROR', 'FORBIDDEN', 'UNAUTHORIZED'])(
    'announces %s and retries the same query without exposing the server message',
    async (code) => {
      mocks.search.mockRejectedValueOnce({ message: 'Private server detail', data: { code } });
      render(<ScenarioConsole {...props} />);
      type('pa');
      await advance();
      expect(input()).toHaveAccessibleDescription(
        code === 'INTERNAL_SERVER_ERROR'
          ? 'Medicine search unavailable. Retry the search.'
          : 'Medicine search access denied. Ask your workspace administrator to check access.'
      );
      expect(screen.queryByText('Private server detail')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Retry medicine search' }));
      await advance();
      expect(mocks.search).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('option', { name: 'Panadol 500 mg' })).toBeVisible();
    }
  );

  it('preserves draft filters and manual assumptions when selecting, then submits the chosen ID', async () => {
    const request = deferred<never>();
    mocks.report.mockReturnValue(request.promise);
    render(<ScenarioConsole {...props} />);
    fireEvent.change(screen.getByLabelText('Planning / forecast horizon (days)'), {
      target: { value: '14' },
    });
    fireEvent.change(screen.getByLabelText('Forecast method'), {
      target: { value: 'WEEKLY_SEASONAL_NAIVE' },
    });
    fireEvent.click(screen.getByLabelText('Include a user-supplied scenario'));
    for (const [name, value] of [
      ['Assumed daily demand (units)', '2'],
      ['Current policy order (units)', '3'],
      ['Proposed policy order (units)', '4'],
      ['Current unit selling price (minor units)', '100'],
      ['What-if unit selling price (minor units)', '110'],
      ['Order pack size (units)', '1'],
      ['Minimum order (units)', '0'],
      ['Scenario currency (three-letter code)', 'PKR'],
    ] as const) fireEvent.change(screen.getByLabelText(name), { target: { value } });
    await chooseMedicine();
    fireEvent.change(screen.getByLabelText('History start (UTC)'), {
      target: { value: '2026-10-20' },
    });
    expect(selectedId()).toBe('medicine-a');
    expect(screen.getByLabelText('Include a user-supplied scenario')).toBeChecked();
    fireEvent.click(readButton());
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-a',
      medicineId: 'medicine-a',
      historyStartDate: '2026-10-20',
      originDate: '2026-11-03',
      horizonDays: 14,
      method: 'WEEKLY_SEASONAL_NAIVE',
      manualScenario: {
        originDate: '2026-11-04',
        dailyDemandUnits: 2,
        currentQuantityUnits: 3,
        proposedQuantityUnits: 4,
        currency: 'PKR',
        goals: { salesMinor: null, marginMinor: null },
        pricing: { currentUnitPriceMinor: 100, proposedUnitPriceMinor: 110 },
        orderTerms: {
          packSize: 1,
          minimumOrderUnits: 0,
          unitCostMinor: null,
          budgetMinor: null,
          storageLimitUnits: null,
          arrivalAt: null,
          expiresAt: null,
        },
      },
    });
    type('different medicine');
    await act(async () => request.reject({ data: { code: 'FORBIDDEN' } }));
    expect(screen.getByText(/Inputs changed. Previous results are hidden/)).toBeVisible();
    expect(screen.queryByText(/Report access denied or session expired/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Assumed daily demand (units)')).toHaveValue(2);
  });

  it('clears selection on branch changes and rejects results from the previous scope', async () => {
    const request = deferred<typeof medicines>();
    render(<ScenarioConsole {...props} />);
    await chooseMedicine();
    mocks.search.mockReturnValueOnce(request.promise);
    type('old branch');
    await advance();
    const branch = screen.getByRole('combobox', { name: 'Branch' });
    act(() => branch.focus());
    fireEvent.change(branch, { target: { value: '' } });
    await act(async () => request.resolve(medicines));
    expect(input()).toBeDisabled();
    expect(selectedId()).toBe('');
    expect(readButton()).toBeDisabled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.change(branch, { target: { value: 'branch-b' } });
    await advance();
    expect(input()).toHaveValue('old branch');
    expect(selectedId()).toBe('');
    act(() => input().focus());
    expect(screen.getByRole('option', { name: 'Panadol 500 mg' })).toBeVisible();
  });

  it('focuses the visible combobox on selection validation failure and cancels debounce on unmount', async () => {
    const view = render(<ScenarioConsole {...props} />);
    fireEvent.submit(form());
    expect(input()).toHaveFocus();
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(input()).toHaveAccessibleDescription(/Search and select a medicine/);
    type('pa');
    view.unmount();
    await advance();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('discards selection and draft state when server authority changes', async () => {
    const view = render(<ScenarioConsole {...props} />);
    await chooseMedicine();
    fireEvent.click(screen.getByLabelText('Include a user-supplied scenario'));
    view.rerender(
      <ScenarioConsole
        {...props}
        organizationId="organization-b"
        initialBranchId=""
        invalidInitialBranch
      />
    );
    expect(input()).toHaveValue('');
    expect(input()).toBeDisabled();
    expect(selectedId()).toBe('');
    expect(screen.getByLabelText('Include a user-supplied scenario')).not.toBeChecked();
    expect(screen.getByText(/The requested branch is unavailable/)).toBeVisible();
  });
});
