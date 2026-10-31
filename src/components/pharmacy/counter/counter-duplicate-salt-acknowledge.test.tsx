import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  state: { isPending: false, error: null as Error | null },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      acknowledgeDuplicateSalt: {
        useMutation: () => ({
          mutate: mocks.mutate,
          isPending: mocks.state.isPending,
          error: mocks.state.error,
        }),
      },
    },
  },
}));

import { CounterDuplicateSaltAcknowledge } from './counter-duplicate-salt-acknowledge';

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.state.isPending = false;
  mocks.state.error = null;
});

describe('CounterDuplicateSaltAcknowledge (#724)', () => {
  it('records the acknowledgement for this bill and salt, then shows it as acknowledged', () => {
    mocks.mutate.mockImplementation((_input, options: { onSuccess: () => void }) =>
      options.onSuccess()
    );
    render(
      <CounterDuplicateSaltAcknowledge
        branchId="branch-1"
        saleId="sale-1"
        ingredientKey="paracetamol"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      { branchId: 'branch-1', saleId: 'sale-1', ingredientKey: 'paracetamol' },
      expect.any(Object)
    );
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.getByText('Acknowledged')).toBeInTheDocument();
  });

  it('keeps the control available and reports a failed acknowledgement', () => {
    mocks.state.error = new Error('NOT_DUPLICATE');
    render(
      <CounterDuplicateSaltAcknowledge
        branchId="branch-1"
        saleId="sale-1"
        ingredientKey="paracetamol"
      />
    );
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('is disabled while the counter is busy', () => {
    render(
      <CounterDuplicateSaltAcknowledge
        branchId="branch-1"
        saleId="sale-1"
        ingredientKey="paracetamol"
        disabled
      />
    );
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
  });
});
