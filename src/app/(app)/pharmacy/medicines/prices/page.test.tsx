import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyMedicine: {
      priceNotices: { useQuery: () => ({ isLoading: true }) },
      confirmPrices: { useMutation: () => ({}) },
    },
  },
}));
import MedicinePricesPage from './page';
import { PriceNoticesView, pricesCsv } from '@/components/pharmacy/medicines/price-notices';
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
const data = { asOf: new Date('2026-09-29'), rows: [row] };
const base = { onRetry: vi.fn(), onConfirm: vi.fn(async () => undefined) };
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
  it('keeps mapping rows unselectable; confirms eligible selection explicitly', async () => {
    render(
      <PriceNoticesView
        {...base}
        data={{
          ...data,
          rows: [
            row,
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
    expect(screen.queryByLabelText('Select unmapped')).not.toBeInTheDocument();
    expect(screen.getByText('گولی')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review 0 selected' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Select =SRO-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 selected' }));
    expect(base.onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pack prices' }));
    await waitFor(() => expect(base.onConfirm).toHaveBeenCalledWith(['proposal']));
    expect(await screen.findByRole('status')).toHaveTextContent('confirmed');
  });
  it('exports UTF-8 aliases, formula-safe identifiers and blank unknown prices', () => {
    const csv = pricesCsv(data);
    expect(csv).toContain('گولی');
    expect(csv).toContain('"\'=SRO-1"');
    expect(csv).toContain('"300","200","","",""');
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });
});
