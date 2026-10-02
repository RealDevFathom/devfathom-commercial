import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CounterSearchRow } from '@/lib/pharmacy/counter';
import { CounterSearchResults } from './counter-search-results';

export function searchRow(overrides: Partial<CounterSearchRow> = {}): CounterSearchRow {
  return {
    medicineId: 'med-a',
    displayName: 'Synthetic medicine',
    brandName: null,
    manufacturer: null,
    strength: null,
    presentationId: 'presentation-a',
    presentation: 'Tablets',
    dosageForm: null,
    route: null,
    matchedOn: 'NAME',
    recommendedLotId: 'lot-a',
    packLevelId: 'box',
    unitsPerPack: 100,
    printedMrpMinor: 10000,
    roundingIncrementMinor: 1,
    batchNumber: 'FEFO-A',
    nearestSafeExpiry: '2027-06-01T00:00:00.000Z',
    onHandUnits: 290,
    saleUnits: [
      { kind: 'PACK', packLevelId: 'box', levelLabel: 'BOX', canonicalUnitsPerSaleUnit: 100 },
      { kind: 'STRIP', packLevelId: 'strip', levelLabel: 'STRIP', canonicalUnitsPerSaleUnit: 10 },
      { kind: 'UNIT', packLevelId: 'unit', levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
    ],
    saleableUnits: [
      {
        kind: 'PACK',
        levelLabel: 'BOX',
        canonicalUnitsPerSaleUnit: 100,
        wholeUnits: 2,
        unitPriceMinor: 10000,
        proRataCeilingMinor: 10000,
      },
    ],
    restriction: {
      rx: false,
      otc: true,
      controlled: false,
      restricted: false,
      highAlert: false,
      lasa: false,
    },
    storage: {
      coldChain: false,
      locationKind: 'RACK_BIN',
      locationCode: 'R2-S3',
      locationName: 'Rack 2 / Shelf 3',
    },
    blocked: [],
    ...overrides,
  };
}

describe('counter search result locations and states', () => {
  it('shows actual FEFO location name/code, safe availability and batch', () => {
    const onSelect = vi.fn();
    const row = searchRow();
    render(
      <CounterSearchResults
        rows={[row]}
        state="ready"
        query="Synthetic"
        activeMedicineId={null}
        onSelect={onSelect}
        onRetry={vi.fn()}
        onCaptureDemand={vi.fn()}
      />
    );
    expect(screen.getByText('FEFO location: Rack 2 / Shelf 3 · R2-S3')).toBeVisible();
    expect(screen.getByText('Safe available')).toBeVisible();
    expect(screen.getByText('290 units')).toBeVisible();
    expect(screen.getByText('FEFO-A')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Synthetic medicine/ }));
    expect(onSelect).toHaveBeenCalledWith(row);
  });

  it.each([
    { coldChain: false, locationKind: null, locationCode: null, locationName: null },
    { coldChain: false, locationKind: 'RACK_BIN', locationCode: null },
  ])('states missing location honestly, including older response shapes', (storage) => {
    render(
      <CounterSearchResults
        rows={[searchRow({ storage })]}
        state="ready"
        query="Synthetic"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
        onCaptureDemand={vi.fn()}
      />
    );
    expect(screen.getByText('FEFO location: Not recorded')).toBeVisible();
    expect(screen.queryByText(/Shelf 3/)).not.toBeInTheDocument();
  });

  it.each(['ready', 'error'] as const)(
    'disables demand/retry controls while busy in %s state',
    (state) => {
      const onCaptureDemand = vi.fn();
      const onRetry = vi.fn();
      render(
        <CounterSearchResults
          rows={[]}
          state={state}
          query="missing"
          activeMedicineId={null}
          disabled
          onSelect={vi.fn()}
          onRetry={onRetry}
          onCaptureDemand={onCaptureDemand}
        />
      );
      for (const button of screen.getAllByRole('button')) {
        expect(button).toBeDisabled();
        fireEvent.click(button);
      }
      expect(onCaptureDemand).not.toHaveBeenCalled();
      expect(onRetry).not.toHaveBeenCalled();
    }
  );
});
