import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountVarianceThresholdSettings } from './count-variance-threshold-settings';

type Options = {
  onError?: (error: { message: string }) => void;
  onSuccess?: (saved: { pharmacyCountVarianceThresholdUnits: number }) => void;
};
const mutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  options: {} as Options,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyOperatingMode: {
      setCountVarianceThreshold: {
        useMutation: (options: Options) => {
          mutation.options = options;
          return mutation;
        },
      },
    },
  },
}));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('count variance threshold owner setting', () => {
  it('masks the PIN and submits a bounded whole-unit threshold', () => {
    render(<CountVarianceThresholdSettings initialUnits={0} />);
    const units = screen.getByLabelText('Threshold (units)');
    const pin = screen.getByLabelText('Owner PIN');
    expect(units).toHaveAttribute('max', '10');
    expect(pin).toHaveAttribute('type', 'password');
    expect(pin).toHaveAttribute('autocomplete', 'off');
    const submit = screen.getByRole('button', { name: 'Save threshold' });
    fireEvent.change(units, { target: { value: '11' } });
    fireEvent.change(pin, { target: { value: '4729' } });
    expect(submit).toBeDisabled();
    fireEvent.change(units, { target: { value: '6' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(mutation.mutate).toHaveBeenCalledWith({ thresholdUnits: 6, pin: '4729' });
  });

  it('shows the saved value on success and announces a refusal as an alert', () => {
    render(<CountVarianceThresholdSettings initialUnits={2} />);
    expect(screen.getByText('2 units')).toBeInTheDocument();
    act(() => mutation.options.onSuccess?.({ pharmacyCountVarianceThresholdUnits: 6 }));
    expect(screen.getByText('6 units')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Count threshold saved');
    const pin = screen.getByLabelText('Owner PIN');
    fireEvent.change(pin, { target: { value: '4729' } });
    act(() => mutation.options.onError?.({ message: 'Owner PIN re-authentication failed.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Owner PIN re-authentication failed.');
    expect(pin).toHaveValue('');
  });
});
