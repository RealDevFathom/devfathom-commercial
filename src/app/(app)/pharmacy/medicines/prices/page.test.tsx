import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyMedicine: {
      priceNotices: { useQuery: () => ({ isLoading: true }) },
      priceOverrides: { useQuery: () => ({ isLoading: true }) },
      confirmPrices: { useMutation: () => ({}) },
      drapPriceAlerts: { useQuery: () => ({ isLoading: true }) },
      dismissDrapPriceAlert: { useMutation: () => ({}) },
    },
  },
}));
import MedicinePricesPage from './page';
import {
  DrapPriceAlertsView,
  PriceNoticesView,
  PriceOverridesView,
  pricesCsv,
} from '@/components/pharmacy/medicines/price-notices';
const row = {
  id: 'ingest',
  proposalId: 'proposal',
  reference: '=SRO-1',
  medicine: 'Medicine',
  aliases: ['گولی'],
  presentation: 'Tablet',
  packLevel: 'BOX',
  packLevelId: 'box',
  units: 30,
  status: 'PROPOSED',
  eligible: true,
  effectiveDate: new Date('2027-01-01'),
  notifiedMrpMinor: 30000,
  confirmedMrpMinor: 20000,
  sellingPriceMinor: null,
  amountMinor: null,
  percent: null,
  sellingUnitMinor: null,
  mrpUnitMinor: 20000 / 30,
};
const packRow = {
  ...row,
  medicineId: 'medicine',
  medicine: '=Manual medicine',
  source: 'manual',
  effectiveDate: new Date('2026-01-01'),
};
const data = { asOf: new Date('2026-09-29'), rows: [row], packRows: [packRow] };
const base = { onRetry: vi.fn() };
describe('price intelligence page states', () => {
  it('renders the route with one heading and accessible initial loading', () => {
    render(<MedicinePricesPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Price intelligence');
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });
  it('renders loading, error/retry, permission and empty states accessibly', () => {
    const { rerender } = render(<PriceNoticesView {...base} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    rerender(<PriceNoticesView {...base} error />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(base.onRetry).toHaveBeenCalled();
    rerender(<PriceNoticesView {...base} forbidden />);
    expect(screen.getByRole('alert')).toHaveTextContent('safety access');
    rerender(<PriceNoticesView {...base} data={{ ...data, rows: [] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('No DRAP');
  });
  it('DEV-693: shows earlier DRAP notices as information only, with nothing to confirm', () => {
    render(
      <PriceNoticesView
        {...base}
        data={{
          ...data,
          rows: [
            row,
            { ...row, id: 'applied', reference: 'applied', status: 'CONFIRMED', eligible: false },
            {
              ...row,
              id: 'unmapped',
              proposalId: null,
              reference: 'unmapped',
              status: 'NEEDS_MAPPING',
              eligible: false,
            },
          ],
        }}
      />
    );
    expect(screen.getAllByText('گولی')).toHaveLength(3);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /review|confirm/i })).toBeNull();
    const notices = screen.getByRole('region', { name: 'Mapped DRAP pack price notices, PKR' });
    expect(
      within(notices).getAllByText(/^Official price changed as of 2027-01-01: Rs\s?300\.00$/)
    ).toHaveLength(2);
    expect(within(notices).getByText('Never applied')).toBeVisible();
    expect(within(notices).getByText('Applied earlier')).toBeVisible();
    expect(screen.getByText(/never change a price/)).toBeVisible();
  });
  it('DEV-803: tells the owner which pending proposals were never applied', () => {
    render(
      <PriceNoticesView
        {...base}
        data={{
          ...data,
          rows: [
            { ...row, id: 'pending', reference: 'SRO-PENDING', status: 'PROPOSED' },
            { ...row, id: 'ended', reference: 'SRO-ENDED', status: 'NOT_APPLIED' },
            { ...row, id: 'done', reference: 'SRO-DONE', status: 'CONFIRMED' },
          ],
        }}
      />
    );
    const list = screen.getByRole('list', { name: 'Price proposals never applied' });
    expect(screen.getByText('Never applied (2)')).toBeVisible();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText(/SRO-PENDING/)).toBeVisible();
    expect(within(list).getByText(/SRO-ENDED/)).toBeVisible();
    expect(within(list).queryByText(/SRO-DONE/)).toBeNull();
    expect(screen.getByText(/no price changed/)).toBeVisible();
  });
  it('exports UTF-8 aliases, formula-safe identifiers and blank unknown prices', () => {
    const csv = pricesCsv(data);
    expect(csv).toContain('گولی');
    expect(csv).toContain('"\'=Manual medicine"');
    expect(csv).not.toContain('SRO-1');
    expect(csv).toContain('"200","","",""');
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });
  it('identifies every price table header as a column header', () => {
    render(<PriceNoticesView {...base} data={data} />);
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(11);
    for (const header of headers) expect(header).toHaveAttribute('scope', 'col');
  });
});

describe('corrected reports', () => {
  it('keeps notice history out of current variance and exports manual policy once', () => {
    const history = { ...data, rows: [row, { ...row, id: 'old', reference: 'historic' }] };
    render(<PriceNoticesView {...base} data={history} />);
    const table = screen.getByRole('table', { name: 'Current pack variance, PKR' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    for (const name of [
      'Current organization pack price variance, PKR',
      'Mapped DRAP pack price notices, PKR',
    ]) {
      const region = screen.getByRole('region', { name });
      expect(region).toHaveAttribute('tabindex', '0');
      expect(within(region).getByRole('table')).toBeVisible();
    }
    expect(within(table).queryByText('historic')).not.toBeInTheDocument();
    expect(pricesCsv(history).split('\r\n')).toHaveLength(2);
    expect(screen.getByText(/Keep the original source reference and payload/)).toBeVisible();
    expect(screen.queryByText(/new source reference/)).not.toBeInTheDocument();
  });
  it('shows preserved override amounts and review flags with accessible fallback states', () => {
    const override = {
      id: 'override',
      organizationId: 'org',
      presentationId: 'presentation',
      packLevelId: 'box',
      branchId: 'branch',
      branchName: 'Main branch',
      medicine: 'Medicine',
      presentation: 'Tablet',
      packLevel: 'BOX',
      isOverride: true,
      mrpMinor: 12300,
      sellingPriceMinor: 12000,
      effectiveFrom: new Date('2026-01-01'),
      source: 'manual',
      proposalId: null,
      reviewedOrgPriceId: null,
      createdById: 'actor',
      createdAt: new Date(),
      needsReview: true,
    };
    const { rerender } = render(
      <PriceOverridesView
        data={[override, { ...override, id: 'reviewed', needsReview: false }]}
        onRetry={base.onRetry}
      />
    );
    const region = screen.getByRole('region', {
      name: 'Preserved branch override versions, PKR',
    });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(within(region).getByRole('table')).toBeVisible();
    for (const header of within(region).getAllByRole('columnheader')) {
      expect(header).toHaveAttribute('scope', 'col');
    }
    expect(screen.getByText('Needs review')).toBeVisible();
    expect(screen.getByText('Reviewed')).toBeVisible();
    expect(screen.getAllByText(/123.00/)).toHaveLength(2);
    expect(screen.getAllByText(/120.00/)).toHaveLength(2);
    rerender(<PriceOverridesView loading onRetry={base.onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading branch overrides');
    rerender(<PriceOverridesView error onRetry={base.onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry overrides' }));
    expect(base.onRetry).toHaveBeenCalled();
    rerender(<PriceOverridesView forbidden onRetry={base.onRetry} />);
    expect(screen.getByText(/Administrator access/)).toBeVisible();
    rerender(<PriceOverridesView data={[]} onRetry={base.onRetry} />);
    expect(screen.getByText('No branch overrides.')).toBeVisible();
  });
});

describe('DEV-693 official price changes', () => {
  const alert = {
    id: 'alert-1',
    medicineId: 'medicine',
    medicine: 'Example tablet',
    sourceReference: 'SRO 1092(I)/2023 / 012345',
    presentation: 'Tablet 500 mg',
    packLevel: 'BOX',
    notifiedPriceMinor: 31500,
    effectiveDate: new Date('2026-12-01'),
    createdAt: new Date('2026-11-15'),
  };
  it('shows the official price and date for information and lets the owner dismiss it', () => {
    const onDismiss = vi.fn();
    render(<DrapPriceAlertsView alerts={[alert]} onRetry={vi.fn()} onDismiss={onDismiss} />);
    const list = screen.getByRole('list', { name: 'Official price changes' });
    expect(list).toHaveTextContent(/Official price changed as of 2026-12-01: Rs\s?315\.00/);
    expect(screen.getByText(/nothing here changes a price/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss official price change for Example tablet' })
    );
    expect(onDismiss).toHaveBeenCalledWith('alert-1');
  });
  it('renders empty, error and permission states', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <DrapPriceAlertsView alerts={[]} onRetry={onRetry} onDismiss={vi.fn()} />
    );
    expect(screen.getByText('No official price changes to review.')).toBeInTheDocument();
    rerender(<DrapPriceAlertsView error onRetry={onRetry} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry official prices' }));
    expect(onRetry).toHaveBeenCalled();
    rerender(<DrapPriceAlertsView forbidden onRetry={onRetry} onDismiss={vi.fn()} />);
    expect(screen.getByText(/safety access is required/)).toBeInTheDocument();
  });
});
