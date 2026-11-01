import { cleanup, fireEvent, render, screen, act, waitFor } from '@testing-library/react';
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
  runNow: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('./medicine-pack-setup', () => ({ MedicinePackSetup: () => null }));
vi.mock('@/lib/browser-uuid', () => ({ browserUuid: () => 'file-batch' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
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
