import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { SopLoadRecovery } from './sop-load-recovery';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SopLoadRecovery', () => {
  it('does not retry or mutate anything on render', () => {
    const { container } = render(<SopLoadRecovery />);

    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Retry SOP board' })).toBeEnabled();
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'false');
  });

  it('offers a keyboard-operable, wrap-safe retry with a polite atomic live region', () => {
    const { container } = render(<SopLoadRecovery />);
    const button = screen.getByRole('button', { name: 'Retry SOP board' });
    const liveRegion = container.querySelector('[aria-live="polite"]');

    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(button).toHaveClass('max-w-full', 'whitespace-normal');
    expect(liveRegion).toHaveAttribute('aria-atomic', 'true');
  });

  it('keeps focus on the retry action after the request settles', async () => {
    render(<SopLoadRecovery />);
    const button = screen.getByRole('button', { name: 'Retry SOP board' });

    button.focus();
    await act(async () => fireEvent.click(button));

    expect(button).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Retry SOP board' })).toBeEnabled();
  });

  it('can retry again after a repeated failure leaves the recovery state mounted', async () => {
    render(<SopLoadRecovery />);
    const button = screen.getByRole('button', { name: 'Retry SOP board' });

    await act(async () => fireEvent.click(button));
    await act(async () => fireEvent.click(button));

    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });
});
