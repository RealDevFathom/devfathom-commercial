import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  options: { data: { branches: [{ id: 'branch', name: 'Main branch' }], locations: [{ id: 'location', branchId: 'branch', name: 'Main store' }] }, isPending: false, error: null as unknown, refetch: vi.fn() },
  upload: { mutateAsync: vi.fn(), isPending: false },
  preview: { mutateAsync: vi.fn(), isPending: false },
  commit: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock('@/lib/trpc', () => ({ trpc: { pharmacyOwnerImport: {
  options: { useQuery: () => mocks.options }, upload: { useMutation: () => mocks.upload },
  preview: { useMutation: () => mocks.preview }, commit: { useMutation: () => mocks.commit },
} } }));
import { OwnerImportWizard } from './owner-import-wizard';

const mapping = { sourceRef: 0, pack: 1, batch: 2, expiry: 3, mrp: 4, cost: 5, expected: 6, counted: 7, varianceNote: 8 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.options.error = null;
  mocks.options.isPending = false;
  mocks.upload.isPending = mocks.preview.isPending = mocks.commit.isPending = false;
  mocks.upload.mutateAsync.mockResolvedValue({ headers: ['Source', 'Barcode', 'Batch', 'Expiry', 'MRP', 'Cost', 'Exported', 'Counted', 'Note'], sample: [['SRC', '00123', 'B1', '2099-06', '25', '1.25', '12', '10', 'Excluded damage']], rowCount: 1, mapping });
  mocks.preview.mutateAsync.mockResolvedValue({ previewHash: 'a'.repeat(64), canCommit: true, blockers: [], totalUnits: 10, totalValueMinor: '1250', lines: [{ rowNumber: 2, sourceRef: 'SRC', packReference: '00123', medicineName: 'Test medicine', batchNumber: 'B1', expiryDate: '2099-06-30', expiryPrecision: 'MONTH', expectedUnits: 12, countedUnits: 10, currentUnits: 0, proposedUnits: 10, varianceUnits: -2, unitsPerPack: 10, printedMrpMinor: 2500, unitCostMinor: 125, varianceNote: 'Excluded damage', errors: [] }] });
  mocks.commit.mutateAsync.mockResolvedValue({ sessionId: 'opening_session', totalUnits: 10, totalValueMinor: '1250', replayed: false });
});
afterEach(cleanup);

async function uploadAndPreview() {
  fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch' } });
  fireEvent.change(screen.getByLabelText('Stock location'), { target: { value: 'location' } });
  const file = new File(['A\n1'], 'stock.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('A\n1').buffer });
  fireEvent.change(screen.getByLabelText('CSV or XLSX file'), { target: { files: [file] } });
  await screen.findByRole('button', { name: 'Run dry-run diff' });
  fireEvent.click(screen.getByRole('button', { name: 'Run dry-run diff' }));
  await screen.findByRole('button', { name: 'Commit opening stock' });
}

describe('owner importer wizard', () => {
  it('requires review and confirmation before posting, and shows the receipt', async () => {
    render(<OwnerImportWizard />);
    await uploadAndPreview();
    expect(screen.getByText(/Test medicine/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Commit opening stock' })).toBeDisabled();
    expect(mocks.commit.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Commit opening stock' }));
    await screen.findByText('Opening stock committed');
    expect(mocks.commit.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'branch', stockLocationId: 'location', confirmed: true, previewHash: 'a'.repeat(64), mapping }));
    expect(screen.getByText(/10 base units posted/)).toBeVisible();
  });
  it('invalidates the dry run and confirmation after a mapping edit', async () => {
    render(<OwnerImportWizard />);
    await uploadAndPreview();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Cost per tablet/unit (PKR) *'), { target: { value: '4' } });
    expect(screen.queryByRole('button', { name: 'Commit opening stock' })).toBeNull();
    expect(mocks.commit.mutateAsync).not.toHaveBeenCalled();
  });
  it('keeps the file and mapping after a dry-run error', async () => {
    mocks.preview.mutateAsync.mockRejectedValueOnce(new Error('Map each required field to a different column.'));
    render(<OwnerImportWizard />);
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch' } });
    fireEvent.change(screen.getByLabelText('Stock location'), { target: { value: 'location' } });
    const file = new File(['A\n1'], 'stock.csv');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('A\n1').buffer });
    fireEvent.change(screen.getByLabelText('CSV or XLSX file'), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Run dry-run diff' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('different column'));
    expect(screen.getByLabelText('Cost per tablet/unit (PKR) *')).toHaveValue('5');
    expect(screen.getByText(/stock.csv · 1 stock rows/)).toBeVisible();
  });
  it('shows permission denial without upload controls', () => {
    mocks.options.error = { data: { code: 'FORBIDDEN' } };
    render(<OwnerImportWizard />);
    expect(screen.getByText('Owner access required')).toBeVisible();
    expect(screen.queryByLabelText('CSV or XLSX file')).toBeNull();
  });
  it('shows a loading state before options arrive', () => {
    mocks.options.isPending = true;
    render(<OwnerImportWizard />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading your branches');
    expect(screen.queryByLabelText('CSV or XLSX file')).toBeNull();
  });
});

it('shows a cost-basis warning and still requires explicit review before a valid import',async()=>{
  const preview=await mocks.preview.mutateAsync();
  preview.lines[0].warnings=['Cost per tablet/unit is greater than or equal to MRP per tablet/unit. Check the unit basis.'];
  mocks.preview.mutateAsync.mockResolvedValue(preview);
  render(<OwnerImportWizard/>);await uploadAndPreview();
  expect(screen.getByText('Review cost warnings')).toBeVisible();expect(screen.getByText('Review cost basis')).toBeVisible();
  expect(screen.getByText(/Cost per tablet\/unit is greater/)).toBeVisible();
  const commit=screen.getByRole('button',{name:'Commit opening stock'});expect(commit).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));expect(commit).toBeEnabled();
  expect(mocks.commit.mutateAsync).not.toHaveBeenCalled();
});
it('shows rejected rows outside the valid-unit valuation and leaves commit disabled',async()=>{
  const preview=await mocks.preview.mutateAsync();preview.canCommit=false;
  preview.lines.push({...preview.lines[0],rowNumber:3,sourceRef:'INVALID',errors:['Invalid pack'],countedUnits:20});
  mocks.preview.mutateAsync.mockResolvedValue(preview);
  render(<OwnerImportWizard/>);await uploadAndPreview();
  expect(screen.getByText(/1 of 2 valid rows · 10 counted base units · PKR 12.50 opening valuation/)).toBeVisible();
  expect(screen.getByText(/Rejected rows are excluded/)).toBeVisible();expect(screen.getByRole('button',{name:'Commit opening stock'})).toBeDisabled();
});
