import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CounterDemandCapture } from './counter-demand-capture';

afterEach(() => vi.useRealTimers());

describe('counter demand outcome capture', () => {
  it('keeps an explicitly selected basket outcome when Unknown is saved automatically', async () => {
    vi.useFakeTimers();
    const capture = vi.fn().mockResolvedValue(true);
    render(
      <CounterDemandCapture
        disabled={false}
        units={3}
        hasBasket
        onArm={() => 'visit-a'}
        onCapture={capture}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Capture shortfall/ }));
    fireEvent.change(screen.getByLabelText('Basket outcome'), { target: { value: 'PARTIAL' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith('visit-a', 'UNKNOWN', {
      notifyOptIn: false,
      visitType: 'PARTIAL',
    });
  });

  it('shows loading and prevents duplicate saves while the request is pending', async () => {
    let finish!: (value: boolean) => void;
    const capture = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    render(
      <CounterDemandCapture
        disabled={false}
        units={3}
        hasBasket
        onArm={() => 'visit-a'}
        onCapture={capture}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Capture shortfall/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Will return' }));
    expect(screen.getByRole('button', { name: 'Capturing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Went elsewhere' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Went elsewhere' }));
    expect(capture).toHaveBeenCalledOnce();
    await act(async () => finish(true));
  });

  it('preserves invalid notification input and cancels the default once an outcome is chosen', async () => {
    vi.useFakeTimers();
    const capture = vi.fn().mockResolvedValue(true);
    render(
      <CounterDemandCapture
        disabled={false}
        units={3}
        hasBasket
        onArm={() => 'visit-a'}
        onCapture={capture}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Capture shortfall/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Notify when back/ }));
    fireEvent.change(screen.getByLabelText('Notification phone'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Will return' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(capture).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a phone number');
    expect(screen.getByLabelText('Notification phone')).toHaveValue('123');
  });

  it('defaults to Unknown after five seconds even after dismissal, and never auto-submits PII', async () => {
    vi.useFakeTimers();
    const capture = vi.fn().mockResolvedValue(true);
    render(
      <CounterDemandCapture
        disabled={false}
        units={3}
        hasBasket
        onArm={() => 'visit-a'}
        onCapture={capture}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Capture shortfall/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Notify when back/ }));
    fireEvent.change(screen.getByLabelText('Notification phone'), {
      target: { value: '03001234567' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(capture).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith('visit-a', 'UNKNOWN', { notifyOptIn: false });
  });

  it('submits explicit opt-in once and clears contact details for the next capture', async () => {
    vi.useFakeTimers();
    const capture = vi.fn().mockResolvedValue(true);
    render(
      <CounterDemandCapture
        disabled={false}
        units={3}
        hasBasket
        onArm={() => 'visit-a'}
        onCapture={capture}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Capture shortfall/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Notify when back/ }));
    fireEvent.change(screen.getByLabelText('Notification phone'), {
      target: { value: '03001234567' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Will return' }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith('visit-a', 'WILL_RETURN', {
      notifyOptIn: true,
      notifyPhone: '03001234567',
      notifyConsentRecorded: true,
    });
    fireEvent.click(screen.getByRole('button', { name: /Capture shortfall/ }));
    expect(screen.getByRole('checkbox', { name: /Notify when back/ })).not.toBeChecked();
    expect(screen.queryByLabelText('Notification phone')).not.toBeInTheDocument();
  });

  it('drops consent but still saves the old default with its original context on a context change', async () => {
    vi.useFakeTimers();
    const capture = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <CounterDemandCapture
        key="branch-a:sale-a:customer-a"
        disabled={false}
        units={3}
        hasBasket
        onArm={() => 'visit-a'}
        onCapture={capture}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Capture shortfall/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Notify when back/ }));
    fireEvent.change(screen.getByLabelText('Notification phone'), {
      target: { value: '03001234567' },
    });
    fireEvent.change(screen.getByLabelText('Basket outcome'), { target: { value: 'WALK_OUT' } });
    rerender(
      <CounterDemandCapture
        key="branch-b:sale-b:customer-b"
        disabled={false}
        units={3}
        hasBasket
        onArm={() => 'visit-b'}
        onCapture={capture}
      />
    );
    // The scan replaced the sheet; the pending Unknown keeps visit A, without PII.
    expect(capture).toHaveBeenCalledExactlyOnceWith('visit-a', 'UNKNOWN', {
      notifyOptIn: false,
      visitType: 'WALK_OUT',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(capture).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /Capture shortfall/ }));
    expect(screen.getByRole('checkbox', { name: /Notify when back/ })).not.toBeChecked();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Went elsewhere' }));
    });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenLastCalledWith('visit-b', 'WENT_ELSEWHERE', { notifyOptIn: false });
  });

  it('does not re-save on unmount once the default or an outcome was saved', async () => {
    vi.useFakeTimers();
    const capture = vi.fn().mockResolvedValue(true);
    const { unmount } = render(
      <CounterDemandCapture
        disabled={false}
        units={3}
        hasBasket
        onArm={() => 'visit-a'}
        onCapture={capture}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Capture shortfall/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    unmount();
    expect(capture).toHaveBeenCalledExactlyOnceWith('visit-a', 'UNKNOWN', { notifyOptIn: false });
  });

  it('has no backdrop and leaves payment clickable while the outcome sheet is open', () => {
    vi.useFakeTimers();
    const tender = vi.fn();
    render(
      <>
        <button onClick={tender}>Take payment</button>
        <CounterDemandCapture
          disabled={false}
          units={3}
          hasBasket={false}
          onArm={() => 'visit-a'}
          onCapture={vi.fn()}
        />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: /Capture shortfall/ }));
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take payment' }));
    expect(tender).toHaveBeenCalledOnce();
  });
});
