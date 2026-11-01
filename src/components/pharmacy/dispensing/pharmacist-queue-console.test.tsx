import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queue: {
    data: { currentUserId: 'pharmacist', items: [] as unknown[] },
    isLoading: false,
    isFetching: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  decide: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyDispensing: { reviewQueue: { invalidate: vi.fn() } } }),
    pharmacyDispensing: {
      reviewQueue: { useQuery: () => mocks.queue },
      decideReview: { useMutation: () => mocks.decide },
    },
  },
}));

import { PharmacistQueueConsole } from './pharmacist-queue-console';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queue.isFetching = false;
  mocks.queue.data = { currentUserId: 'pharmacist', items: [] };
});
afterEach(cleanup);

describe('pharmacist queue empty state', () => {
  it('explains where review lines come from and links to their sources', () => {
    render(<PharmacistQueueConsole />);
    expect(screen.getByRole('heading', { name: 'Queue clear' })).toBeVisible();
    expect(screen.getByText(/counter sells a prescription-only medicine/i)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open prescriptions' })).toHaveAttribute(
      'href',
      '/pharmacy/prescriptions'
    );
    expect(screen.getByRole('link', { name: 'Open counter' })).toHaveAttribute(
      'href',
      '/pharmacy/counter'
    );
  });

  it('refreshes the queue on request', () => {
    render(<PharmacistQueueConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh queue' }));
    expect(mocks.queue.refetch).toHaveBeenCalledTimes(1);
  });

  it('disables refresh while a refresh is running', () => {
    mocks.queue.isFetching = true;
    render(<PharmacistQueueConsole />);
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
  });
});
