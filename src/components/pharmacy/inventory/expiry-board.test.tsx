import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ExpiryBoard,
  nearExpiryCsv,
  type ExpiryBoardProps,
  type ExpiryBoardRow,
} from './expiry-board';

function row(overrides: Partial<ExpiryBoardRow> = {}): ExpiryBoardRow {
  return {
    key: 'lot_1:location_1',
    inventoryLotId: 'lot_1',
    stockLocationId: 'location_1',
    locationName: 'Front shelf',
    medicineName: 'Amoxicillin 500mg capsule',
    batchNumber: 'B-60',
    batchState: 'ACTIVE',
    expiresAt: '2026-11-28T00:00:00.000Z',
    daysLeft: 60,
    expired: false,
    onHandUnits: 70,
    reservedUnits: 0,
    quarantinedUnits: 0,
    unitsPerPack: 10,
    unitCostMinor: 2_500,
    printedMrpMinor: 32_000,
    valueAtRiskMinor: 175_000,
    supplierName: 'Indus Pharma Distributors',
    suggestedSupplierId: 'supplier_1',
    markdown: null,
    returnDraft: null,
    requestKey: 'request-key-1',
    ...overrides,
  };
}

function renderBoard(overrides: Partial<ExpiryBoardProps> = {}) {
  const props: ExpiryBoardProps = {
    view: 'board',
    branchId: 'branch_a',
    branchName: 'Saddar branch',
    withinDays: 90,
    generatedAt: '2026-09-29T00:00:00.000Z',
    rows: [row()],
    suppliers: [
      { id: 'supplier_0', name: 'Another Distributor' },
      { id: 'supplier_1', name: 'Indus Pharma Distributors' },
    ],
    boardHref: '/pharmacy/inventory/expiry?branch=branch_a&within=90',
    printHref: '/pharmacy/inventory/expiry?branch=branch_a&within=90&view=print',
    returnsHref: '/pharmacy/purchasing/returns?branch=branch_a',
    action: vi.fn(async () => undefined),
    ...overrides,
  };
  return render(<ExpiryBoard {...props} />);
}

describe('ExpiryBoard', () => {
  it('offers all three actions on a saleable near-expiry lot, pre-filled for the operator', () => {
    renderBoard();
    const card = screen.getByRole('article', {
      name: 'Amoxicillin 500mg capsule · batch B-60 · Front shelf',
    });
    expect(within(card).getByRole('button', { name: 'Draft mark-down' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Draft supplier return' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Quarantine units' })).toBeInTheDocument();
    // The supplier the lot was received from is preselected, not the first one listed.
    expect(within(card).getByLabelText('Return supplier')).toHaveValue('supplier_1');
    expect(within(card).getByLabelText('Quarantine units')).toHaveValue(70);
    // Each mark-down choice states the pack price it would produce.
    expect(within(card).getByRole('option', { name: '20% off → PKR 256.00' })).toBeInTheDocument();
  });

  it('never offers a mark-down on expired stock and shows existing drafts instead of forms', () => {
    renderBoard({
      rows: [
        row({ expired: true, daysLeft: -2, key: 'lot_2:location_1', batchNumber: 'B-OLD' }),
        row({
          markdown: {
            markdownPercent: 20,
            printedMrpMinor: 32_000,
            proposedPackPriceMinor: 25_600,
            reason: 'Clear before expiry',
            recordedAt: '2026-09-29T00:00:00.000Z',
          },
          returnDraft: { id: 'return_1', reference: 'EXP-1', status: 'DRAFT' },
        }),
      ],
    });
    const expired = screen.getByRole('article', { name: /batch B-OLD/ });
    expect(within(expired).queryByRole('button', { name: 'Draft mark-down' })).toBeNull();
    expect(within(expired).getByText(/cannot be sold at any price/)).toBeInTheDocument();
    expect(within(expired).getByText('Expired 2 days ago')).toBeInTheDocument();

    const drafted = screen.getByRole('article', { name: /batch B-60/ });
    expect(within(drafted).getByText(/PKR 320.00 → PKR 256.00/)).toBeInTheDocument();
    expect(within(drafted).queryByRole('button', { name: 'Draft supplier return' })).toBeNull();
    expect(
      within(drafted).getByRole('link', { name: 'Open in Purchasing → Returns' })
    ).toHaveAttribute('href', '/pharmacy/purchasing/returns?branch=branch_a&return=return_1');
  });

  it('renders the printable list with a CSV download and no action forms', () => {
    renderBoard({ view: 'print' });
    expect(screen.getByRole('table', { name: 'Near-expiry list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print list' })).toBeInTheDocument();
    const csv = screen.getByRole('link', { name: 'Download CSV' });
    expect(csv).toHaveAttribute('download', 'near-expiry-2026-09-29.csv');
    expect(decodeURIComponent(csv.getAttribute('href')!)).toContain('B-60');
    expect(screen.queryByRole('button', { name: 'Quarantine units' })).toBeNull();
  });

  it('neutralises spreadsheet formulas in the shared CSV', () => {
    const csv = nearExpiryCsv([row({ medicineName: '=HYPERLINK("x")', batchNumber: 'B,1' })]);
    expect(csv.split('\n')[1]).toMatch(/^"'=HYPERLINK\(""x""\)","B,1"/);
  });
});
