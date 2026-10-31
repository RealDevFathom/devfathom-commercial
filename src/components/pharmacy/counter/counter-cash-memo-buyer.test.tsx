import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  policy: { data: undefined as { cashMemo: boolean; buyerNameRequired: boolean } | undefined },
  policyInput: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      counterCashMemoPolicy: {
        useQuery: (input: unknown, options: unknown) => {
          mocks.policyInput(input, options);
          return mocks.policy;
        },
      },
      counterSetBuyerName: {
        useMutation: () => ({ mutateAsync: mocks.save, isPending: false }),
      },
    },
  },
}));

import { CounterCashMemoBuyer } from './counter-cash-memo-buyer';

beforeEach(() => {
  mocks.policy = { data: { cashMemo: true, buyerNameRequired: false } };
  mocks.policyInput.mockClear();
  mocks.save.mockReset();
});
afterEach(cleanup);

it('renders nothing outside a Sindh cash memo branch', () => {
  mocks.policy = { data: { cashMemo: false, buyerNameRequired: false } };
  const { container } = render(<CounterCashMemoBuyer branchId="branch-a" saleId="sale-a" />);
  expect(container.innerHTML).toBe('');
  expect(mocks.policyInput).toHaveBeenCalledWith({ branchId: 'branch-a' }, { enabled: true });
});

it('prefills the selected patient or customer and saves the trimmed name', async () => {
  mocks.save.mockResolvedValue({ saleId: 'sale-a', buyerName: 'Ayesha Khan' });
  render(
    <CounterCashMemoBuyer branchId="branch-a" saleId="sale-a" suggestedName="Ayesha Khan" />
  );
  const input = screen.getByLabelText('Buyer name for cash memo');
  expect(input).toHaveValue('Ayesha Khan');
  expect(screen.getByText(/Optional for walk-ins/)).toBeTruthy();

  fireEvent.change(input, { target: { value: '  Ayesha   Khan  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save buyer name' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      branchId: 'branch-a',
      saleId: 'sale-a',
      buyerName: 'Ayesha Khan',
    })
  );
  expect(await screen.findByRole('status')).toHaveTextContent('Buyer name saved for this bill.');
});

it('labels the owner policy requirement', () => {
  mocks.policy = { data: { cashMemo: true, buyerNameRequired: true } };
  render(<CounterCashMemoBuyer branchId="branch-a" saleId="sale-a" />);
  expect(screen.getByLabelText('Buyer name for cash memo (required)')).toBeTruthy();
  expect(screen.getByText(/requires a buyer name before payment/)).toBeTruthy();
});

it('refuses an over-long name before sending it', () => {
  render(<CounterCashMemoBuyer branchId="branch-a" saleId="sale-a" />);
  const input = screen.getByLabelText('Buyer name for cash memo');
  fireEvent.change(input, { target: { value: 'a'.repeat(121) } });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('alert')).toHaveTextContent('Use 120 characters or fewer.');
  expect(screen.getByRole('button', { name: 'Save buyer name' })).toBeDisabled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it('shows a server refusal and keeps the typed value', async () => {
  mocks.save.mockRejectedValue(
    new Error('The buyer name can only change before the receipt is issued.')
  );
  render(<CounterCashMemoBuyer branchId="branch-a" saleId="sale-a" />);
  const input = screen.getByLabelText('Buyer name for cash memo');
  fireEvent.change(input, { target: { value: 'Bilal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save buyer name' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The buyer name can only change before the receipt is issued.'
  );
  expect(input).toHaveValue('Bilal');
});

it('is disabled until there is an open bill', () => {
  render(<CounterCashMemoBuyer branchId="branch-a" saleId={null} />);
  expect(screen.getByLabelText('Buyer name for cash memo')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save buyer name' })).toBeDisabled();
});
