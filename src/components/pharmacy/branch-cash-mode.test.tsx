import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BranchCashMode } from './branch-cash-mode';

const { read, save, retry, mutate } = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  retry: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    pharmacyBranchAssignments: {
      cashModes: { useQuery: read },
      setCashMode: { useMutation: save },
    },
  },
}));
afterEach(cleanup);

it('shows the server mode per branch and submits only the branch being edited', () => {
  read.mockReturnValue({
    data: [
      { id: 'a', name: 'Main', code: 'MAIN', cashShiftsEnabled: false },
      { id: 'b', name: 'East', code: 'EAST', cashShiftsEnabled: true },
    ],
  });
  save.mockReturnValue({ reset: vi.fn(), mutate });
  render(<BranchCashMode />);
  const field = screen.getByLabelText('Main (MAIN)', { selector: 'select' });
  const submit = within(field.closest('form')!).getByRole('button', { name: 'Save choice' });
  expect(field).toHaveValue('day');
  expect(screen.getByLabelText('East (EAST)', { selector: 'select' })).toHaveValue('shifts');
  expect(submit).toBeDisabled();
  fireEvent.change(field, { target: { value: 'shifts' } });
  fireEvent.click(submit);
  expect(mutate).toHaveBeenCalledWith({ branchId: 'a', enabled: true });
});

it('handles loading, unavailable, empty and restricted branch lists separately', () => {
  read.mockReturnValue({ data: undefined });
  const view = render(<BranchCashMode />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading branch choices');
  read.mockReturnValue({ isError: true, refetch: retry });
  view.rerender(<BranchCashMode />);
  expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalled();
  read.mockReturnValue({ data: [] });
  view.rerender(<BranchCashMode />);
  expect(screen.getByText(/Add an active branch/)).toBeVisible();
  read.mockReturnValue({ data: null });
  view.rerender(<BranchCashMode />);
  expect(view.container).toBeEmptyDOMElement();
});
