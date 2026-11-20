import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const line = {
  id: 'line-1', rowNumber: 2, productText: 'Panadol 500mg', packText: 'BOX', matchStatus: 'MATCHED',
  medicineName: 'Panadol 500mg', packLevel: 'BOX', listTradePriceMinor: 85000,
  previousTradePriceMinor: 80000, tradeChangeMinor: 5000, tradeChangeBps: 625,
  listMrpMinor: 110000, currentMrpMinor: 100000, mrpChangeMinor: 10000, mrpChangeBps: 1000,
  currentSellingPriceMinor: 95000, draftStatus: 'DRAFT', draftMrpMinor: 110000,
  draftSellingPriceMinor: 95000, tradeAboveMrp: false, tradeChanged: true, mrpChanged: true,
  stale: false,
};
const mocks = vi.hoisted(() => ({
  options: { data: { suppliers: [{ id: 'sup', name: 'Distributor' }] }, isPending: false, error: null as unknown, refetch: vi.fn() },
  list: { data: [{ id: 'list-1', supplierName: 'Distributor', fileName: 'list.csv', createdAt: new Date(), rowCount: 1, matched: 1, alerts: 1, drafts: 1 }], isPending: false, error: null },
  review: { data: null as unknown, isPending: false, error: null },
  upload: { mutateAsync: vi.fn(), isPending: false },
  decide: { mutateAsync: vi.fn(), isPending: false },
  invalidate: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({ trpc: {
  useUtils: () => ({ pharmacySupplierPriceLists: { list: { invalidate: mocks.invalidate }, review: { invalidate: mocks.invalidate } } }),
  pharmacySupplierPriceLists: {
    options: { useQuery: () => mocks.options }, list: { useQuery: () => mocks.list },
    review: { useQuery: () => mocks.review },
    import: { useMutation: () => mocks.upload }, decide: { useMutation: () => mocks.decide },
  },
} }));
import { pkr, SupplierPriceListsConsole } from './supplier-price-lists';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.review.data = { id: 'list-1', supplierName: 'Distributor', fileName: 'list.csv', createdAt: new Date(), importedById: 'manager', lines: [line] };
  mocks.upload.mutateAsync.mockResolvedValue({ priceListId: 'list-1', replayed: false });
  mocks.decide.mutateAsync.mockResolvedValue([]);
});
afterEach(cleanup);

describe('supplier price lists console', () => {
  it('formats paisa as PKR without floating-point arithmetic', () => {
    expect(pkr(123450)).toBe('PKR 1,234.50');
    expect(pkr(-5)).toBe('−PKR 0.05');
    expect(pkr(null)).toBe('—');
  });

  it('imports for the chosen supplier and says no price changed', async () => {
    render(<SupplierPriceListsConsole canApprove actorId="owner" soloOwner={false} />);
    expect(screen.getByLabelText('CSV or XLSX price list')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'sup' } });
    const file = new File(['Product,MRP\nX,1\n'], 'list.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('Product,MRP\nX,1\n').buffer });
    fireEvent.change(screen.getByLabelText('CSV or XLSX price list'), { target: { files: [file] } });
    await screen.findByText(/No price has changed/);
    expect(mocks.upload.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ supplierId: 'sup', fileName: 'list.csv' }));
  });

  it('shows the SQL-computed alerts and lets an approver approve one draft', async () => {
    render(<SupplierPriceListsConsole canApprove actorId="owner" soloOwner={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('+PKR 50.00 (+6.25%)')).toBeVisible();
    expect(screen.getByText('+PKR 100.00 (+10.00%)')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Approve shelf price for row 2' }));
    await waitFor(() => expect(mocks.decide.mutateAsync).toHaveBeenCalledWith({ lineIds: ['line-1'], decision: 'APPROVE' }));
  });

  it('offers no approval control to someone without the approver permission', () => {
    render(<SupplierPriceListsConsole canApprove={false} actorId="manager" soloOwner={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.queryByRole('button', { name: /Approve shelf price/ })).toBeNull();
    expect(screen.getByText('Awaiting owner approval')).toBeVisible();
  });

  it('never offers the importer approval of their own list unless they are a solo owner', () => {
    render(<SupplierPriceListsConsole canApprove actorId="manager" soloOwner={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.queryByRole('button', { name: /Approve shelf price/ })).toBeNull();
    expect(screen.getByText('Another owner or admin approves')).toBeVisible();
  });

  it('asks a solo owner who imported the list for a fresh PIN before approving', async () => {
    render(<SupplierPriceListsConsole canApprove actorId="manager" soloOwner />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const approveButton = screen.getByRole('button', { name: 'Approve shelf price for row 2' });
    expect(approveButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Your approval PIN/), { target: { value: '1234' } });
    fireEvent.click(approveButton);
    await waitFor(() =>
      expect(mocks.decide.mutateAsync).toHaveBeenCalledWith({ lineIds: ['line-1'], decision: 'APPROVE', pin: '1234' })
    );
  });

  it('flags each changed row on the page and can show only the flagged rows', () => {
    const unchanged = {
      ...line, id: 'line-2', rowNumber: 3, productText: 'Brufen 400mg', tradeChangeMinor: 0, tradeChangeBps: 0,
      mrpChangeMinor: 0, mrpChangeBps: 0, draftStatus: 'NONE', draftMrpMinor: null, draftSellingPriceMinor: null,
      tradeChanged: false, mrpChanged: false,
    };
    const tradeOnly = { ...unchanged, id: 'line-3', rowNumber: 4, productText: 'Arinac', tradeChanged: true };
    mocks.review.data = { id: 'list-1', supplierName: 'Distributor', fileName: 'list.csv', createdAt: new Date(), importedById: 'manager', lines: [line, unchanged, tradeOnly] };
    render(<SupplierPriceListsConsole canApprove actorId="owner" soloOwner={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('2 of 3 rows flagged: the trade price or MRP differs from your records.')).toBeVisible();
    expect(screen.getByText('TP and MRP changed')).toBeVisible();
    expect(screen.getByText('TP changed')).toBeVisible();
    const filter = screen.getByRole('button', { name: 'Show flagged rows only' });
    expect(filter).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(filter);
    expect(screen.queryByText('Brufen 400mg')).toBeNull();
    expect(screen.getByText('Panadol 500mg', { selector: 'span.block' })).toBeVisible();
    expect(screen.getByText('Arinac')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show all rows' }));
    expect(screen.getByText('Brufen 400mg')).toBeVisible();
  });

  it('says so when no row changes a price', () => {
    mocks.review.data = { id: 'list-1', supplierName: 'Distributor', fileName: 'list.csv', createdAt: new Date(), importedById: 'manager', lines: [{ ...line, tradeChanged: false, mrpChanged: false }] };
    render(<SupplierPriceListsConsole canApprove actorId="owner" soloOwner={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('No row changes a trade price or MRP against your records.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show flagged rows only' })).toBeDisabled();
  });

  it('blocks a stale draft instead of offering approval', () => {
    mocks.review.data = { id: 'list-1', supplierName: 'Distributor', fileName: 'list.csv', createdAt: new Date(), importedById: 'manager', lines: [{ ...line, stale: true }] };
    render(<SupplierPriceListsConsole canApprove actorId="owner" soloOwner={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.queryByRole('button', { name: /Approve shelf price/ })).toBeNull();
    expect(screen.getByText('Price changed · re-import')).toBeVisible();
  });
});
