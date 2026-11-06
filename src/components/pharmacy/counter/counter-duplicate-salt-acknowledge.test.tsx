import { act, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '@/test/intl';
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

const medicines = [
  { medicineId: 'panadol', displayName: 'Panadol', ref: 'line-1' },
  { medicineId: 'calpol', displayName: 'Calpol', ref: 'line-2' },
];
const props = { branchId: 'branch-1', saleId: 'sale-1', ingredientKey: 'paracetamol', medicines };

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.mutate.mockImplementation((_input, options: { onSuccess: (data: typeof props) => void }) =>
    options.onSuccess(props)
  );
  mocks.state.isPending = false;
  mocks.state.error = null;
});

describe('CounterDuplicateSaltAcknowledge (#724)', () => {
  it('records the acknowledgement for this bill and salt, then shows it as acknowledged', () => {
    render(
      <CounterDuplicateSaltAcknowledge
        branchId="branch-1"
        saleId="sale-1"
        ingredientKey="paracetamol"
        medicines={medicines}
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
        medicines={medicines}
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
        medicines={medicines}
        disabled
      />
    );
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
  });

  it.each<[string, typeof medicines]>([
    [
      'adds a third medicine',
      [...medicines, { medicineId: 'pcm', displayName: 'PCM', ref: 'line-3' }],
    ],
    ['removes a medicine', medicines.slice(0, 1)],
    [
      'replaces a medicine',
      [medicines[0]!, { medicineId: 'pcm', displayName: 'PCM', ref: 'line-3' }],
    ],
    ['replaces a sale line', [medicines[0]!, { ...medicines[1]!, ref: 'line-new' }]],
  ])('requires acknowledgement again when the group %s', (_change, changed) => {
    const { rerender } = render(<CounterDuplicateSaltAcknowledge {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(screen.getByText('Acknowledged')).toBeInTheDocument();

    rerender(<CounterDuplicateSaltAcknowledge {...props} medicines={changed} />);

    expect(screen.queryByText('Acknowledged')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
  });

  it('preserves acknowledgement when the same medicines and lines are reordered', () => {
    const { rerender } = render(<CounterDuplicateSaltAcknowledge {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    rerender(<CounterDuplicateSaltAcknowledge {...props} medicines={[...medicines].reverse()} />);
    expect(screen.getByText('Acknowledged')).toBeInTheDocument();
  });

  it('does not mark a changed group acknowledged when an older request succeeds', () => {
    let complete!: (data: typeof props) => void;
    mocks.mutate.mockImplementation((_input, options: { onSuccess: typeof complete }) => {
      complete = options.onSuccess;
    });
    const { rerender } = render(<CounterDuplicateSaltAcknowledge {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    rerender(
      <CounterDuplicateSaltAcknowledge
        {...props}
        medicines={[...medicines, { medicineId: 'pcm', displayName: 'PCM', ref: 'line-3' }]}
      />
    );
    act(() => complete(props));
    expect(screen.queryByText('Acknowledged')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
  });

  it('only acknowledges the medicine group actually recorded by the server', () => {
    mocks.mutate.mockImplementation(
      (_input, options: { onSuccess: (data: typeof props) => void }) =>
        options.onSuccess({
          ...props,
          medicines: [...medicines, { medicineId: 'pcm', displayName: 'PCM', ref: 'line-3' }],
        })
    );
    render(<CounterDuplicateSaltAcknowledge {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(screen.queryByText('Acknowledged')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
  });
});
