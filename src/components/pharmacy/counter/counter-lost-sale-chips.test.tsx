import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CounterLostSaleChips, LOST_SALE_CHIPS } from './counter-lost-sale-chips';

afterEach(() => {
  vi.useRealTimers();
});

describe('DEV-81 counter lost-sale chips', () => {
  it('offers the five outcomes and records one with a single tap', () => {
    const onChoose = vi.fn();
    render(<CounterLostSaleChips requested="Panadol" onChoose={onChoose} onDismiss={vi.fn()} />);
    expect(LOST_SALE_CHIPS.map((chip) => chip.label)).toEqual([
      'Substitute taken',
      'Will return',
      'Went elsewhere',
      'Ordered for customer',
      'Unknown',
    ]);
    for (const chip of LOST_SALE_CHIPS) {
      expect(screen.getByRole('button', { name: chip.label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Went elsewhere' }));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith({ outcome: 'WENT_ELSEWHERE' });
  });

  it('is non-modal and closes as Unknown after five seconds without a tap', () => {
    vi.useFakeTimers();
    const onChoose = vi.fn();
    const onDismiss = vi.fn();
    render(
      <>
        <button type="button">Tender</button>
        <CounterLostSaleChips requested="Panadol" onChoose={onChoose} onDismiss={onDismiss} />
      </>
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tender' })).toBeEnabled();
    act(() => vi.advanceTimersByTime(4999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('pauses the timer for notify-when-back and sends the opted-in phone', () => {
    vi.useFakeTimers();
    const onChoose = vi.fn();
    const onDismiss = vi.fn();
    render(<CounterLostSaleChips requested="Panadol" onChoose={onChoose} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('switch'));
    act(() => vi.advanceTimersByTime(10_000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Customer phone'), {
      target: { value: '0300-123 4567' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Will return' }));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith({
      outcome: 'WILL_RETURN',
      notifyOptIn: true,
      notifyPhone: '03001234567',
    });
  });
});
