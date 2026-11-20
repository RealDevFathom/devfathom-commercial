import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  queue: {
    data: [] as unknown[],
    isPending: false,
    error: null as null | { message: string },
  },
  search: {
    data: [{ id: 'medicine', productName: 'Fixture lotion' }],
    isFetching: false,
    error: null,
  },
  access: {
    data: { canEdit: true, canDecide: true, ownerPinApproval: false, isOwner: false } as
      | undefined
      | { canEdit: boolean; canDecide: boolean; ownerPinApproval: boolean; isOwner: boolean },
  },
  decide: { mutate: vi.fn(), isPending: false, error: null },
  propose: { mutate: vi.fn(), isPending: false, error: null, isSuccess: false },
  onSuccess: undefined as
    undefined | ((result?: { id: string; status: string; staleEdits: number }) => Promise<void>),
  onError: undefined as undefined | (() => void),
  invalidate: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyMedicine: { catalogueEdits: { invalidate: m.invalidate } },
    }),
    pharmacyMedicine: {
      catalogueEdits: { useQuery: () => m.queue },
      catalogueQueueAccess: { useQuery: () => m.access },
      search: { useQuery: () => m.search },
      decideCatalogueEdit: {
        useMutation: (options: {
          onSuccess: (result?: { id: string; status: string; staleEdits: number }) => Promise<void>;
          onError: () => void;
        }) => {
          m.onSuccess = options.onSuccess;
          m.onError = options.onError;
          return m.decide;
        },
      },
      proposeCatalogueEdit: { useMutation: () => m.propose },
    },
  },
}));
import { CatalogueApprovalQueue } from './catalogue-approval-queue';
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  m.queue.isPending = false;
  m.queue.error = null;
  m.decide.isPending = false;
  m.access.data = { canEdit: true, canDecide: true, ownerPinApproval: false, isOwner: false };
  m.queue.data = [
    {
      id: 'edit',
      operation: 'UPDATE_MEDICINE',
      medicine: { productName: 'Fixture lotion' },
      editor: { name: 'Editor' },
      changes: { productName: 'Reviewed lotion' },
      targets: [],
    },
  ];
});
describe('DEV-19 catalogue queue permissions', () => {
  it('hides the decision controls from an editor without the review permission and says why', () => {
    m.access.data = { canEdit: true, canDecide: false, ownerPinApproval: false, isOwner: false };
    render(<CatalogueApprovalQueue />);
    expect(screen.getByRole('heading', { name: 'Fixture lotion' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject edit' })).toBeNull();
    expect(screen.queryByLabelText('Solo owner PIN (for self-approval)')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('needs the catalogue review permission');
    expect(screen.getByRole('button', { name: 'Submit edit for review' })).toBeVisible();
  });
  it('does not tell the owner to ask the owner when another member reviews', () => {
    m.access.data = { canEdit: true, canDecide: false, ownerPinApproval: false, isOwner: true };
    render(<CatalogueApprovalQueue />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Another member holds the catalogue review permission');
    expect(note).not.toHaveTextContent('Ask the owner');
    expect(screen.queryByRole('button', { name: 'Approve edit' })).toBeNull();
  });
  it('lets a reviewer who cannot edit decide without offering the edit form', () => {
    m.access.data = { canEdit: false, canDecide: true, ownerPinApproval: false, isOwner: false };
    render(<CatalogueApprovalQueue />);
    expect(screen.getByRole('button', { name: 'Approve edit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject edit' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Submit edit for review' })).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });
  it('offers no controls until the permissions are known', () => {
    m.access.data = undefined;
    render(<CatalogueApprovalQueue />);
    expect(screen.queryByRole('button', { name: 'Approve edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit edit for review' })).toBeNull();
  });
});
describe('DEV-766 catalogue approval queue', () => {
  it('shows the item, editor and proposed changes with a visible pending status', () => {
    render(<CatalogueApprovalQueue />);
    expect(screen.getByRole('heading', { name: 'Fixture lotion' })).toBeVisible();
    expect(screen.getByText('Submitted by Editor')).toBeVisible();
    expect(screen.getByText('Product name')).toBeVisible();
    expect(screen.getByText('Reviewed lotion')).toBeVisible();
    expect(screen.getByText('Pending review')).toBeVisible();
  });
  it('submits a selected item name for review without publishing it', () => {
    render(<CatalogueApprovalQueue />);
    expect(screen.getByRole('button', { name: 'Submit edit for review' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Catalogue item'), {
      target: { value: 'medicine' },
    });
    fireEvent.change(screen.getByLabelText('Proposed product name'), {
      target: { value: 'New name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit edit for review' }));
    expect(m.propose.mutate).toHaveBeenCalledWith({
      medicineId: 'medicine',
      changes: { productName: 'New name' },
    });
    expect(m.decide.mutate).not.toHaveBeenCalled();
  });
  it('uses the freshly entered PIN for one decision and clears it after success', async () => {
    render(<CatalogueApprovalQueue />);
    const pin = screen.getByLabelText('Solo owner PIN (for self-approval)');
    fireEvent.change(pin, { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve edit' }));
    expect(m.decide.mutate).toHaveBeenCalledWith({
      editId: 'edit',
      decision: 'APPROVE',
      soloPin: '2468',
    });
    await act(async () => {
      await m.onSuccess?.();
    });
    expect(pin).toHaveValue('');
    expect(m.invalidate).toHaveBeenCalledOnce();
  });
  it('clears a refused PIN and disables duplicate decisions while pending', () => {
    const view = render(<CatalogueApprovalQueue />);
    const pin = screen.getByLabelText('Solo owner PIN (for self-approval)');
    fireEvent.change(pin, { target: { value: '9999' } });
    act(() => {
      m.onError?.();
    });
    expect(pin).toHaveValue('');
    m.decide.isPending = true;
    view.rerender(<CatalogueApprovalQueue />);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject edit' })).toBeDisabled();
  });
  it('marks an edit made stale by another approval and refuses to approve it', () => {
    m.queue.data = [
      {
        id: 'stale-edit',
        operation: 'UPDATE_MEDICINE',
        medicine: { productName: 'Fixture lotion' },
        editor: { name: 'Editor' },
        changes: { productName: 'Older proposal' },
        stale: true,
        targets: [],
      },
    ];
    render(<CatalogueApprovalQueue />);
    expect(screen.getByText('Out of date')).toBeVisible();
    expect(screen.queryByText('Pending review')).not.toBeInTheDocument();
    expect(
      screen.getByText(/changed after the edit was submitted, so it can no longer be approved/)
    ).toBeVisible();
    const approve = screen.getByRole('button', { name: 'Approve edit' });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(m.decide.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reject edit' }));
    expect(m.decide.mutate).toHaveBeenCalledWith({ editId: 'stale-edit', decision: 'REJECT' });
  });
  it('names the pack a barcode edit attaches to instead of hiding its id', () => {
    m.queue.data = [
      {
        id: 'barcode-edit',
        operation: 'setPackBarcode',
        medicine: { productName: 'Fixture tablets' },
        editor: { name: 'Editor' },
        changes: { json: { packLevelId: 'pack_strip', code: '5012345678900' } },
        stale: false,
        targets: [{ label: 'Pack', value: 'STRIP (10 per pack), 3 x 10 tablets' }],
      },
    ];
    render(<CatalogueApprovalQueue />);
    expect(screen.getByText('Attach pack barcode')).toBeVisible();
    expect(screen.getByText('Pack')).toBeVisible();
    expect(screen.getByText('STRIP (10 per pack), 3 x 10 tablets')).toBeVisible();
    expect(screen.getByText('5012345678900')).toBeVisible();
    expect(screen.queryByText('pack_strip')).not.toBeInTheDocument();
  });
  it('shows a queued pack price with its MRP, selling price and branch (DEV-923)', () => {
    m.queue.data = [
      {
        id: 'price-edit',
        operation: 'setPackPrice',
        medicine: { productName: 'Fixture tablets' },
        editor: { name: 'Editor' },
        changes: {
          json: { packLevelId: 'pack_strip', mrpMinor: 50000, sellingPriceMinor: null },
        },
        stale: false,
        targets: [
          { label: 'Pack', value: 'STRIP (10 per pack), 3 x 10 tablets' },
          { label: 'Applies to', value: 'All branches' },
        ],
      },
    ];
    render(<CatalogueApprovalQueue />);
    expect(screen.getByText('Set pack price')).toBeVisible();
    expect(screen.getByText('MRP')).toBeVisible();
    expect(screen.getByText('Rs 500.00')).toBeVisible();
    expect(screen.queryByText('50000')).not.toBeInTheDocument();
    expect(screen.getByText('Selling price')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/paisa/i);
    expect(screen.getByText('Sell at MRP')).toBeVisible();
    expect(screen.getByText('All branches')).toBeVisible();
    expect(screen.queryByText('pack_strip')).not.toBeInTheDocument();
  });
  it('shows every queued catalogue price in rupees with two decimals, never paisa (DEV-722)', () => {
    m.queue.data = [
      {
        id: 'retail-edit',
        operation: 'UPDATE_MEDICINE',
        medicine: { productName: 'Fixture lotion' },
        editor: { name: 'Editor' },
        changes: { retailPriceMinor: 12550 },
        stale: false,
        targets: [],
      },
      {
        id: 'mrp-edit',
        operation: 'recordPrintedMrp',
        medicine: { productName: 'Fixture tablets' },
        editor: { name: 'Editor' },
        changes: { json: { printedMrpMinor: 5, roundingIncrementMinor: 100 } },
        stale: false,
        targets: [],
      },
      {
        id: 'sell-edit',
        operation: 'setPackPrice',
        medicine: { productName: 'Fixture syrup' },
        editor: { name: 'Editor' },
        changes: { json: { mrpMinor: 100000000, sellingPriceMinor: 99999 } },
        stale: false,
        targets: [],
      },
    ];
    render(<CatalogueApprovalQueue />);
    expect(screen.getByText('Retail price')).toBeVisible();
    expect(screen.getByText('Rs 125.50')).toBeVisible();
    expect(screen.getByText('Printed MRP')).toBeVisible();
    expect(screen.getByText('Rs 0.05')).toBeVisible();
    expect(screen.getByText('Rounding increment')).toBeVisible();
    expect(screen.getByText('Rs 1.00')).toBeVisible();
    expect(screen.getByText('Rs 1000000.00')).toBeVisible();
    expect(screen.getByText('Rs 999.99')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/paisa|12550|99999/i);
  });
  it('shows a bulk creation by file, count and upload time, never the file hash (DEV-912)', () => {
    m.queue.data = [
      {
        id: 'bulk-edit',
        operation: 'createStagedMedicines',
        medicine: { productName: 'New medicines from an imported file' },
        editor: { name: 'Editor' },
        changes: {
          json: {
            batchId: 'batch_1',
            fileName: 'abuzar-products.csv',
            uploadedAt: '2026-11-18T07:00:00.000Z',
            sourceSha256: 'a'.repeat(64),
            medicines: 18999,
          },
        },
        stale: false,
        targets: [],
      },
    ];
    render(<CatalogueApprovalQueue />);
    expect(screen.getByText('Create medicines from an imported file')).toBeVisible();
    expect(screen.getByText('abuzar-products.csv')).toBeVisible();
    expect(screen.getByText('18999')).toBeVisible();
    expect(screen.getByText('Uploaded')).toBeVisible();
    expect(screen.queryByText('a'.repeat(64))).not.toBeInTheDocument();
    expect(screen.queryByText(/SHA/)).not.toBeInTheDocument();
    expect(screen.queryByText('batch_1')).not.toBeInTheDocument();
  });
  it('says how many other pending edits an approval made stale', async () => {
    render(<CatalogueApprovalQueue />);
    await act(async () => {
      await m.onSuccess?.({ id: 'edit', status: 'APPROVED', staleEdits: 2 });
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Edit approved. 2 other pending edits on this item are now out of date and must be rejected and resubmitted.'
    );
    await act(async () => {
      await m.onSuccess?.({ id: 'edit', status: 'APPROVED', staleEdits: 1 });
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Edit approved. 1 other pending edit on this item is now out of date'
    );
  });
  it('refreshes the queue after a refused decision so a stale edit is flagged', () => {
    render(<CatalogueApprovalQueue />);
    act(() => {
      m.onError?.();
    });
    expect(m.invalidate).toHaveBeenCalledOnce();
  });
  it('distinguishes loading, empty and permission-denied states', () => {
    m.queue.data = [];
    m.queue.isPending = true;
    const view = render(<CatalogueApprovalQueue />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading catalogue edits');
    expect(screen.queryByText('No catalogue edits are awaiting review.')).not.toBeInTheDocument();
    m.queue.isPending = false;
    view.rerender(<CatalogueApprovalQueue />);
    expect(screen.getByText('No catalogue edits are awaiting review.')).toBeVisible();
    m.queue.error = {
      message: 'Catalogue administration permission required.',
    };
    view.rerender(<CatalogueApprovalQueue />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Catalogue administration permission required.'
    );
    expect(screen.queryByText('No catalogue edits are awaiting review.')).not.toBeInTheDocument();
  });
});
