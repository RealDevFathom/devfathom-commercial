import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExpiryBoard, type ExpiryBoardProps, type ExpiryBoardRow } from './expiry-board';

afterEach(cleanup);

const row: ExpiryBoardRow = {
  key: 'lot_1:location_1',
  inventoryLotId: 'lot_1',
  stockLocationId: 'location_1',
  locationName: 'Main shelf',
  medicineName: 'Restricted medicine',
  batchNumber: 'B-1',
  batchState: 'ACTIVE',
  expiresAt: '2026-12-31T00:00:00.000Z',
  daysLeft: 63,
  expired: false,
  onHandUnits: 10,
  reservedUnits: 0,
  quarantinedUnits: 0,
  unitsPerPack: 10,
  unitCostMinor: 2_500,
  printedMrpMinor: 5_000,
  valueAtRiskMinor: 25_000,
  supplierName: 'Branch distributor',
  suggestedSupplierId: 'supplier_1',
  markdownEligible: false,
  returnWindowOpensAt: '2026-12-01T00:00:00.000Z',
  returnDeadlineAt: '2026-12-31T00:00:00.000Z',
  markdown: {
    markdownPercent: 20,
    printedMrpMinor: 5_000,
    proposedPackPriceMinor: 4_000,
    reason: 'Historic suggestion',
    recordedAt: '2026-10-01T00:00:00.000Z',
  },
  returnDraft: null,
  requestKey: 'request_1',
};

const props: ExpiryBoardProps = {
  view: 'board',
  branchId: 'branch_1',
  branchName: 'Lahore',
  withinDays: 90,
  generatedAt: '2026-10-29T00:00:00.000Z',
  riskBuckets: [
    { days: 30, valueAtRiskMinor: 10_000 },
    { days: 60, valueAtRiskMinor: 20_000 },
    { days: 90, valueAtRiskMinor: 25_000 },
  ],
  rows: [row],
  suppliers: [{ id: 'supplier_1', name: 'Branch distributor' }],
  boardHref: '/board',
  printHref: '/print',
  returnsHref: '/returns?branch=branch_1',
  action: vi.fn(),
};

describe('ExpiryBoard recovery facts', () => {
  it('renders cumulative 30/60/90 PKR risk and the distributor calendar', () => {
    render(<ExpiryBoard {...props} />);

    const summary = screen.getByRole('region', { name: 'Near-expiry summary' });
    expect(within(summary).getByText('30-day PKR at risk')).toBeInTheDocument();
    expect(within(summary).getByText('60-day PKR at risk')).toBeInTheDocument();
    expect(within(summary).getByText('90-day PKR at risk')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) =>
        Boolean(
          element?.tagName === 'P' &&
          element.textContent?.includes('Distributor return calendar: opens') &&
          element.textContent.includes('deadline')
        )
      )
    ).toHaveTextContent('01-Dec-2026 · deadline 31-Dec-2026');
  });

  it('preserves an ineligible historic draft as clearly labelled audit history', () => {
    render(<ExpiryBoard {...props} />);

    expect(screen.getByRole('note')).toHaveTextContent('Legacy draft — now ineligible');
    expect(screen.getByRole('note')).toHaveTextContent('retain it as audit history');
    expect(screen.queryByRole('button', { name: 'Draft mark-down' })).not.toBeInTheDocument();
  });
});
