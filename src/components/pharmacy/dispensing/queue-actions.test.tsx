import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueueActions } from './queue-actions';

describe('QueueActions', () => {
  it('requires a PIN for solo owner signing and clears it after recording', async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    render(<QueueActions canApprove requirePin onAction={action} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign' }));
    expect(screen.getByRole('button', { name: 'Confirm sign' })).toBeDisabled();
    const input = screen.getByLabelText('Owner PIN');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: '123' } });
    expect(screen.getByRole('button', { name: 'Confirm sign' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '582961' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sign' }));
    await waitFor(() => expect(action).toHaveBeenCalledWith('SIGN', undefined, '582961'));
    await waitFor(() => expect(screen.queryByLabelText('Owner PIN')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Sign' }));
    expect(screen.getByLabelText('Owner PIN')).toHaveValue('');
  });
  it('prevents the requesting cashier from approving their own line', () => {
    render(<QueueActions canApprove={false} onAction={vi.fn()} />);
    expect(screen.getByRole('note').textContent).toMatch(/cannot approve or sign/i);
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
  });

  it('requires a reason before an override can be confirmed', () => {
    render(<QueueActions canApprove onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Override' }));
    expect(screen.getByRole('button', { name: 'Confirm override' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Override reason'), {
      target: { value: 'Documented emergency supply' },
    });
    expect(screen.getByRole('button', { name: 'Confirm override' })).toBeEnabled();
  });

  it('requires every counselling step before recording counsel', () => {
    render(<QueueActions canApprove onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Counsel' }));
    const confirm = screen.getByRole('button', { name: 'Confirm counsel' });
    expect(confirm).toBeDisabled();
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    expect(confirm).toBeEnabled();
  });
});
