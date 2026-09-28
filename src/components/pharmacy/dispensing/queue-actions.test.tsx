import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('retains counselling checks after refusal and clears them after confirmed success', async () => {
    const onAction = vi
      .fn()
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce(undefined);
    const onDirtyChange = vi.fn();
    render(<QueueActions canApprove onAction={onAction} onDirtyChange={onDirtyChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Counsel' }));
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm counsel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeChecked();
    expect(onDirtyChange).not.toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm counsel' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Confirm counsel' })).not.toBeInTheDocument()
    );
    expect(onAction).toHaveBeenLastCalledWith('COUNSEL', 'Counselling checklist completed.');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Counsel' }));
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Confirm counsel' })).toBeDisabled();
  });

  it('locks counselling inputs and prevents duplicate submissions until the promise settles', async () => {
    let finish!: () => void;
    const onAction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    render(<QueueActions canApprove onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Counsel' }));
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm counsel' }));
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Recording…' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it.each(['pending', 'disabled'] as const)('does not submit when %s', (flag) => {
    const onAction = vi.fn();
    const view = render(<QueueActions canApprove onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clarify' }));
    fireEvent.change(screen.getByLabelText('Note back to counter'), {
      target: { value: 'Review note' },
    });
    view.rerender(<QueueActions canApprove onAction={onAction} {...{ [flag]: true }} />);
    expect(screen.getByLabelText('Note back to counter')).toBeDisabled();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('requires a non-whitespace reason and retains the second-signature notice', () => {
    const onAction = vi.fn();
    render(<QueueActions canApprove onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Override' }));
    fireEvent.change(screen.getByLabelText('Override reason'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Confirm override' })).toBeDisabled();
    expect(screen.getByText(/second authorized signature remains required/i)).toBeVisible();
    expect(onAction).not.toHaveBeenCalled();
  });
});
