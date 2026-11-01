import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  review: vi.fn(),
  workspace: vi.fn(),
  queue: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyPrescriptions: {
      workspace: { useQuery: mocks.workspace },
      refillReminderReviews: { useQuery: mocks.queue },
      captureRefillReminderForReview: {
        useMutation: () => ({ mutate: mocks.capture, reset: vi.fn(), isPending: false }),
      },
      reviewRefillReminder: {
        useMutation: () => ({ mutate: mocks.review, reset: vi.fn(), isPending: false }),
      },
    },
  },
}));

import { RefillReviewQueue } from './refill-review-queue';

const draft = {
  captureId: 'capture-a',
  patientId: 'patient-a',
  medicineName: 'Example',
  reminderAt: new Date('2026-10-24'),
  expectedExhaustionAt: new Date('2026-10-27'),
  status: 'DRAFT',
  dispatchStatus: null,
  dispatchError: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockReturnValue({
    data: {
      branches: [
        { id: 'branch-a', name: 'Branch A' },
        { id: 'branch-b', name: 'Branch B' },
      ],
      prescriptions: [
        {
          patient: { displayName: 'Example patient' },
          lines: [
            {
              medicine: { productName: 'Example' },
              fills: [
                { id: 'fill-a', quantityCanonicalUnits: 10, dispensedAt: new Date('2026-10-17') },
              ],
            },
          ],
        },
      ],
    },
    isLoading: false,
    isFetching: false,
  });
  mocks.queue.mockImplementation(({ branchId }) => ({
    data: branchId === 'branch-a' ? [draft] : [],
    refetch: vi.fn(),
    isLoading: false,
  }));
});
afterEach(cleanup);

describe('G9 mock-only review UI', () => {
  it('captures using one stable retry key and only branch/fill/directions inputs', () => {
    render(<RefillReviewQueue />);
    fireEvent.change(screen.getByLabelText('Dispensed prescription fill'), {
      target: { value: 'fill-a' },
    });
    fireEvent.change(screen.getByLabelText('Urdu directions'), {
      target: { value: 'روزانہ ایک گولی' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Capture for review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture for review' }));
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(mocks.capture.mock.calls[0]).toEqual(mocks.capture.mock.calls[1]);
    expect(mocks.capture.mock.calls[0][0]).toEqual({
      branchId: 'branch-a',
      fillId: 'fill-a',
      directionsUrdu: 'روزانہ ایک گولی',
      idempotencyKey: expect.stringMatching(/^refill-review:/),
    });
  });

  it('offers only approval/skip, not a provider send or a second dispatcher', () => {
    render(<RefillReviewQueue />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve mock schedule' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(mocks.review).toHaveBeenNthCalledWith(1, {
      branchId: 'branch-a',
      captureId: 'capture-a',
      decision: 'APPROVED',
    });
    expect(mocks.review).toHaveBeenNthCalledWith(2, {
      branchId: 'branch-a',
      captureId: 'capture-a',
      decision: 'SKIPPED',
    });
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
  });

  it('clears selection and removes the old branch queue when branch changes', () => {
    render(<RefillReviewQueue />);
    fireEvent.change(screen.getByLabelText('Dispensed prescription fill'), {
      target: { value: 'fill-a' },
    });
    fireEvent.change(screen.getByLabelText('Urdu directions'), { target: { value: 'روزانہ' } });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    expect(screen.getByLabelText('Dispensed prescription fill')).toHaveValue('');
    expect(screen.getByLabelText('Urdu directions')).toHaveValue('');
    expect(screen.queryByText(/Patient patient-a/)).not.toBeInTheDocument();
    expect(mocks.queue).toHaveBeenLastCalledWith({ branchId: 'branch-b' }, { enabled: true });
    expect(screen.getByRole('button', { name: 'Capture for review' })).toBeDisabled();
  });

  it('shows mock outcome without reoffering a terminal review', () => {
    mocks.queue.mockReturnValue({
      data: [
        { ...draft, status: 'APPROVED', dispatchStatus: 'IGNORED', dispatchError: 'MOCK_PREPARED' },
      ],
      refetch: vi.fn(),
      isLoading: false,
    });
    render(<RefillReviewQueue />);
    expect(screen.getByText('Mock dispatch: IGNORED · MOCK_PREPARED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve mock schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
  });
});
