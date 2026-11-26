import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyDispensing: { reviewQueue: { invalidate: vi.fn() } } }),
    pharmacyDispensing: {
      reviewQueue: {
        useQuery: () => ({
          isLoading: false,
          error: null,
          data: { items: queue.items, currentUserId: 'user' },
        }),
      },
      decideReview: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));

import { PharmacistQueueConsole } from './pharmacist-queue-console';

afterEach(() => {
  cleanup();
  queue.items = [];
});

describe('pharmacist queue empty state', () => {
  it('explains what appears in the queue and links to the Counter', () => {
    render(<PharmacistQueueConsole />);

    expect(screen.getByRole('heading', { name: 'Queue clear' })).toBeInTheDocument();
    expect(
      screen.getByText(/Review records link prescription lines to sale lines/)
    ).toHaveTextContent('Controlled sales recorded at the Counter create a review record here.');
    expect(screen.getByRole('link', { name: 'Go to Counter' })).toHaveAttribute(
      'href',
      '/pharmacy/counter'
    );
  });
});

it('labels a hidden patient name in both the waiting list and selected review', () => {
  queue.items = [
    {
      id: 'review-1',
      requestedByUserId: 'another-pharmacist',
      decisions: [],
      line: {
        medicine: { productName: 'Synthetic tablet' },
        directions: 'Take with water',
        prescription: {
          patient: { displayName: null },
          prescriber: { name: 'Synthetic prescriber' },
        },
      },
    },
  ];
  render(<PharmacistQueueConsole />);
  expect(screen.getAllByText('Patient name hidden')).toHaveLength(2);
});
