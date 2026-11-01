import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueueActions } from './queue-actions';

describe('QueueActions', () => {
  it('prevents the requesting cashier from approving their own line', () => {
    render(<QueueActions canApprove={false} onAction={vi.fn()} />);
    expect(screen.getByRole('note').textContent).toMatch(/another pharmacist must approve it/i);
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

  it('labels the release decision in plain words', () => {
    const onAction = vi.fn();
    render(<QueueActions canApprove onAction={onAction} />);
    expect(screen.queryByRole('button', { name: /sign/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and release' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approve and release' }));
    expect(onAction).toHaveBeenCalledWith('SIGN', undefined);
  });
});
