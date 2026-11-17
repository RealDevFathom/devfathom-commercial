import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExpiryBoard,
  expiryRiskBand,
  groupExpiryRows,
  nearExpiryCsv,
  type ExpiryBoardProps,
  type ExpiryBoardRow,
} from './expiry-board';
import { EXPIRY_CLAIM_MAX_POSITIONS } from '@/lib/pharmacy/expiry-claim';

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
  costVisible: true,
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
    const csv = nearExpiryCsv(
      [{ ...row, batchNumber: 'QA\r=1+1', medicineName: '\t@SUM(A1:A2)' }],
      true
    );

    expect(csv.split('\n')).toHaveLength(2);
    expect(csv).not.toContain('\r');
    expect(csv).toContain('"QA =1+1"');
    expect(csv).toContain('"\' @SUM(A1:A2)"');
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

describe('DEV-728 distributor grouping and return claims', () => {
  const second = {
    ...row,
    key: 'lot_2:location_1',
    inventoryLotId: 'lot_2',
    supplierName: 'Another distributor',
    suggestedSupplierId: 'supplier_2',
  };
  const sameDistributor = { ...row, key: 'lot_3:location_1', inventoryLotId: 'lot_3' };

  it('groups lots by distributor with one Draft return claim per distributor', () => {
    const action = vi.fn();
    render(<ExpiryBoard {...props} action={action} rows={[row, second, sameDistributor]} />);

    const first = screen.getByRole('region', { name: 'Branch distributor' });
    const other = screen.getByRole('region', { name: 'Another distributor' });
    expect(first).toHaveTextContent('2 stock positions');
    expect(within(first).getAllByRole('article')).toHaveLength(2);
    expect(within(other).getAllByRole('article')).toHaveLength(1);

    const button = within(first).getByRole('button', { name: 'Draft return claim' });
    const form = button.closest('form')!;
    const data = new FormData(form);
    expect(data.get('action')).toBe('claim');
    expect(data.get('branchId')).toBe('branch_1');
    expect(data.get('supplierId')).toBe('supplier_1');
    expect(data.getAll('position')).toEqual(['lot_1|location_1', 'lot_3|location_1']);
    expect(within(other).getByRole('button', { name: 'Draft return claim' })).toBeVisible();
  });

  it('leaves lots already on a return or fully reserved off the claim', () => {
    render(
      <ExpiryBoard
        {...props}
        rows={[
          row,
          {
            ...sameDistributor,
            returnDraft: { id: 'ret_1', reference: 'EXP-1', status: 'DRAFT' },
          },
          { ...row, key: 'lot_4:location_1', inventoryLotId: 'lot_4', reservedUnits: 10 },
        ]}
      />
    );
    const form = screen.getByRole('button', { name: 'Draft return claim' }).closest('form')!;
    expect(new FormData(form).getAll('position')).toEqual(['lot_1|location_1']);
  });

  it('leaves expired lots off the claim because their return window has closed', () => {
    render(
      <ExpiryBoard {...props} rows={[{ ...row, expired: true, daysLeft: -1 }, sameDistributor]} />
    );
    const form = screen.getByRole('button', { name: 'Draft return claim' }).closest('form')!;
    expect(new FormData(form).getAll('position')).toEqual(['lot_3|location_1']);
  });

  it('offers no group claim when every lot has expired', () => {
    render(<ExpiryBoard {...props} rows={[{ ...row, expired: true, daysLeft: -1 }]} />);
    expect(screen.queryByRole('button', { name: 'Draft return claim' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Branch distributor' })).toHaveTextContent(
      'expired lots are past the supplier return window'
    );
  });

  it('caps one claim at the server limit, soonest expiry first', () => {
    const many = Array.from({ length: EXPIRY_CLAIM_MAX_POSITIONS + 5 }, (_, index) => ({
      ...row,
      key: `lot_${index}:location_1`,
      inventoryLotId: `lot_${index}`,
    }));
    const { container } = render(<ExpiryBoard {...props} rows={many} />);
    // Scoped DOM queries: a role query over the whole board of 105 lots is the
    // slow part, so find the claim form and its distributor section directly.
    const form = container
      .querySelector('form:has(input[name="action"][value="claim"])')
      ?.closest('form');
    expect(form).toBeTruthy();
    expect(within(form as HTMLElement).getByText('Draft return claim')).toBeVisible();
    const positions = new FormData(form as HTMLFormElement).getAll('position');
    expect(positions).toHaveLength(EXPIRY_CLAIM_MAX_POSITIONS);
    expect(positions[0]).toBe('lot_0|location_1');
    const section = (form as HTMLElement).closest('section') as HTMLElement;
    expect(section).toHaveAccessibleName('Branch distributor');
    expect(section).toHaveTextContent('draft again for the other 5');
  });

  it('offers no group claim once every lot is already on a return, and links to it', () => {
    render(
      <ExpiryBoard
        {...props}
        rows={[{ ...row, returnDraft: { id: 'ret_1', reference: 'EXP-1', status: 'DRAFT' } }]}
      />
    );
    expect(screen.queryByRole('button', { name: 'Draft return claim' })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Open EXP-1 in Purchasing → Returns' })
    ).toHaveAttribute('href', '/returns?branch=branch_1&return=ret_1');
  });

  it('does not invent a supplier for an unmatched distributor', () => {
    render(
      <ExpiryBoard
        {...props}
        rows={[{ ...row, suggestedSupplierId: null, supplierName: 'Unmatched' }]}
      />
    );
    expect(screen.getByRole('region', { name: 'Unmatched' })).toHaveTextContent(
      'not matched to a supplier record'
    );
    expect(screen.queryByRole('button', { name: 'Draft return claim' })).toBeNull();
  });

  it('keeps distinct supplier records apart and merges unmatched names case-insensitively', () => {
    expect(groupExpiryRows([row, { ...row, suggestedSupplierId: 'other' }])).toHaveLength(2);
    expect(
      groupExpiryRows([
        { ...row, suggestedSupplierId: null, supplierName: 'Acme ' },
        { ...row, suggestedSupplierId: null, supplierName: 'acme' },
      ])
    ).toHaveLength(1);
  });

  it.each([
    [0, '30'],
    [30, '30'],
    [31, '60'],
    [60, '60'],
    [61, '90'],
    [90, '90'],
    [91, 'later'],
  ] as const)('places %i days left in the %s step', (daysLeft, band) => {
    expect(expiryRiskBand({ expired: false, daysLeft })).toBe(band);
  });

  it('shows amber 90/60/30 steps and keeps red for expired stock only', () => {
    render(
      <ExpiryBoard
        {...props}
        rows={[
          { ...row, key: 'a', daysLeft: 85 },
          { ...row, key: 'b', daysLeft: 45 },
          { ...row, key: 'c', daysLeft: 10 },
          { ...row, key: 'd', daysLeft: -2, expired: true },
        ]}
      />
    );
    const pill = (text: RegExp) => screen.getByText(text).closest('[data-slot="status-pill"]');
    expect(pill(/^Within 90 days · 85 days left/)).toHaveAttribute('data-tone', 'warning');
    expect(pill(/^Within 60 days · 45 days left/)).toHaveAttribute('data-tone', 'warning');
    expect(pill(/^Within 30 days · 10 days left/)).toHaveAttribute('data-tone', 'warning');
    expect(pill(/^Within 30 days/)).toHaveClass('bg-warning/20');
    expect(pill(/^Within 60 days/)).toHaveClass('bg-warning/15');
    expect(pill(/^Within 90 days/)).toHaveClass('bg-warning/10');
    expect(pill(/^Expired · Expired 2 days ago/)).toHaveAttribute('data-tone', 'danger');
    expect(document.querySelectorAll('[data-tone="danger"]')).toHaveLength(1);
  });
});

describe('DEV-627: viewer without reports:financial', () => {
  const hidden: ExpiryBoardProps = {
    ...props,
    costVisible: false,
    riskBuckets: [],
    rows: [{ ...row, valueAtRiskMinor: null }],
  };

  it('shows no PKR value at risk on the board', () => {
    render(<ExpiryBoard {...hidden} />);

    const summary = screen.getByRole('region', { name: 'Near-expiry summary' });
    expect(within(summary).queryByText('Value at risk')).not.toBeInTheDocument();
    expect(within(summary).queryByText(/PKR at risk/)).not.toBeInTheDocument();
    expect(within(summary).getByText('Units at risk')).toBeInTheDocument();
    const card = screen.getByRole('article');
    expect(card).not.toHaveTextContent(/value at risk/i);
    expect(card).toHaveTextContent('10 units (10 per pack) · MRP PKR 50.00 per pack');
  });

  it('drops the value column from the printable list and the CSV', () => {
    render(<ExpiryBoard {...hidden} view="print" />);

    const table = screen.getByRole('table', { name: 'Near-expiry list' });
    expect(within(table).queryByRole('columnheader', { name: 'Value at risk' })).toBeNull();
    const download = screen.getByRole('link', { name: 'Download CSV' });
    const csv = decodeURIComponent(download.getAttribute('href')!.split(',')[1]!);
    expect(csv).not.toContain('Value at risk');
    expect(csv.split('\n')[0]!.split(',')).toHaveLength(9);
  });

  it('keeps the value column for a reports:financial viewer', () => {
    expect(nearExpiryCsv([row], true).split('\n')[0]).toContain('Value at risk (PKR)');
    expect(nearExpiryCsv([row], true).split('\n')[1]).toContain('250.00');
  });

  it('shows no value at risk for a distributor group, not even PKR 0.00', () => {
    render(<ExpiryBoard {...hidden} />);

    const group = screen.getByRole('region', { name: 'Branch distributor' });
    expect(group).toHaveTextContent('1 stock position');
    expect(group).not.toHaveTextContent(/value at risk/i);
    expect(group).not.toHaveTextContent('PKR 0.00');
    expect(within(group).getByRole('button', { name: 'Draft return claim' })).toBeVisible();
  });

  it('keeps the distributor value at risk for a reports:financial viewer', () => {
    render(<ExpiryBoard {...props} />);

    expect(screen.getByRole('region', { name: 'Branch distributor' })).toHaveTextContent(
      '1 stock position · value at risk PKR 250.00'
    );
  });
});
