import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueueActions } from './queue-actions';

describe('QueueActions', () => {
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
  it('requires a valid fresh solo-owner PIN and sends it with the clinical decision', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<QueueActions canApprove requirePin onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    const confirm = screen.getByRole('button', { name: 'Confirm verify' });
    expect(confirm).toBeDisabled();
    const pin = screen.getByLabelText('Owner PIN');
    expect(pin).toHaveAttribute('type', 'password');
    fireEvent.change(pin, { target: { value: 'abc' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(pin, { target: { value: '4729' } });
    await act(async () => fireEvent.click(confirm));
    expect(onAction).toHaveBeenCalledExactlyOnceWith('VERIFY', undefined, '4729');
    expect(screen.queryByLabelText('Owner PIN')).not.toBeInTheDocument();
  });
});
