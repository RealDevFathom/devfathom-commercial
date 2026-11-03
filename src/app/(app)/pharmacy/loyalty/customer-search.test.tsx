import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerSearch } from './customer-search';

const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
const recent = {
  customers: [
    { id: 'account-a', displayName: 'Ahmed', phoneLast4: '4567', pointsBalance: 14 },
    { id: 'account-b', displayName: 'Zain', phoneLast4: null, pointsBalance: 0 },
  ],
  hasMore: false,
};
const found = {
  customers: [{ ...recent.customers[0]!, displayName: 'Muhammad Ahmed' }],
  hasMore: false,
};
function show(overrides: Partial<Parameters<typeof CustomerSearch>[0]> = {}) {
  const searchAction = vi.fn().mockResolvedValue(found);
  render(
    <CustomerSearch
      branchId="branch-a"
      customerId=""
      query=""
      initial={recent}
      recent={recent}
      searchAction={searchAction}
      {...overrides}
    />
  );
  return { searchAction, input: screen.getByRole('combobox') };
}
async function tick(ms = 250) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('loyalty autocomplete', () => {
  it('loads recent balances without a query and debounces trimmed min-two-character search', async () => {
    const { input, searchAction } = show();
    expect(screen.getByText('14 points')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'A' } });
    await tick(500);
    expect(searchAction).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: ' Ah ' } });
    await tick(249);
    expect(searchAction).not.toHaveBeenCalled();
    expect(screen.getByText('Searching customers…')).toBeInTheDocument();
    await tick(1);
    expect(searchAction).toHaveBeenCalledExactlyOnceWith('branch-a', 'Ah');
    expect(screen.getByRole('option', { name: /Muhammad Ahmed/ })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('Recent loyalty customers')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });
  it('rejects out-of-order responses, including responses after clear', async () => {
    let old!: (value: typeof found) => void;
    let latest!: (value: typeof found) => void;
    const searchAction = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            old = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            latest = resolve;
          })
      );
    const { input } = show({ searchAction });
    fireEvent.change(input, { target: { value: 'Ah' } });
    await tick();
    fireEvent.change(input, { target: { value: 'Ahmed' } });
    await tick();
    await act(async () => {
      latest(found);
    });
    await act(async () => {
      old({ customers: [{ ...recent.customers[1]!, displayName: 'Stale' }], hasMore: false });
    });
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    let late!: (value: typeof found) => void;
    searchAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          late = resolve;
        })
    );
    fireEvent.change(input, { target: { value: 'Zain' } });
    await tick();
    fireEvent.change(input, { target: { value: 'Z' } });
    await act(async () => {
      late(found);
    });
    expect(screen.queryByText('Muhammad Ahmed')).not.toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });
  it('wraps arrows, closes on Escape/blur, reopens on focus, and selects on Enter without submitting', () => {
    const { input } = show();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /Zain/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Ahmed/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input).toHaveAttribute('aria-expanded', 'false');
    fireEvent.focus(input);
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    fireEvent(input, event);
    expect(event.defaultPrevented).toBe(true);
    expect(navigation.push).toHaveBeenCalledWith(
      '/pharmacy/loyalty?branchId=branch-a&customerId=account-a&page=1',
      { scroll: false }
    );
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });
  it('never puts a phone search in selection URLs and keeps focus during click selection', async () => {
    const { input } = show();
    fireEvent.change(input, { target: { value: '03001234567' } });
    await tick();
    const option = screen.getByRole('option');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    fireEvent(option, down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(option);
    const url = navigation.push.mock.calls[0]![0];
    expect(url).not.toContain('03001234567');
    expect(url).not.toContain('query=');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });
  it('refreshes the selected balance instead of leaving cached history', () => {
    show({ customerId: 'account-a' });
    fireEvent.click(screen.getByRole('option', { name: /Ahmed/ }));
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });
  it('restores legacy initial search when returning to its query', async () => {
    const { input } = show({ query: 'Ahmed', initial: found });
    fireEvent.change(input, { target: { value: 'Zain' } });
    await tick();
    fireEvent.change(input, { target: { value: 'Ahmed' } });
    expect(screen.queryByText('Searching customers…')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Muhammad Ahmed/ })).toBeInTheDocument();
  });
  it('shows safe errors, retries and explains no matches', async () => {
    const searchAction = vi
      .fn()
      .mockRejectedValueOnce(new Error('private database detail'))
      .mockResolvedValue({ customers: [], hasMore: false });
    const { input } = show({ searchAction });
    fireEvent.change(input, { target: { value: 'Ahmed' } });
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('Customer search is unavailable');
    expect(screen.queryByText('private database detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    await tick();
    expect(screen.getByRole('status')).toHaveTextContent('No matching customers');
  });
});
