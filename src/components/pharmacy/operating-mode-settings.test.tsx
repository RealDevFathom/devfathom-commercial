import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperatingModeSettings } from './operating-mode-settings';

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
vi.mock('@/lib/trpc', () => ({
  trpc: { pharmacyOperatingMode: { set: { useMutation: () => mutation } } },
}));
afterEach(cleanup);

describe('operating mode owner credential', () => {
  it('masks the PIN, disables autocomplete, and submits the explicit mode change', () => {
    render(<OperatingModeSettings initialMode="SOLO" />);
    const pin = screen.getByLabelText('Owner PIN');
    expect(pin).toHaveAttribute('type', 'password');
    expect(pin).toHaveAttribute('autocomplete', 'off');
    const submit = screen.getByRole('button', { name: 'Switch to STAFFED' });
    expect(submit).toBeDisabled();
    fireEvent.change(pin, { target: { value: '4729' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(mutation.mutate).toHaveBeenCalledWith({ mode: 'STAFFED', pin: '4729' });
  });
});
