import { cleanup, fireEvent, render, screen, act, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  proposals: {
    data: [] as Array<{ id: string; payload: unknown; targetMedicine: null }> | undefined,
    isPending: false,
    error: null as { message: string } | null,
    refetch: vi.fn(),
  },
  candidates: { data: [] as unknown[], refetch: vi.fn() },
  candidateInputs: [] as unknown[],
  summary: {
    data: {
      awaitingReview: 7,
      copiesAwaitingReview: 6,
      controlledAwaitingReview: 2,
      heldFromSale: 1,
    },
    isError: false,
    isPending: false,
    refetch: vi.fn(),
  },
  draft: vi.fn(),
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
      referenceCandidates: {
        useQuery: (input: unknown) => {
          mocks.candidateInputs.push(input);
          return mocks.candidates;
        },
      },
      catalogueReviewSummary: { useQuery: () => mocks.summary },
      draftCatalogueReview: {
        useMutation: () => ({ mutate: mocks.draft, isPending: false, error: null }),
      },
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
  mocks.candidates.data = [];
  mocks.candidateInputs = [];
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

const catalogueCopy = {
  id: 'med-sosegon',
  productName: 'SOSEGON TAB',
  brandName: 'SOSEGON TAB',
  manufacturer: 'SEARLE PAKISTAN LTD.',
  drapRegistrationNumber: null,
  productFamily: 'PHARMACEUTICAL',
  saleable: false,
  presentations: [{ id: 'p1', dosageForm: 'Tablet', presentation: 'Tablet' }],
  strengths: [],
  aliases: [],
  provenance: [],
  catalogueProvenance: {
    controlledCandidate: true,
    linkedExisting: false,
    sourceKey: 'catalog-2071',
    catalogueKey: 'pharmacy-default',
    catalogueVersion: 1,
    catalogueVersionId: 'v1',
  },
  catalogueItem: { strength: null, dosageForm: 'Tablet', productFamily: 'PHARMACEUTICAL' },
};

it('shows the pharmacist what the default catalogue holds from sale', () => {
  render(<MedicineReferenceWorkbench health={[]} />);
  const status = within(screen.getByRole('region', { name: 'Default catalogue review status' }));
  expect(status.getByText('Awaiting review').nextElementSibling).toHaveTextContent('7');
  expect(status.getByText('NARCOTICS to review').nextElementSibling).toHaveTextContent('2');
  expect(status.getByText('Held from sale').nextElementSibling).toHaveTextContent('1');
});

it('finds default-catalogue medicines through their own review queue and search', () => {
  render(<MedicineReferenceWorkbench health={[]} />);
  // The reference queue is the default, unchanged.
  expect(mocks.candidateInputs.at(-1)).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: /Default catalogue/ }));
  expect(mocks.candidateInputs.at(-1)).toEqual({ view: 'catalogue', query: undefined });
  fireEvent.change(screen.getByLabelText('Search by name or source key'), {
    target: { value: ' sosegon ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(mocks.candidateInputs.at(-1)).toEqual({ view: 'catalogue', query: 'sosegon' });
  fireEvent.click(screen.getByRole('button', { name: /NARCOTICS review/ }));
  expect(mocks.candidateInputs.at(-1)).toEqual({ view: 'controlled', query: 'sosegon' });
});

it('completes a NARCOTICS catalogue copy only with a reviewed controlled decision', () => {
  mocks.candidates.data = [catalogueCopy];
  render(<MedicineReferenceWorkbench health={[]} />);
  const card = within(screen.getByRole('form', { name: 'Complete SOSEGON TAB for review' }));
  expect(screen.getByText('Needs completion')).toBeVisible();
  // Nothing to accept or publish until the review is started.
  expect(screen.queryByRole('button', { name: 'Publish assertions' })).toBeNull();
  expect(card.getByLabelText('Dosage form')).toHaveValue('Tablet');

  fireEvent.click(card.getByRole('button', { name: 'Start review' }));
  expect(mocks.draft).not.toHaveBeenCalled();
  expect(card.getByRole('alert')).toHaveTextContent('Fill in every highlighted field');
  expect(card.getByLabelText('Controlled decision')).toHaveAttribute('aria-invalid', 'true');

  fireEvent.change(card.getByLabelText('Strength'), { target: { value: '25 mg' } });
  fireEvent.change(card.getByLabelText('Pack'), { target: { value: '10 tablets' } });
  fireEvent.change(card.getByLabelText('DRAP registration'), { target: { value: '054321' } });
  fireEvent.change(card.getByLabelText('Controlled decision'), { target: { value: 'true' } });
  fireEvent.click(card.getByRole('button', { name: 'Start review' }));
  expect(mocks.draft).toHaveBeenCalledWith({
    medicineId: 'med-sosegon',
    values: {
      productName: 'SOSEGON TAB',
      strength: '25 mg',
      dosageForm: 'Tablet',
      pack: '10 tablets',
      drapRegistrationNumber: '054321',
      controlled: 'true',
    },
  });
  expect(mocks.publish).not.toHaveBeenCalled();
});

it('reviews a catalogue copy with drafted assertions through the ordinary actions', () => {
  mocks.candidates.data = [
    {
      ...catalogueCopy,
      provenance: [
        {
          id: 'a1',
          field: 'productName',
          status: 'UNREVIEWED',
          assertedValue: { value: 'SOSEGON TAB', batchId: 'b', rowSourceKey: 'catalog-2071' },
        },
      ],
    },
  ];
  render(<MedicineReferenceWorkbench health={[]} />);
  expect(screen.queryByRole('form', { name: /Complete SOSEGON TAB/ })).toBeNull();
  expect(screen.getByText('In review')).toBeVisible();
  expect(screen.getByRole('button', { name: 'accept' })).toBeEnabled();
});
