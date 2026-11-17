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
  fireEvent.blur(input, { relatedTarget: screen.getByLabelText('History start (UTC)') });
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

it('explains why financial planning is unavailable while keeping operational evidence accessible', () => {
  render(<ScenarioConsole {...props} financial={false} />);
  expect(screen.getByText(/Planning requires financial report access/)).toBeVisible();
  expect(screen.getByText(/monetary results are withheld/)).toBeVisible();
});
