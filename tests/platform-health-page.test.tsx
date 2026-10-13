import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthSnapshot } from '@/app/platform/(console)/health/snapshot';
import HealthError from '@/app/platform/(console)/health/error';
import HealthLoading from '@/app/platform/(console)/health/loading';
const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('platform health snapshot states', () => {
  it('labels stale snapshots and refreshes through the existing router', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T02:00:00Z'));
    const { rerender } = render(<HealthSnapshot observedAt="2026-10-02T02:00:00Z" />);
    expect(screen.queryByText('Stale snapshot — refresh')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(130_000));
    expect(screen.getByText('Stale snapshot — refresh')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh snapshot' }));
    expect(navigation.refresh).toHaveBeenCalledOnce();
    rerender(<HealthSnapshot observedAt={new Date().toISOString()} />);
    expect(screen.queryByText('Stale snapshot — refresh')).not.toBeInTheDocument();
  });
  it('exposes loading status and an actionable safe error without internal details', () => {
    const { unmount } = render(<HealthLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading queue');
    unmount();
    const retry = vi.fn();
    render(<HealthError error={new Error('private-database-detail')} unstable_retry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText('private-database-detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
