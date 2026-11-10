import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExpiryBoard,
  nearExpiryCsv,
  type ExpiryBoardProps,
  type ExpiryBoardRow,
} from './expiry-board';

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
  it('prevents row injection and neutralizes formulas after invisible prefixes in CSV', () => {
    const csv = nearExpiryCsv([
      { ...row, batchNumber: 'QA\r=1+1', medicineName: '\t@SUM(A1:A2)' },
    ]);

    expect(csv.split('\n')).toHaveLength(2);
    expect(csv).not.toContain('\r');
    expect(csv).toContain('"QA =1+1"');
    expect(csv).toContain("\"' @SUM(A1:A2)\"");
  });

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

  it('retains the selected-window total for stock expiring beyond the cumulative buckets', () => {
    render(
      <ExpiryBoard
        {...props}
        withinDays={180}
        riskBuckets={props.riskBuckets.map((bucket) => ({ ...bucket, valueAtRiskMinor: 0 }))}
        rows={[{ ...row, daysLeft: 120, valueAtRiskMinor: 100_000 }]}
      />
    );

    const summary = screen.getByRole('region', { name: 'Near-expiry summary' });
    const selectedTotal = within(summary).getByText('Value at risk').parentElement!;
    expect(selectedTotal).toHaveTextContent('PKR 1,000.00');
    expect(selectedTotal).toHaveTextContent('Selected 180-day window, plus expired stock');
    expect(within(summary).getAllByText('PKR 0.00')).toHaveLength(3);
    expect(screen.getByRole('article')).toHaveTextContent('120 days left');
  });

  it('preserves the selected total across all listed positions, including expired stock', () => {
    render(
      <ExpiryBoard
        {...props}
        rows={[
          row,
          { ...row, key: 'expired', expired: true, daysLeft: -1, valueAtRiskMinor: 75_000 },
        ]}
      />
    );

    const summary = screen.getByRole('region', { name: 'Near-expiry summary' });
    expect(within(summary).getByText('Value at risk').parentElement).toHaveTextContent(
      'PKR 1,000.00'
    );
  });

  it('shows a zero selected-window total when no positions are listed', () => {
    render(<ExpiryBoard {...props} rows={[]} />);

    const summary = screen.getByRole('region', { name: 'Near-expiry summary' });
    expect(within(summary).getByText('Value at risk').parentElement).toHaveTextContent('PKR 0.00');
  });

  it.each([
    { name: 'ineligible historic draft', markdownEligible: false, markdown: row.markdown },
    { name: 'eligible draft', markdownEligible: true, markdown: row.markdown },
    { name: 'ineligible stock without a draft', markdownEligible: false, markdown: null },
  ])('carries the correct warning into print and CSV for $name', (draft) => {
    render(
      <ExpiryBoard
        {...props}
        view="print"
        rows={[
          {
            ...row,
            markdownEligible: draft.markdownEligible,
            markdown: draft.markdown,
            returnDraft: { id: 'return_1', reference: 'RET-001', status: 'DRAFT' },
          },
        ]}
      />
    );

    const table = screen.getByRole('table', { name: 'Near-expiry list' });
    const download = screen.getByRole('link', { name: 'Download CSV' });
    const csv = decodeURIComponent(download.getAttribute('href')!.split(',')[1]!);
    expect(table).toHaveTextContent('Return RET-001');
    expect(csv).toContain('RET-001 (DRAFT)');

    if (draft.markdown) {
      expect(table).toHaveTextContent('Mark-down 20%');
      expect(csv).toContain('20% off (40.00 per pack)');
    } else {
      expect(table).not.toHaveTextContent('Mark-down 20%');
      expect(csv).not.toContain('20% off');
    }

    if (draft.markdown && !draft.markdownEligible) {
      expect(within(table).getByRole('note')).toHaveTextContent('Legacy draft — now ineligible');
      expect(within(table).getByRole('note')).toHaveTextContent('do not advance it');
      expect(csv).toContain('Legacy draft — now ineligible');
      expect(csv).toContain('do not advance it');
    } else {
      expect(within(table).queryByRole('note')).not.toBeInTheDocument();
      expect(csv).not.toContain('ineligible');
    }
  });
});
