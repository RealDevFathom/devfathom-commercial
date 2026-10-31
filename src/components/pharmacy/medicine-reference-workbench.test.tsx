import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  proposals: {
    data: [] as Array<{ id: string; payload: unknown; targetMedicine: null }> | undefined,
    isPending: false,
    error: null as { message: string } | null,
    refetch: vi.fn(),
  },
  candidates: { data: [], refetch: vi.fn() },
  confirm: vi.fn(),
  publish: vi.fn(),
  pending: false,
  confirmError: null as { message: string } | null,
  onConfirmed: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('./medicine-pack-setup', () => ({ MedicinePackSetup: () => null }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyMedicine: {
      referenceCandidates: { useQuery: () => mocks.candidates },
      referenceConnectorProposals: { useQuery: () => mocks.proposals },
      decideReferenceConnectorProposal: {
        useMutation: (options: { onSuccess: () => Promise<void> }) => {
          mocks.onConfirmed = options.onSuccess;
          return { mutate: mocks.confirm, isPending: mocks.pending, error: mocks.confirmError };
        },
      },
      runReferenceConnectorNow: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      recordReviewDecision: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      publishAssertions: { useMutation: () => ({ mutate: mocks.publish, isPending: false }) },
    },
  },
}));
import { MedicineReferenceWorkbench } from './medicine-reference-workbench';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.proposals.data = [];
  mocks.proposals.isPending = false;
  mocks.proposals.error = null;
  mocks.pending = false;
  mocks.confirmError = null;
});
afterEach(cleanup);
const proposal = {
  id: 'proposal',
  payload: { values: { productName: 'Synthetic OTC', strength: '500 mg' } },
  targetMedicine: null,
};

it('confirms the exact proposed draft and refreshes its review queue without publishing it', async () => {
  mocks.proposals.data = [proposal];
  render(<MedicineReferenceWorkbench health={[]} />);
  expect(screen.getByRole('heading', { name: 'Synthetic OTC' })).toBeVisible();
  expect(screen.getByText('500 mg')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm reference proposal' }));
  expect(mocks.confirm).toHaveBeenCalledWith({ proposalId: 'proposal', decision: 'CONFIRM' });
  expect(mocks.publish).not.toHaveBeenCalled();
  await act(async () => {
    await mocks.onConfirmed?.();
  });
  expect(mocks.proposals.refetch).toHaveBeenCalledOnce();
  expect(mocks.candidates.refetch).toHaveBeenCalledOnce();
});
it('keeps confirmation disabled while its command is pending', () => {
  mocks.proposals.data = [proposal];
  mocks.pending = true;
  render(<MedicineReferenceWorkbench health={[]} />);
  expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled();
});
it('names the empty and loading states', () => {
  const view = render(<MedicineReferenceWorkbench health={[]} />);
  expect(screen.getByText('No reference proposals await confirmation.')).toBeVisible();
  mocks.proposals.data = undefined;
  mocks.proposals.isPending = true;
  view.rerender(<MedicineReferenceWorkbench health={[]} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading reference proposals');
});
it('announces permission errors and offers a query retry', () => {
  mocks.proposals.error = { message: 'Catalog approval permission is required.' };
  render(<MedicineReferenceWorkbench health={[]} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Catalog approval permission is required.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry proposals' }));
  expect(mocks.proposals.refetch).toHaveBeenCalledOnce();
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it('preserves the proposal and announces a failed confirmation', () => {
  mocks.proposals.data = [proposal];
  mocks.confirmError = { message: 'Proposal already has a decision.' };
  render(<MedicineReferenceWorkbench health={[]} />);
  expect(screen.getByRole('heading', { name: 'Synthetic OTC' })).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Proposal already has a decision.');
});
