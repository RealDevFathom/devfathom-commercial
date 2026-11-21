import { selectFieldControl } from '@/lib/testing/select-field';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GrowthReviewPanel } from './growth-review-panel';
import type { GrowthView, GrowthReviewInput } from '@/lib/restaurant/growth-review-contract';
afterEach(cleanup);
const view: GrowthView = {
  status: 'READY',
  insightId: 'insight',
  branchId: 'branch',
  hash: 'a'.repeat(64),
  version: 1,
  reviews: [],
  projection: {
    currency: 'PKR',
    current: { from: '2026-10-01T00:00:00.000Z', cutoff: '2026-10-02T00:00:00.000Z' },
    comparison: { from: '2026-09-30T00:00:00.000Z', cutoff: '2026-10-01T00:00:00.000Z' },
    recommendations: [
      {
        action: 'LOYALTY_REVIEW',
        evidence: [
          {
            key: 'loyalty_eligible_count',
            period: 'CURRENT',
            value: '10',
            unit: 'COUNT',
            coverage: 'PARTIAL',
          },
        ],
      },
    ],
  },
};
it.each(['DENIED', 'UNAVAILABLE', 'INSUFFICIENT_DATA', 'INVALID', 'NOT_FOUND', 'STALE'] as const)(
  'renders honest %s without approval',
  (status) => {
    render(<GrowthReviewPanel view={{ status }} />);
    expect(screen.getByRole('status')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve to draft' })).toBeNull();
  }
);
it('preserves edited priority and requires explicit confirmation', async () => {
  const submit = vi.fn<(input: GrowthReviewInput) => Promise<{ status: 'UNAVAILABLE' }>>(
    async () => ({ status: 'UNAVAILABLE' as const })
  );
  render(<GrowthReviewPanel view={view} onReview={submit} />);
  fireEvent.change(
    selectFieldControl(
      screen.getByLabelText('Review priority', {
        selector: ':not([data-select-field-native][aria-hidden="true"])',
      })
    ),
    { target: { value: 'HIGH' } }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Approve to draft' }));
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm approve' }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][0]).toMatchObject({
    decision: 'APPROVE',
    settings: { priority: 'HIGH' },
  });
});
it('unknown review response reconciles exact request, with no new id', async () => {
  const submit = vi
    .fn()
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue({ status: 'UNAVAILABLE' });
  render(<GrowthReviewPanel view={view} onReview={submit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save reviewed settings' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile review' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1][0]).toEqual(submit.mock.calls[0][0]);
});
it('loading announces state and hides controls', () => {
  render(<GrowthReviewPanel view={view} loading />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading');
  expect(screen.queryByRole('button')).toBeNull();
});

it('marks a deterministic model diagnostic without claiming configured provider proof', () => {
  render(<GrowthReviewPanel view={{ ...view, diagnostic: true }} />);
  expect(screen.getByRole('note')).toHaveTextContent('Configured provider not verified');
});
