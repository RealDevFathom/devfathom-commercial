import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocks = vi.hoisted(() => ({
  branches: vi.fn(),
  batches: vi.fn(),
  rows: vi.fn(),
  detail: vi.fn(),
  context: vi.fn(),
  creation: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/routers/pharmacy-staged-review', () => ({
  pharmacyStagedReviewRouter: {
    createCaller: () => ({
      pharmacyMedicine: {
        stagedBranches: mocks.branches,
        stagedBatches: mocks.batches,
        stagedRows: mocks.rows,
        stagedDetail: mocks.detail,
      },
    }),
  },
}));
vi.mock('@/components/pharmacy/staged-medicine-creation-actions', () => ({
  readStagedMedicineCreation: mocks.creation,
  requestStagedMedicineCreation: vi.fn(),
  runStagedMedicineCreationStep: vi.fn(),
}));
vi.mock('@/components/pharmacy/staged-medicine-creation', () => ({
  StagedMedicineCreation: () => <div>Creation controls</div>,
}));
vi.mock('@/components/pharmacy/medicine-reference-workbench', () => ({
  MedicineReferenceWorkbench: () => <div>Existing workbench</div>,
}));
vi.mock('@/components/pharmacy/add-medicine-form', () => ({
  AddMedicineForm: () => <div>Add medicine form</div>,
}));
vi.mock('@/components/pharmacy/catalogue-approval-queue', () => ({
  CatalogueApprovalQueue: () => <div>Catalogue approval queue</div>,
}));
import MedicinePage from '@/app/(app)/pharmacy/medicines/page';
import Page from '@/app/(app)/pharmacy/medicines/staged/page';
import Loading from '@/app/(app)/pharmacy/medicines/staged/loading';
import ErrorView from '@/app/(app)/pharmacy/medicines/staged/error';
import { stagedReference } from '@/lib/pharmacy/migration/staged-review';
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({ session: { user: { role: 'ADMIN' } } });
  mocks.creation.mockResolvedValue({
    error: 'You need catalogue edit or review permission for this.',
  });
  mocks.branches.mockResolvedValue([{ id: 'branch_a', name: 'Branch A' }]);
  mocks.batches.mockResolvedValue({ batches: [], total: 0 });
  mocks.rows.mockResolvedValue({
    candidateCount: 0,
    total: 0,
    page: 1,
    pageSize: 25,
    rows: [],
    exceptions: [],
  });
});
describe('staged medicine review UI', () => {
  it('shows staged review within the normal medicine catalogue', async () => {
    render(await MedicinePage({}));
    expect(screen.getByRole('heading', { name: 'Medicine catalogue', level: 1 })).toBeTruthy();
    expect(mocks.batches).toHaveBeenCalledWith({ branchId: 'branch_a', page: 1 });
    expect(screen.getByText('Existing workbench')).toBeTruthy();
    expect(screen.getByText('Catalogue approval queue')).toBeVisible();
  });
  it('builds the request context once and starts explicit-selection loads concurrently', async () => {
    let releaseBranches: (value: unknown) => void = () => undefined;
    mocks.branches.mockReturnValue(new Promise((resolve) => (releaseBranches = resolve)));
    const pending = MedicinePage({
      searchParams: Promise.resolve({
        branchId: 'branch_a',
        sourceId: 'source_a',
        batchId: 'batch_a',
      }),
    });
    await vi.waitFor(() => expect(mocks.rows).toHaveBeenCalled());
    expect(mocks.batches).toHaveBeenCalled();
    releaseBranches([{ id: 'branch_a', name: 'Branch A' }]);
    render(await pending);
    expect(mocks.context).toHaveBeenCalledTimes(1);
  });
  it('defaults to an authorized branch and explains workflow states', async () => {
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Staged medicines' })).toBeTruthy();
    expect(screen.getByLabelText('Branch')).toBeTruthy();
    expect(screen.getByText(/Batch, expiry and verified MRP gaps/)).toBeTruthy();
    expect(mocks.batches).toHaveBeenCalledWith({ branchId: 'branch_a', page: 1 });
  });
  it('shows empty results and disables empty export', async () => {
    render(
      await Page({
        searchParams: Promise.resolve({
          branchId: 'branch_a',
          sourceId: 'source_a',
          batchId: 'batch_a',
          rowId: 'row_a',
        }),
      })
    );
    expect(screen.getByText(/No candidates match/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export this page’s references' })).toBeDisabled();
  });
  it('renders preserved quantities as text and accessible detail/pagination links', async () => {
    const row = stagedReference(
      {
        id: 'row_a',
        sourceKey: 'key',
        rowNumber: 1,
        productName: '<script>Example</script>',
        packLabel: null,
        quantityCanonical: null,
        rawPayload: { QTY: '1.0000', PackQty: '1.000000', PackUnits: '1' },
        exceptions: [],
      },
      { id: 'source_a', contentHash: 'a'.repeat(64) },
      'batch_a'
    );
    mocks.detail.mockResolvedValue(row);
    mocks.rows.mockResolvedValue({
      candidateCount: 26,
      total: 26,
      page: 1,
      pageSize: 25,
      rows: [row],
      exceptions: [],
    });
    render(
      await Page({
        searchParams: Promise.resolve({
          branchId: 'branch_a',
          sourceId: 'source_a',
          batchId: 'batch_a',
          rowId: 'row_a',
        }),
      })
    );
    expect(screen.getByText('Source SHA256 recorded on row')).toBeTruthy();
    expect(screen.getByText('Unrecorded source checksum')).toBeTruthy();
    expect(screen.getByText('not recorded (staged as raw count)')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'All open exceptions in this batch' })).toBeTruthy();
    expect(screen.getAllByText('1.0000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1.000000').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: '<script>Example</script>' })).toHaveAttribute(
      'href',
      expect.stringContaining('rowId=row_a')
    );
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      expect.stringContaining('page=2')
    );
    expect(screen.getAllByText('Staged — unverified').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not reviewed yet').length).toBeGreaterThan(0);
    expect(screen.getByText(/waiting for review/)).toBeTruthy();
    expect(screen.getByText(/done by a catalogue editor or reviewer/)).toBeTruthy();
    expect(screen.queryByText(/use “Create medicines” below/)).toBeNull();
    expect(screen.queryByText(/not available on this screen yet/)).toBeNull();
    expect(screen.getByText('MRP (the sale price printed on the pack)')).toBeTruthy();
    expect(screen.getByText('Purchase price (the price you pay the distributor)')).toBeTruthy();
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toContain('Purchase price (from distributor)');
    expect(heads).toContain('MRP');
    expect(heads.join(' ')).not.toMatch(/Source|saleprice|purprice/i);
    const listCells = within(screen.getAllByRole('table')[0]!).getAllByRole('cell');
    expect(listCells.map((c) => c.textContent)).toContain('1');
    expect(within(screen.getAllByRole('table')[0]!).queryByText('1.0000')).toBeNull();
  });
  it('tells a catalogue editor to create medicines and shows plain words, never raw codes', async () => {
    mocks.creation.mockResolvedValue({ data: { candidates: 1 } });
    const row = stagedReference(
      {
        id: 'row_a',
        sourceKey: 'key',
        rowNumber: 1,
        productName: 'Example',
        packLabel: null,
        quantityCanonical: null,
        rawPayload: { QTY: '1', __review_flags: 'NORMALIZED_NAME_COLLISION_NO_MERGE' },
        exceptions: [
          { bucket: 'MISSING_BATCH', status: 'OPEN', severity: 'WARNING' },
          { bucket: 'MISSING_MRP', status: 'SIGNED_OFF', severity: 'BLOCKING' },
        ],
      },
      { id: 'source_a', contentHash: 'a'.repeat(64) },
      'batch_a'
    );
    mocks.detail.mockResolvedValue(row);
    mocks.rows.mockResolvedValue({
      candidateCount: 1,
      total: 1,
      page: 1,
      pageSize: 25,
      rows: [row],
      exceptions: [{ bucket: 'MISSING_BATCH', workflow: 'Opening stock', count: 1 }],
    });
    const { container } = render(
      await Page({
        searchParams: Promise.resolve({
          branchId: 'branch_a',
          sourceId: 'source_a',
          batchId: 'batch_a',
          rowId: 'row_a',
        }),
      })
    );
    expect(screen.getByText(/use “Create medicines” below/)).toBeTruthy();
    expect(screen.getByText(/before you create catalogue medicines/)).toBeTruthy();
    expect(
      screen.getByText('Another medicine has almost the same name: kept separate')
    ).toBeTruthy();
    expect(screen.getByText(/Signed off · Needs your attention/)).toBeTruthy();
    expect(screen.getByText(/Open · Information only/)).toBeTruthy();
    const visible = container.textContent ?? '';
    for (const code of [
      'MISSING_BATCH',
      'MISSING_MRP',
      'NORMALIZED_NAME_COLLISION_NO_MERGE',
      'SIGNED_OFF',
      'BLOCKING',
      'WARNING',
    ])
      expect(visible).not.toContain(code);
    expect(visible).not.toMatch(/\bOPEN\b/);
  });
  it('renders permission denial without candidate content', async () => {
    mocks.branches.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Review permission required' })).toBeTruthy();
    expect(mocks.rows).not.toHaveBeenCalled();
  });
  it('provides loading status and retry error state', () => {
    render(<Loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading');
    cleanup();
    render(<ErrorView unstable_retry={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
