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
  it('lets the medicine name choose its direction from its content', () => {
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

    const medicineName = screen.getByText('پیراسٹامول');
    expect(medicineName).toHaveAttribute('dir', 'auto');
    expect(medicineName).toHaveClass('text-start');
    expect(medicineName).not.toHaveClass('text-left');
    expect(screen.getByText('500 mg')).toHaveClass('ms-1');
    expect(screen.getByText('500 mg')).not.toHaveClass('ml-1');
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
});
