import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CounterSearchRow } from '@/lib/pharmacy/counter';

import { CounterSearchResults, otherBranchAvailabilityText } from './counter-search-results';

// DEV-907: the counter renders exactly the server's availability line — branch
// names only — and nothing at all when the server sent none.
const outOfStock: CounterSearchRow = {
  medicineId: 'med-1',
  displayName: 'Nalbin',
  brandName: null,
  manufacturer: null,
  strength: '10 mg',
  presentationId: 'presentation-1',
  presentation: 'Box of 10',
  dosageForm: 'Tablet',
  route: 'Oral',
  matchedOn: 'NAME',
  recommendedLotId: null,
  packLevelId: null,
  unitsPerPack: null,
  printedMrpMinor: null,
  roundingIncrementMinor: 1,
  batchNumber: null,
  nearestSafeExpiry: null,
  onHandUnits: 0,
  saleableUnits: [],
  saleUnits: [],
  restriction: {
    rx: false,
    otc: true,
    restricted: false,
    controlled: false,
    highAlert: false,
    lasa: false,
  },
  storage: { coldChain: false, locationKind: null, locationCode: null, locationName: null },
  blocked: [],
};

function renderRows(rows: CounterSearchRow[]) {
  return render(
    <CounterSearchResults
      rows={rows}
      state="ready"
      query="nal"
      activeMedicineId={null}
      onSelect={vi.fn()}
      onCaptureDemand={vi.fn()}
      onRetry={vi.fn()}
    />
  );
}

describe('DEV-907 counter other-branch availability line', () => {
  it('shows one line naming the other branch for an out-of-stock item', () => {
    renderRows([
      { ...outOfStock, otherBranchAvailability: { branchNames: ['Gulberg'], more: false } },
    ]);
    const line = screen.getByText(/Also in stock at/);
    expect(line).toHaveTextContent(
      'Also in stock at Gulberg. The customer buys and collects it at that branch.'
    );
    expect(screen.getByText('Gulberg')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Out of stock')).toBeVisible();
  });

  it('shows nothing when the server sends no availability (switch off)', () => {
    renderRows([outOfStock]);
    expect(screen.queryByText(/Also in stock at/)).toBeNull();
  });

  it('joins several branch names and says when more hold it', () => {
    expect(otherBranchAvailabilityText({ branchNames: ['Gulberg'], more: false })).toBe('Gulberg');
    expect(otherBranchAvailabilityText({ branchNames: ['DHA', 'Gulberg'], more: false })).toBe(
      'DHA and Gulberg'
    );
    expect(otherBranchAvailabilityText({ branchNames: ['B1', 'B2', 'B3'], more: true })).toBe(
      'B1, B2, B3 and other branches'
    );
  });
});
