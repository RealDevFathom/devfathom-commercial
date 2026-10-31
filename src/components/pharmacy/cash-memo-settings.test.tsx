import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  policies: {} as Record<
    string,
    {
      data?: { cashMemo: boolean; buyerNameRequired: boolean };
      isError?: boolean;
      refetch?: () => void;
    }
  >,
  save: vi.fn(),
  setData: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacySales: { counterCashMemoPolicy: { setData: mocks.setData } },
    }),
    pharmacySales: {
      counterCashMemoPolicy: {
        useQuery: ({ branchId }: { branchId: string }) => mocks.policies[branchId],
      },
      counterSaveCashMemoPolicy: {
        useMutation: () => ({ mutateAsync: mocks.save }),
      },
    },
  },
}));

import { CashMemoSettings } from './cash-memo-settings';

const branches = [
  { id: 'branch-a', name: 'Saddar', code: 'A' },
  { id: 'branch-b', name: 'Clifton', code: 'B' },
];

beforeEach(() => {
  mocks.policies = {
    'branch-a': { data: { cashMemo: true, buyerNameRequired: false } },
    'branch-b': { data: { cashMemo: true, buyerNameRequired: true } },
  };
  mocks.save.mockReset();
  mocks.setData.mockReset().mockImplementation(({ branchId }, update) => {
    mocks.policies[branchId]!.data = update(mocks.policies[branchId]!.data);
  });
});
afterEach(cleanup);

it('saves both policy choices to the administrator endpoint for the selected branch', async () => {
  mocks.save.mockImplementation(async (input) => ({
    buyerNameRequired: input.buyerNameRequired,
  }));
  render(<CashMemoSettings branches={branches} />);
  const checkbox = screen.getByRole('checkbox', { name: 'Require a buyer name before payment' });
  expect(checkbox).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Save cash memo policy' })).toBeDisabled();
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole('button', { name: 'Save cash memo policy' }));
  await screen.findByText(/Cash memo policy saved/);
  expect(mocks.save).toHaveBeenLastCalledWith({ branchId: 'branch-a', buyerNameRequired: true });
  expect(checkbox).toBeChecked();

  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole('button', { name: 'Save cash memo policy' }));
  await screen.findByText(/Cash memo policy saved/);
  expect(mocks.save).toHaveBeenLastCalledWith({ branchId: 'branch-a', buyerNameRequired: false });
  expect(checkbox).not.toBeChecked();

  fireEvent.change(screen.getByLabelText('Cash memo branch'), { target: { value: 'branch-b' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save cash memo policy' }));
  await screen.findByText(/Cash memo policy saved/);
  expect(mocks.save).toHaveBeenLastCalledWith({ branchId: 'branch-b', buyerNameRequired: false });
});

it('discards a branch draft when switching branches and reads the selected branch policy', () => {
  render(<CashMemoSettings branches={branches} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('Cash memo branch'), { target: { value: 'branch-b' } });
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByRole('button', { name: 'Save cash memo policy' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Cash memo branch'), { target: { value: 'branch-a' } });
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(mocks.save).not.toHaveBeenCalled();
});

it('disables saving and editing while a policy save is pending', async () => {
  let resolve!: (value: { buyerNameRequired: boolean }) => void;
  mocks.save.mockReturnValue(
    new Promise((yes) => {
      resolve = yes;
    })
  );
  render(<CashMemoSettings branches={branches} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save cash memo policy' }));
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  expect(screen.getByRole('checkbox')).toBeDisabled();
  await act(async () => {
    resolve({ buyerNameRequired: true });
  });
  expect(await screen.findByRole('status')).toHaveTextContent('Cash memo policy saved.');
});

it('preserves the selected value after a save refusal', async () => {
  mocks.save.mockRejectedValue(new Error('Administrator access required.'));
  render(<CashMemoSettings branches={branches} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save cash memo policy' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Administrator access required.');
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByRole('button', { name: 'Save cash memo policy' })).toBeEnabled();
});

it('shows loading, failed-read and retry states without allowing a save', () => {
  const refetch = vi.fn();
  mocks.policies['branch-a'] = {};
  const view = render(<CashMemoSettings branches={branches} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading cash memo policy');
  expect(screen.queryByRole('checkbox')).toBeNull();
  mocks.policies['branch-a'] = { isError: true, refetch };
  view.rerender(<CashMemoSettings branches={branches} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Check your access and retry.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry policy' }));
  expect(refetch).toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it('explains an empty branch list', () => {
  render(<CashMemoSettings branches={[]} />);
  expect(screen.getByText('No active pharmacy branch is available.')).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
});
