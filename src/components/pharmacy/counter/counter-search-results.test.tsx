import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CounterSearchRow } from '@/lib/pharmacy/counter';

import { CounterSearchResults } from './counter-search-results';

const row: CounterSearchRow = {
  medicineId: 'med-1',
  displayName: 'Paracetamol',
  brandName: null,
  manufacturer: null,
  strength: '500 mg',
  presentationId: 'presentation-1',
  presentation: 'Tablet presentation with a long label that must remain readable',
  dosageForm: 'Tablet',
  route: 'Oral',
  matchedOn: 'NAME',
  recommendedLotId: 'lot-1',
  packLevelId: 'pack-1',
  unitsPerPack: 10,
  printedMrpMinor: 25000,
  roundingIncrementMinor: 1,
  batchNumber: 'B-1044',
  nearestSafeExpiry: '2028-06-30T00:00:00.000Z',
  onHandUnits: 240,
  saleableUnits: [],
  saleUnits: [],
  restriction: {
    rx: true,
    otc: false,
    restricted: false,
    controlled: true,
    highAlert: true,
    lasa: false,
  },
  storage: { coldChain: true, locationKind: 'FRIDGE', locationCode: 'F-1', locationName: 'Fridge' },
  blocked: [],
};

describe('CounterSearchResults safety flags', () => {
  it('lets each medicine name determine its own text direction', () => {
    render(
      <CounterSearchResults
        rows={[{ ...row, displayName: 'پیراسٹامول' }]}
        state="ready"
        query="پیرا"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('پیراسٹامول')).toHaveAttribute('dir', 'auto');
  });

  it('shows the brand with the generic name and ignores blank brand values', () => {
    const { rerender } = render(
      <CounterSearchResults
        rows={[{ ...row, brandName: 'Panadol' }]}
        state="ready"
        query="panadol"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('Panadol')).toBeVisible();
    expect(screen.getByText('Paracetamol')).toHaveClass('block');
    expect(screen.getByText('500 mg')).toBeVisible();

    rerender(
      <CounterSearchResults
        rows={[{ ...row, brandName: '   ' }]}
        state="ready"
        query="para"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('Paracetamol')).toBeVisible();
  });

  it.each(['ltr', 'rtl'])('isolates the strength from an Urdu name in a %s workspace', (dir) => {
    render(
      <div dir={dir}>
        <CounterSearchResults
          rows={[{ ...row, displayName: 'پیراسٹامول' }]}
          state="ready"
          query="پیرا"
          activeMedicineId={null}
          onSelect={vi.fn()}
          onCaptureDemand={vi.fn()}
          onRetry={vi.fn()}
        />
      </div>
    );

    // The number and Latin unit must keep their own order inside an RTL name.
    const strength = screen.getByText('500 mg');
    expect(strength.tagName).toBe('BDI');
    expect(strength).toHaveAttribute('dir', 'auto');
    expect(strength.parentElement).toHaveClass('ms-1');
    expect(strength.closest('button')).toHaveClass('text-start');
    expect(screen.getByText('250.00')).toHaveClass('text-end');
  });

  it('keeps safety badges separate while wrapping all inline medicine metadata', () => {
    render(
      <CounterSearchResults
        rows={[row]}
        state="ready"
        query="para"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    const stock = screen.getByText(/Batch B-1044/);
    expect(stock).not.toHaveClass('truncate');
    expect(stock).toHaveClass('break-words');
    expect(stock).toHaveTextContent(row.presentation);
    expect(stock).toHaveTextContent('Tablet');
    expect(stock).toHaveTextContent('Exp 2028-06-30');
    expect(stock).toHaveTextContent('240 units');
    expect(stock).toHaveTextContent('Fridge F-1');
    expect(screen.getByText('250.00')).toBeVisible();
    expect(stock).not.toHaveTextContent('Controlled');
    expect(stock).not.toHaveTextContent('Cold chain');
    for (const label of ['Controlled', 'Prescription only', 'High alert', 'Cold chain']) {
      const badge = screen.getByText(label);
      expect(badge.closest('[data-slot="status-pill"]')).toHaveClass('whitespace-nowrap');
      expect(badge.closest('[data-slot="status-pill"]')?.className).not.toContain('truncate');
    }
  });

  it('shows each result’s batch, expiry, stock, rack and price without opening details', () => {
    const rackRow: CounterSearchRow = {
      ...row,
      medicineId: 'med-2',
      displayName: 'Oral rehydration salts',
      strength: null,
      presentation: 'Sachet',
      dosageForm: 'Powder',
      printedMrpMinor: 2500,
      batchNumber: 'OR2207',
      nearestSafeExpiry: '2027-08-31T00:00:00.000Z',
      onHandUnits: 220,
      storage: { coldChain: false, locationKind: 'RACK_BIN', locationCode: 'E1' },
      saleableUnits: [
        {
          kind: 'PACK',
          levelLabel: 'Sachet',
          canonicalUnitsPerSaleUnit: 1,
          wholeUnits: 220,
          unitPriceMinor: 2500,
          proRataCeilingMinor: 2500,
        },
      ],
    };
    const onSelect = vi.fn();
    render(
      <CounterSearchResults
        rows={[row, rackRow]}
        state="ready"
        query="oral"
        activeMedicineId={rackRow.medicineId}
        onSelect={onSelect}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    const results = screen.getByRole('list', { name: 'Search results' });
    const buttons = within(results).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent('Batch B-1044');
    const medicine = buttons[1]!;
    for (const metadata of [
      '25.00',
      'Sachet',
      'Powder',
      'Batch OR2207',
      'Exp 2027-08-31',
      '220 units',
      'Rack E1',
    ]) {
      expect(medicine).toHaveTextContent(metadata);
    }
    expect(medicine).not.toHaveTextContent('Not sellable');
    expect(medicine).toHaveAttribute('aria-pressed', 'true');
    expect(medicine.tabIndex).toBe(0);
    fireEvent.click(medicine);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(rackRow);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps unavailable stock selectable for demand capture without inventing lot metadata', () => {
    const unavailable: CounterSearchRow = {
      ...row,
      printedMrpMinor: null,
      batchNumber: null,
      nearestSafeExpiry: null,
      onHandUnits: 0,
      recommendedLotId: null,
      storage: { coldChain: false, locationKind: null, locationCode: null },
      blocked: ['EXPIRED'],
    };
    const onSelect = vi.fn();
    render(
      <CounterSearchResults
        rows={[unavailable]}
        state="ready"
        query="para"
        activeMedicineId={null}
        onSelect={onSelect}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    const medicine = screen.getByRole('button', { name: /Paracetamol/ });
    expect(medicine).toHaveTextContent('Batch — · Exp — · 0 units');
    expect(medicine).toHaveTextContent('Location unavailable');
    expect(medicine).toHaveTextContent('Not sellable');
    expect(medicine).toHaveTextContent('Blocked stock present: expired.');
    expect(medicine).not.toHaveTextContent('Rack');
    expect(medicine).not.toHaveTextContent('250.00');
    expect(medicine).not.toBeDisabled();
    fireEvent.click(medicine);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(unavailable);
  });

  it('disables selection while the counter is busy or branch access is unavailable', () => {
    const onSelect = vi.fn();
    render(
      <CounterSearchResults
        rows={[row]}
        state="ready"
        query="para"
        activeMedicineId={null}
        disabled
        onSelect={onSelect}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    const medicine = screen.getByRole('button', { name: /Paracetamol/ });
    expect(medicine).toBeDisabled();
    fireEvent.click(medicine);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('retains retry and unfulfilled-demand actions for search errors and empty results', () => {
    const onRetry = vi.fn();
    const onCaptureDemand = vi.fn();
    const props = {
      rows: [],
      query: 'missing',
      activeMedicineId: null,
      onSelect: vi.fn(),
      onCaptureDemand,
      onRetry,
    };
    const { rerender } = render(
      <CounterSearchResults {...props} state="error" error="Search unavailable" />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Search unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    expect(onRetry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Capture as unfulfilled demand' }));
    expect(onCaptureDemand).toHaveBeenCalledOnce();

    rerender(<CounterSearchResults {...props} state="ready" />);
    expect(screen.getByText(/Nothing in this catalog matches/)).toHaveTextContent('missing');
    fireEvent.click(screen.getByRole('button', { name: 'Capture as unfulfilled demand' }));
    expect(onCaptureDemand).toHaveBeenCalledTimes(2);
  });
});
