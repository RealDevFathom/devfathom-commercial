import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/pharmacy/imported-stock', () => ({ readImportedStock: vi.fn() }));

import { readImportedStock } from '@/lib/pharmacy/imported-stock';
import ImportedStockPage from './page';

const importedReferences = {
  importedRows: 1,
  reportedStockRows: 1,
  matchingRows: 1,
  search: '',
  page: 1,
  pages: 1,
  pageSize: 50,
  rows: [
    {
      id: 'row-1',
      sourceId: 'source-1',
      batchId: 'batch-1',
      rowNumber: 7,
      productName: 'Imported medicine',
      originalQty: '12.5000',
      originalPackQty: '2.00',
      originalPackUnits: null,
    },
  ],
};

beforeEach(() => {
  vi.mocked(readImportedStock).mockReset().mockResolvedValue(importedReferences);
});
afterEach(cleanup);

describe('import reference reconciliation copy', () => {
  it('describes retained references without inventing a verification state or converting counts', async () => {
    render(await ImportedStockPage({ searchParams: Promise.resolve({ q: 'Imported' }) }));
    expect(readImportedStock).toHaveBeenCalledWith({ q: 'Imported' });
    expect(
      screen.getByRole('heading', { name: 'Import references and reconciliation' })
    ).toBeVisible();
    expect(screen.getByText(/These are original source quantities/)).toHaveTextContent(
      'not available-to-sell balances'
    );
    expect(screen.getByText(/These are original source quantities/)).toHaveTextContent(
      'This view does not report whether a source row has been reconciled with posted stock.'
    );
    const table = screen.getByRole('table', {
      name: /Imported stock references for reconciliation/,
    });
    expect(within(table).getByRole('columnheader', { name: 'Record type' })).toBeVisible();
    expect(within(table).getByText('Import reference')).toHaveAttribute('data-tone', 'neutral');
    expect(within(table).getByRole('cell', { name: '12.5000' })).toBeVisible();
    expect(within(table).getByRole('cell', { name: '2.00' })).toBeVisible();
    expect(within(table).getByRole('cell', { name: 'Unknown' })).toBeVisible();
    expect(within(table).getByText('Source row: 7')).toBeVisible();
    expect(within(table).getByText('Row ID: row-1')).toBeVisible();
    expect(screen.queryByText(/awaiting verification/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Verification status' })
    ).not.toBeInTheDocument();
  });

  it('describes an empty reference list without implying a completed stock posting', async () => {
    vi.mocked(readImportedStock).mockResolvedValue({
      ...importedReferences,
      importedRows: 0,
      reportedStockRows: 0,
      matchingRows: 0,
      rows: [],
    });
    render(await ImportedStockPage({ searchParams: Promise.resolve({}) }));
    expect(
      screen.getByText('No imported medicine references are visible in this workspace.')
    ).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps reference rows hidden when inventory access is unavailable', async () => {
    vi.mocked(readImportedStock).mockResolvedValue(null);
    render(await ImportedStockPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Inventory access required' })).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Import reference')).not.toBeInTheDocument();
  });
});
