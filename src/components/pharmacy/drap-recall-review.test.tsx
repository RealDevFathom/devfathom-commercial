import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyInventory: {
      drapRecallQueue: { useQuery: () => ({ isLoading: true }) },
      confirmDrapRecall: { useMutation: () => ({}) },
      dismissDrapRecall: { useMutation: () => ({}) },
    },
  },
}));

import DrapRecallAlertsPage from '@/app/(app)/pharmacy/inventory/drap-recalls/page';

import { DrapRecallReviewView } from './drap-recall-review';

const alert = {
  registrationNumber: '060235',
  batchNumbers: ['26A059'],
  batchNumbersUnresolved: false,
  reason: '45. Recall Alert — Substandard',
  productName: 'Carapamin Injection 200mg',
  alertNumber: 'I/S/10-26-45',
  sourceUrl: 'https://www.dra.gov.pk/safety_info/product_recalls/recall_alerts/45/',
  documentUrl: 'https://www.dra.gov.pk/wp-content/uploads/2026/11/45.pdf',
  publishedAt: '2026-10-23T15:32:50+05:00',
};
const matched = {
  id: 'ingest-1',
  sourceReference: 'DRAP-WEB:I/S/10-26-45:1',
  adapter: 'DRAP_WEB',
  matchStatus: 'MATCHED' as const,
  reviewStatus: 'PENDING_REVIEW' as const,
  reviewNote: null,
  reviewedAt: null,
  recallNoticeId: null,
  createdAt: new Date('2026-11-15'),
  alert,
  medicine: {
    id: 'med-a',
    productName: 'Dopamine 200mg',
    brandName: 'Carapamin',
    drapRegistrationNumber: '060235',
  },
  candidateMedicines: [],
  batches: [{ id: 'batch-a', batchNumber: '26A059', availableUnits: 12 }],
  candidateBatches: [],
  recallScope: 'BATCH' as const,
};
const unmatched = {
  ...matched,
  id: 'ingest-2',
  matchStatus: 'NO_MATCH' as const,
  medicine: null,
  batches: [],
  recallScope: null,
  alert: { ...alert, registrationNumber: '', productName: 'Mysoline 250mg' },
};
const handlers = () => ({
  onRetry: vi.fn(),
  onConfirm: vi.fn(async () => undefined),
  onDismiss: vi.fn(async () => undefined),
});

describe('DRAP recall review screen', () => {
  it('renders the route with one heading and an accessible loading state', () => {
    render(<DrapRecallAlertsPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('DRAP recall alerts');
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('renders error, permission and empty states', () => {
    const base = handlers();
    const { rerender } = render(<DrapRecallReviewView {...base} error />);
    expect(screen.getByRole('alert')).toHaveTextContent('No stock has been changed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(base.onRetry).toHaveBeenCalled();
    rerender(<DrapRecallReviewView {...base} forbidden />);
    expect(screen.getByRole('alert')).toHaveTextContent('pharmacy safety access');
    rerender(<DrapRecallReviewView {...base} data={{ pending: [], decided: [] }} />);
    expect(screen.getByText(/No DRAP recall alerts are waiting/)).toBeInTheDocument();
  });

  it('shows the evidence and needs an explicit second step before quarantining', async () => {
    const base = handlers();
    render(<DrapRecallReviewView {...base} data={{ pending: [matched], decided: [] }} />);
    expect(screen.getByText('060235')).toBeInTheDocument();
    expect(screen.getByText('12 units available')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open DRAP PDF' })).toHaveAttribute(
      'href',
      alert.documentUrl
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review recall and quarantine' }));
    expect(base.onConfirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: 'Shelf checked' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm recall and quarantine' }));
    await waitFor(() => expect(base.onConfirm).toHaveBeenCalledWith('ingest-1', 'Shelf checked'));
  });

  it('offers no confirm for an unmatched alert and requires a dismissal reason', async () => {
    const base = handlers();
    render(<DrapRecallReviewView {...base} data={{ pending: [unmatched], decided: [] }} />);
    expect(screen.getByText('Not named in the alert')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Review recall and quarantine' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss alert' }));
    const submit = screen.getByRole('button', { name: 'Dismiss alert' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for dismissing'), {
      target: { value: 'Not stocked' },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(base.onDismiss).toHaveBeenCalledWith('ingest-2', 'Not stocked'));
  });

  it('explains an alert whose batches could not be read and offers no confirm', () => {
    render(
      <DrapRecallReviewView
        {...handlers()}
        data={{
          pending: [
            {
              ...unmatched,
              matchStatus: 'AMBIGUOUS',
              alert: { ...unmatched.alert, batchNumbers: [], batchNumbersUnresolved: true },
            },
          ],
          decided: [],
        }}
      />
    );
    expect(screen.getByText(/Named in the DRAP document but not read/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Review recall and quarantine' })
    ).not.toBeInTheDocument();
  });

  it('lists recent decisions with a text label, not colour alone', () => {
    render(
      <DrapRecallReviewView
        {...handlers()}
        data={{
          pending: [],
          decided: [
            {
              ...matched,
              reviewStatus: 'CONFIRMED',
              reviewedAt: new Date('2026-11-15T10:00:00Z'),
              recallNoticeId: 'recall-1',
            },
          ],
        }}
      />
    );
    expect(screen.getByRole('region', { name: 'Recent DRAP recall decisions' })).toHaveTextContent(
      'Recall confirmed'
    );
  });
});
