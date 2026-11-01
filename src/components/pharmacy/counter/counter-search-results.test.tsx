import { render, screen } from '@testing-library/react';
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
  presentation: 'Tablet presentation that is long enough to truncate',
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

  it('keeps controlled, prescription, high-alert, and cold-chain badges off the truncated stock line', () => {
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
    expect(stock.className).toContain('truncate');
    expect(stock).toHaveTextContent('240 units');
    expect(stock).not.toHaveTextContent('Controlled');
    expect(stock).not.toHaveTextContent('Cold chain');
    for (const label of ['Controlled', 'Prescription only', 'High alert', 'Cold chain']) {
      const badge = screen.getByText(label);
      expect(badge.closest('[data-slot="status-pill"]')).toHaveClass('whitespace-nowrap');
      expect(badge.closest('[data-slot="status-pill"]')?.className).not.toContain('truncate');
    }
  });

  it('shows Out of stock instead of an empty batch and expiry, with no match-reason tag', () => {
    render(
      <CounterSearchResults
        rows={[
          {
            ...row,
            batchNumber: null,
            nearestSafeExpiry: null,
            onHandUnits: 0,
            restriction: { ...row.restriction, controlled: false, highAlert: false },
            storage: { ...row.storage, coldChain: false, locationKind: null, locationCode: null },
          },
        ]}
        state="ready"
        query="para"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    const stock = screen.getByText(/Out of stock/);
    expect(stock.textContent).toBe(
      'Tablet presentation that is long enough to truncate · Tablet · Out of stock'
    );
    expect(stock).not.toHaveTextContent('Batch');
    expect(stock).not.toHaveTextContent('Exp');
    expect(stock).not.toHaveTextContent('0 units');
    expect(stock).not.toHaveTextContent('Not sellable');
    expect(stock).not.toHaveTextContent('Name');
  });

  it('offers to record a missing medicine as unmet demand', () => {
    const onCaptureDemand = vi.fn();
    render(
      <CounterSearchResults
        rows={[]}
        state="ready"
        query="zzz"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={onCaptureDemand}
        onRetry={vi.fn()}
      />
    );
    screen.getByRole('button', { name: 'Record as unmet demand' }).click();
    expect(onCaptureDemand).toHaveBeenCalledOnce();
  });
});
