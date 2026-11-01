import { cleanup, fireEvent, render, screen, act, waitFor, within } from '@testing-library/react';
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
  runNow: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('./medicine-pack-setup', () => ({ MedicinePackSetup: () => null }));
vi.mock('@/lib/browser-uuid', () => ({ browserUuid: () => 'file-batch' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
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
      runReferenceConnectorNow: {
        useMutation: () => ({ mutateAsync: mocks.runNow, isPending: false }),
      },
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
  mocks.runNow.mockReset();
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

function referenceCsv(count: number) {
  const lines = ['productName,strength,dosageForm,pack'];
  for (let index = 0; index < count; index += 1) lines.push(`Medicine ${index},500 mg,Tablet,10`);
  return new File([lines.join('\n')], 'large.csv', { type: 'text/csv' });
}
const completed = {
  status: 'COMPLETED',
  noOp: false,
  proposalRows: 0,
  rowsApplied: 0,
  rowsRejected: 0,
  rowsSkipped: 0,
};
type RunInput = { batchId: string; rows: Array<{ batchId: string }> };
const sentBatchIds = () => mocks.runNow.mock.calls.map(([input]) => (input as RunInput).batchId);

async function chooseAndPreview(count: number) {
  render(<MedicineReferenceWorkbench health={[]} />);
  fireEvent.change(screen.getByLabelText('CSV or Excel workbook'), {
    target: { files: [referenceCsv(count)] },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Preview normalized rows' }));
  return screen.findByRole('button', { name: `Run ${count} rows now` });
}

it('uploads a 1,200-row file as three sequential parts of at most 500 rows', async () => {
  const pending: Array<(value: typeof completed) => void> = [];
  mocks.runNow.mockImplementation(
    () => new Promise((resolve) => pending.push(resolve as (value: typeof completed) => void))
  );
  fireEvent.click(await chooseAndPreview(1_200));

  for (let part = 1; part <= 3; part += 1) {
    await waitFor(() => expect(mocks.runNow).toHaveBeenCalledTimes(part));
    expect(screen.getByRole('status')).toHaveTextContent(`Uploading part ${part} of 3`);
    await act(async () => {
      await Promise.resolve();
    });
    // The next part is not sent until this one resolves.
    expect(mocks.runNow).toHaveBeenCalledTimes(part);
    await act(async () => pending[part - 1]!(completed));
  }

  expect(await screen.findByText('All 3 parts uploaded.')).toBeVisible();
  expect(mocks.runNow).toHaveBeenCalledTimes(3);
  expect(sentBatchIds()).toEqual(['file-batch-p01', 'file-batch-p02', 'file-batch-p03']);
  const inputs = mocks.runNow.mock.calls.map(([input]) => input as RunInput);
  expect(inputs.map((input) => input.rows.length)).toEqual([500, 500, 200]);
  for (const input of inputs) {
    expect(input.rows.every((row) => row.batchId === input.batchId)).toBe(true);
  }
});

it('stops at a failed part and resumes from it without resending earlier parts', async () => {
  mocks.runNow
    .mockResolvedValueOnce(completed)
    .mockRejectedValueOnce(new Error('Network unavailable'));
  fireEvent.click(await chooseAndPreview(1_200));

  const resume = await screen.findByRole('button', { name: 'Resume from part 2' });
  expect(screen.getByRole('alert')).toHaveTextContent('Part 2 of 3 failed: Network unavailable');
  expect(sentBatchIds()).toEqual(['file-batch-p01', 'file-batch-p02']);

  mocks.runNow.mockResolvedValue(completed);
  fireEvent.click(resume);

  expect(await screen.findByText('All 3 parts uploaded.')).toBeVisible();
  expect(sentBatchIds()).toEqual([
    'file-batch-p01',
    'file-batch-p02',
    'file-batch-p02',
    'file-batch-p03',
  ]);
  expect(screen.queryByRole('button', { name: /Resume from part/ })).not.toBeInTheDocument();
});

it('rejects a file above 20,000 rows before any upload', async () => {
  render(<MedicineReferenceWorkbench health={[]} />);
  fireEvent.change(screen.getByLabelText('CSV or Excel workbook'), {
    target: { files: [referenceCsv(20_001)] },
  });
  await waitFor(() =>
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining('A reference file is limited to 20,000 rows')
    )
  );
  expect(
    screen.queryByRole('button', { name: 'Preview normalized rows' })
  ).not.toBeInTheDocument();
  expect(mocks.runNow).not.toHaveBeenCalled();
});
