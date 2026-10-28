import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocks = vi.hoisted(() => ({
  branches: vi.fn(),
  batches: vi.fn(),
  rows: vi.fn(),
  detail: vi.fn(),
  context: vi.fn(),
}));
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
vi.mock('@/components/pharmacy/medicine-reference-workbench', () => ({
  MedicineReferenceWorkbench: () => <div>Existing workbench</div>,
}));
vi.mock('@/components/pharmacy/create-medicine', () => ({
  CreateMedicine: () => <div>Create medicine form</div>,
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
    expect(screen.getByText('Create medicine form')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByText('Preserved import source review').closest('details')
    ).not.toHaveAttribute('open');
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
