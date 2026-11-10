import { cleanup, fireEvent, render, screen, act, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  proposals: {
    data: [] as Array<{ id: string; payload: unknown; targetMedicine: null }> | undefined,
    isPending: false,
    error: null as { message: string; data?: { code: string } } | null,
    refetch: vi.fn(),
  },
  candidates: { data: [] as unknown[], refetch: vi.fn() },
  confirm: vi.fn(),
  publish: vi.fn(),
  review: vi.fn(),
  invalidateProposals: vi.fn(),
  invalidateCandidates: vi.fn(),
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
    useUtils: () => ({
      pharmacyMedicine: {
        referenceConnectorProposals: { invalidate: mocks.invalidateProposals },
        referenceCandidates: { invalidate: mocks.invalidateCandidates },
      },
    }),
    pharmacyMedicine: {
      referenceCandidates: { useQuery: () => mocks.candidates },
      referenceConnectorProposals: { useQuery: () => mocks.proposals },
      decideReferenceConnectorProposal: {
        useMutation: (options: { onSuccess: () => Promise<void> }) => {
          mocks.onConfirmed = options.onSuccess;
          return { mutateAsync: mocks.confirm, isPending: false, error: mocks.confirmError };
        },
      },
      runReferenceConnectorNow: {
        useMutation: () => ({ mutateAsync: mocks.runNow, isPending: false }),
      },
      recordReviewDecision: {
        useMutation: () => ({ mutateAsync: mocks.review, isPending: false }),
      },
      publishAssertions: {
        useMutation: () => ({ mutateAsync: mocks.publish, isPending: false }),
      },
    },
  },
}));
import { MedicineReferenceWorkbench } from './medicine-reference-workbench';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.proposals.data = [];
  mocks.proposals.isPending = false;
  mocks.proposals.error = null;
  mocks.candidates.data = [];
  mocks.confirmError = null;
  mocks.runNow.mockReset();
  mocks.confirm.mockReset();
  mocks.review.mockReset();
  mocks.publish.mockReset();
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
  expect(mocks.invalidateProposals).toHaveBeenCalledOnce();
  expect(mocks.invalidateCandidates).toHaveBeenCalledOnce();
});
it('keeps only the confirming proposal disabled while its command is pending', async () => {
  mocks.proposals.data = [
    proposal,
    {
      id: 'proposal-b',
      payload: { values: { productName: 'Second OTC' } },
      targetMedicine: null,
    },
  ];
  let settle: () => void = () => undefined;
  mocks.confirm.mockImplementationOnce(
    () => new Promise<void>((resolve) => (settle = () => resolve()))
  );
  render(<MedicineReferenceWorkbench health={[]} />);
  const [first, second] = screen.getAllByRole('button', { name: 'Confirm reference proposal' });
  fireEvent.click(first!);
  expect(await screen.findByRole('button', { name: 'Confirming…' })).toBeDisabled();
  expect(second).toBeEnabled();
  expect(screen.getAllByRole('button', { name: 'Confirm reference proposal' })).toHaveLength(1);
  fireEvent.click(second!);
  expect(mocks.confirm).toHaveBeenLastCalledWith({
    proposalId: 'proposal-b',
    decision: 'CONFIRM',
  });
  await act(async () => settle());
  expect(screen.queryByRole('button', { name: 'Confirming…' })).not.toBeInTheDocument();
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
it('explains a missing catalogue-review grant instead of a generic denial', () => {
  mocks.proposals.error = {
    message: 'You do not have permission for this action.',
    data: { code: 'FORBIDDEN' },
  };
  render(<MedicineReferenceWorkbench health={[]} />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    'needs the pharmacy:catalogue-review permission granted to your role by name'
  );
  expect(screen.getByRole('alert')).toHaveTextContent('pharmacy:* do not include it');
});
it('preserves the proposal and announces a failed confirmation', () => {
  mocks.proposals.data = [proposal];
  mocks.confirmError = { message: 'Proposal already has a decision.' };
  render(<MedicineReferenceWorkbench health={[]} />);
  expect(screen.getByRole('heading', { name: 'Synthetic OTC' })).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Proposal already has a decision.');
});

function candidate(id: string, statuses: string[]) {
  return {
    id,
    productName: `Candidate ${id}`,
    provenance: statuses.map((status, index) => ({
      id: `${id}-assertion-${index}`,
      field: 'productName',
      status,
      assertedValue: { value: `Candidate ${id}`, batchId: 'batch', rowSourceKey: `row-${index}` },
    })),
  };
}

it('records review decisions per candidate and keeps other candidates usable', async () => {
  mocks.candidates.data = [candidate('a', ['UNREVIEWED']), candidate('b', ['UNREVIEWED'])];
  let settle: () => void = () => undefined;
  mocks.review.mockImplementationOnce(
    () => new Promise<void>((resolve) => (settle = () => resolve()))
  );
  render(<MedicineReferenceWorkbench health={[]} />);
  const [cardA, cardB] = screen.getAllByRole('article');
  fireEvent.click(within(cardA!).getByRole('button', { name: 'accept' }));
  expect(mocks.review).toHaveBeenCalledWith({
    duplicateKey: 'reference:a',
    action: 'ACCEPT',
    medicineIds: ['a'],
    payload: { assertionIds: ['a-assertion-0'] },
  });
  await waitFor(() =>
    expect(within(cardA!).getByRole('button', { name: 'reject' })).toBeDisabled()
  );
  for (const action of ['accept', 'reject', 'defer']) {
    expect(within(cardB!).getByRole('button', { name: action })).toBeEnabled();
  }
  fireEvent.click(within(cardB!).getByRole('button', { name: 'defer' }));
  expect(mocks.review).toHaveBeenLastCalledWith(
    expect.objectContaining({ action: 'DEFER', medicineIds: ['b'] })
  );
  await act(async () => settle());
  expect(within(cardA!).getByRole('button', { name: 'reject' })).toBeEnabled();
});

it('says why review and publish controls are unavailable', () => {
  mocks.candidates.data = [candidate('reviewed', ['ACCEPTED']), candidate('fresh', ['UNREVIEWED'])];
  render(<MedicineReferenceWorkbench health={[]} />);
  const [reviewed, fresh] = screen.getAllByRole('article');
  for (const action of ['accept', 'reject', 'defer']) {
    const button = within(reviewed!).getByRole('button', { name: action });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      expect.stringContaining('Every assertion on this candidate already has a review decision')
    );
  }
  expect(within(reviewed!).getByRole('button', { name: 'Publish assertions' })).toBeEnabled();
  const publish = within(fresh!).getByRole('button', { name: 'Publish assertions' });
  expect(publish).toBeDisabled();
  expect(publish).toHaveAccessibleDescription(
    'Publish becomes available after at least one assertion is accepted.'
  );
  expect(within(fresh!).getByRole('button', { name: 'accept' })).toBeEnabled();
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

it('invalidates both review queues after an import so new proposals appear', async () => {
  mocks.runNow.mockResolvedValue(completed);
  fireEvent.click(await chooseAndPreview(3));
  await waitFor(() => expect(mocks.invalidateProposals).toHaveBeenCalledOnce());
  expect(mocks.invalidateCandidates).toHaveBeenCalledOnce();
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
