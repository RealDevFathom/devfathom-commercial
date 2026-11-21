import { selectFieldControl } from '@/lib/testing/select-field';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pending: true }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySafety: {
      branches: {
        useQuery: () => ({
          data: [
            { id: 'sindh', name: 'Karachi' },
            { id: 'punjab', name: 'Lahore' },
          ],
        }),
      },
      controlledRegister: {
        useQuery: ({ branchId }: { branchId: string }) => ({
          data: {
            entries: [],
            provinceName: branchId === 'sindh' ? 'Sindh' : 'Punjab',
            pendingLegalReview: branchId === 'sindh' && mocks.pending,
          },
        }),
      },
      controlledPharmacists: { useQuery: () => ({ data: [] }) },
      recordCorrection: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));
import { ControlledRegisterConsole } from './controlled-register-console';

beforeEach(() => {
  mocks.pending = true;
});
afterEach(cleanup);

it('shows pending legal review even when the register is empty', () => {
  render(<ControlledRegisterConsole />);
  expect(screen.getByRole('status')).toHaveTextContent('Pending legal review');
  expect(screen.getByRole('status')).toHaveTextContent('Sindh rules are provisional');
  expect(screen.getByRole('status')).toHaveTextContent('Dispensing and activation remain blocked');
  expect(screen.getByText(/No rows yet/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Print register' })).toBeDisabled();
});

it('removes the pending warning when switching to a confirmed branch', () => {
  render(<ControlledRegisterConsole />);
  fireEvent.change(
    selectFieldControl(
      screen.getByLabelText('Branch', {
        selector: ':not([data-select-field-native][aria-hidden="true"])',
      })
    ),
    { target: { value: 'punjab' } }
  );
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('does not label confirmed Sindh rules as pending', () => {
  mocks.pending = false;
  render(<ControlledRegisterConsole />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
