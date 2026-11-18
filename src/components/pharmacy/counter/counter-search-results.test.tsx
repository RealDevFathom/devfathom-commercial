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

  it('shows the brand with the generic name without changing selection or price', () => {
    const brandedRow: CounterSearchRow = { ...row, brandName: ' Panadol ' };
    const onSelect = vi.fn();
    const { rerender } = render(
      <CounterSearchResults
        rows={[brandedRow]}
        state="ready"
        query="panadol"
        activeMedicineId={brandedRow.medicineId}
        onSelect={onSelect}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('Panadol')).toBeVisible();
    expect(screen.getByText('Paracetamol')).toHaveClass('block');
    expect(screen.getByText('Paracetamol')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('500 mg')).toBeVisible();
    const result = screen.getByRole('button', { name: /Panadol.*Paracetamol/ });
    expect(result).toHaveTextContent('250.00');
    expect(result).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(result);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(brandedRow);

    rerender(
      <CounterSearchResults
        rows={[brandedRow]}
        state="ready"
        query="panadol"
        activeMedicineId={brandedRow.medicineId}
        disabled
        onSelect={onSelect}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    const disabledResult = screen.getByRole('button', { name: /Panadol.*Paracetamol/ });
    expect(disabledResult).toBeDisabled();
    fireEvent.click(disabledResult);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(brandedRow);
  });

  it.each([null, '', '   '])('falls back to the product name for brand %j', (brandName) => {
    render(
      <CounterSearchResults
        rows={[{ ...row, brandName }]}
        state="ready"
        query="para"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getAllByText('Paracetamol')).toHaveLength(1);
    expect(screen.getByText('Paracetamol')).toBeVisible();
    expect(screen.getByText('Paracetamol')).not.toHaveClass('block');
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
    expect(stock).toHaveTextContent('240 tabs');
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

  it('shows stock as boxes + strips with the tablet total, not a raw unit count (DEV-727)', () => {
    const boxed: CounterSearchRow = {
      ...row,
      onHandUnits: 573,
      saleableUnits: [
        {
          kind: 'PACK',
          levelLabel: 'BOX',
          canonicalUnitsPerSaleUnit: 100,
          wholeUnits: 5,
          unitPriceMinor: 25000,
          proRataCeilingMinor: 25000,
        },
        {
          kind: 'STRIP',
          levelLabel: 'STRIP',
          canonicalUnitsPerSaleUnit: 10,
          wholeUnits: 57,
          unitPriceMinor: 2500,
          proRataCeilingMinor: 2500,
        },
        {
          kind: 'UNIT',
          levelLabel: 'UNIT',
          canonicalUnitsPerSaleUnit: 1,
          wholeUnits: 573,
          unitPriceMinor: 250,
          proRataCeilingMinor: 250,
        },
      ],
    };
    render(
      <CounterSearchResults
        rows={[boxed]}
        state="ready"
        query="para"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    const stock = screen.getByText(/Batch B-1044/);
    expect(stock).toHaveTextContent('5 boxes + 7 strips + 3 tabs (573 tabs)');
    expect(stock).not.toHaveTextContent('573 units');
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
    expect(medicine).toHaveTextContent('0 tabs');
    expect(medicine).not.toHaveTextContent('Batch');
    expect(medicine).not.toHaveTextContent('Exp —');
    expect(medicine).toHaveTextContent('Location unavailable');
    expect(medicine).toHaveTextContent('Not sellable');
    expect(medicine).toHaveTextContent('Blocked stock present: expired.');
    expect(medicine).not.toHaveTextContent('Rack');
    expect(medicine).not.toHaveTextContent('250.00');
    expect(medicine).not.toBeDisabled();
    fireEvent.click(medicine);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(unavailable);
  });

  it('labels a medicine with no stock at this branch as out of stock, not unsellable', () => {
    const empty: CounterSearchRow = {
      ...row,
      printedMrpMinor: null,
      batchNumber: null,
      nearestSafeExpiry: null,
      onHandUnits: 0,
      recommendedLotId: null,
      saleUnits: [],
      saleableUnits: [],
      storage: { coldChain: false, locationKind: null, locationCode: null },
      blocked: [],
    };
    render(
      <CounterSearchResults
        rows={[empty]}
        state="ready"
        query="para"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    const medicine = screen.getByRole('button', { name: /Paracetamol/ });
    expect(medicine).toHaveTextContent('Out of stock');
    expect(medicine).not.toHaveTextContent('Not sellable');
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

  it.each([null, undefined])('uses the search error fallback for %j', (error) => {
    render(
      <CounterSearchResults
        rows={[]}
        state="error"
        query="para"
        activeMedicineId={null}
        error={error}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Search failed.');
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

it.each(['batch', 'expiry'])('keeps known metadata when only %s is missing', (missing) => {
  render(
    <CounterSearchResults
      rows={[
        { ...row, ...(missing === 'batch' ? { batchNumber: null } : { nearestSafeExpiry: null }) },
      ]}
      state="ready"
      query="para"
      activeMedicineId={null}
      onSelect={vi.fn()}
      onCaptureDemand={vi.fn()}
      onRetry={vi.fn()}
    />
  );
  const medicine = screen.getByRole('button', { name: /Paracetamol/ });
  expect(medicine).not.toHaveTextContent(/Batch —|Exp —|MISSING_|null/);
  // DEV-853: a sellable lot whose batch or expiry was never recorded says so
  // in plain words instead of leaving the field out.
  if (missing === 'batch') {
    expect(medicine).toHaveTextContent('Batch not recorded');
    expect(medicine).toHaveTextContent('Exp 2028-06-30');
  } else {
    expect(medicine).toHaveTextContent('Batch B-1044');
    expect(medicine).toHaveTextContent('Expiry not recorded');
    expect(medicine).not.toHaveTextContent(/Exp \d/);
  }
});

describe('DEV-41 remaining disabled explanations for branch search', () => {
  it.each(['ready', 'error'] as const)(
    'explains disabled %s search controls and preserves callbacks',
    (state) => {
      const onSelect = vi.fn();
      const onCaptureDemand = vi.fn();
      const onRetry = vi.fn();
      const props = {
        rows: [row],
        state,
        query: 'para',
        activeMedicineId: null,
        onSelect,
        onCaptureDemand,
        onRetry,
      };
      const view = render(
        <CounterSearchResults
          {...props}
          disabled
          disabledReason="Select a branch you can access before continuing."
        />
      );
      const buttons = screen.getAllByRole('button');
      for (const button of buttons) {
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription(
          'Select a branch you can access before continuing.'
        );
        fireEvent.click(button);
      }
      expect(onSelect).not.toHaveBeenCalled();
      expect(onCaptureDemand).not.toHaveBeenCalled();
      expect(onRetry).not.toHaveBeenCalled();
      view.rerender(<CounterSearchResults {...props} disabled={false} />);
      for (const button of screen.getAllByRole('button')) {
        expect(button).toBeEnabled();
        expect(button).not.toHaveAccessibleDescription();
      }
    }
  );
});

describe('DEV-41 shared and standalone search explanations', () => {
  it.each(['ready', 'empty', 'error'] as const)(
    'uses one parent explanation for %s controls and restores the standalone fallback',
    (state) => {
      const reason = 'Wait for the current counter action to finish.';
      const props = {
        rows: state === 'empty' ? [] : [row],
        state: state === 'error' ? ('error' as const) : ('ready' as const),
        query: 'para',
        activeMedicineId: null,
        onSelect: vi.fn(),
        onCaptureDemand: vi.fn(),
        onRetry: vi.fn(),
      };
      const view = render(
        <>
          <p id="parent-search-reason">{reason}</p>
          <CounterSearchResults {...props} disabled disabledReasonId="parent-search-reason" />
        </>
      );
      expect(screen.getAllByText(reason)).toHaveLength(1);
      for (const button of screen.getAllByRole('button')) {
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription(reason);
        expect(button).toHaveAttribute('aria-describedby', 'parent-search-reason');
        fireEvent.click(button);
      }
      expect(props.onSelect).not.toHaveBeenCalled();
      expect(props.onCaptureDemand).not.toHaveBeenCalled();
      expect(props.onRetry).not.toHaveBeenCalled();
      view.rerender(<CounterSearchResults {...props} disabled />);
      expect(screen.getAllByText(reason)).toHaveLength(1);
      expect(screen.getByText(reason)).toBeVisible();
      for (const button of screen.getAllByRole('button')) {
        expect(button).toHaveAccessibleDescription(reason);
        expect(button).not.toHaveAttribute('aria-describedby', 'parent-search-reason');
      }
      view.rerender(
        <CounterSearchResults {...props} disabled={false} disabledReasonId="parent-search-reason" />
      );
      expect(screen.queryByText(reason)).not.toBeInTheDocument();
      for (const button of screen.getAllByRole('button')) {
        expect(button).toBeEnabled();
        expect(button).not.toHaveAccessibleDescription();
      }
    }
  );

  it('shows the salt and strength under the product name when recorded (DEV-862)', () => {
    render(
      <CounterSearchResults
        rows={[{ ...row, brandName: 'Panadol', composition: 'paracetamol 500 mg' }]}
        state="ready"
        query="para"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText('paracetamol 500 mg')).toBeVisible();
  });

  it('shows no composition line when none is recorded (DEV-862)', () => {
    render(
      <CounterSearchResults
        rows={[{ ...row, composition: null }]}
        state="ready"
        query="para"
        activeMedicineId={null}
        onSelect={vi.fn()}
        onCaptureDemand={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.queryByText(/paracetamol 500/)).not.toBeInTheDocument();
  });
});

describe('DEV-878 stock alternatives in search results', () => {
  const alternative: CounterSearchRow = {
    ...row,
    medicineId: 'alternative',
    brandName: 'Synthetic brand',
    onHandUnits: 30,
    restriction: { ...row.restriction, controlled: false },
    saleableUnits: [
      {
        kind: 'PACK',
        levelLabel: 'BOX',
        canonicalUnitsPerSaleUnit: 10,
        wholeUnits: 3,
        unitPriceMinor: 25000,
        proRataCeilingMinor: 25000,
      },
    ],
  };
  function props() {
    return {
      state: 'ready' as const,
      query: 'Nalbin',
      activeMedicineId: null,
      onSelect: vi.fn(),
      onCaptureDemand: vi.fn(),
      onRetry: vi.fn(),
    };
  }
  it('automatically displays exact and different-form groups with pack, price, quantity and pharmacist disclaimer', () => {
    const callbacks = props();
    const other = {
      ...alternative,
      medicineId: 'other-form',
      dosageForm: 'Injection',
      brandName: 'Other form brand',
    };
    const unavailable = {
      ...row,
      onHandUnits: 0,
      stockAlternatives: {
        ingredientRecorded: true,
        exact: [alternative],
        other: [other],
        truncated: false,
      },
    };
    render(<CounterSearchResults {...callbacks} rows={[unavailable]} />);
    const exact = screen.getByRole('list', { name: 'Same ingredient, strength and form' });
    const different = screen.getByRole('list', { name: 'Other strengths or forms' });
    expect(exact).toHaveTextContent('Synthetic brand');
    expect(exact).toHaveTextContent('500 mg');
    expect(exact).toHaveTextContent('Tablet');
    expect(exact).toHaveTextContent('Pack: 10 units');
    expect(exact).toHaveTextContent('250.00');
    expect(exact).toHaveTextContent('30 tabs');
    expect(exact).not.toHaveTextContent('Other form brand');
    expect(different).toHaveTextContent('Other form brand');
    expect(screen.getByText('Suggestion only')).toBeVisible();
    expect(screen.getByText(/the pharmacist decides on substitution/)).toBeVisible();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    fireEvent.click(within(exact).getByRole('button'));
    expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith(alternative);
  });
  it('displays the missing-ingredient gap and never offers a choice', () => {
    render(
      <CounterSearchResults
        {...props()}
        rows={[
          {
            ...row,
            onHandUnits: 0,
            stockAlternatives: {
              ingredientRecorded: false,
              exact: [],
              other: [],
              truncated: false,
            },
          },
        ]}
      />
    );
    expect(screen.getByText('No ingredient recorded for this product')).toBeVisible();
    expect(
      screen.queryByRole('list', { name: 'Same ingredient, strength and form' })
    ).not.toBeInTheDocument();
  });
  it('says when more same-ingredient brands may be in stock than were checked', () => {
    const rows = (truncated: boolean) => [
      {
        ...row,
        onHandUnits: 0,
        stockAlternatives: { ingredientRecorded: true, exact: [alternative], other: [], truncated },
      },
    ];
    const view = render(<CounterSearchResults {...props()} rows={rows(true)} />);
    expect(screen.getByText(/More brands with this ingredient may be in stock/)).toBeVisible();
    view.rerender(<CounterSearchResults {...props()} rows={rows(false)} />);
    expect(screen.queryByText(/More brands with this ingredient/)).not.toBeInTheDocument();
  });

  it('explains when no exact brand is available', () => {
    render(
      <CounterSearchResults
        {...props()}
        rows={[
          {
            ...row,
            onHandUnits: 0,
            stockAlternatives: { ingredientRecorded: true, exact: [], other: [], truncated: false },
          },
        ]}
      />
    );
    expect(screen.getByText(/No in-stock brand with the same ingredient/)).toBeVisible();
  });
  it('keeps alternative selection disabled while the counter is busy', () => {
    const callbacks = props();
    render(
      <CounterSearchResults
        {...callbacks}
        disabled
        rows={[
          {
            ...row,
            onHandUnits: 0,
            stockAlternatives: {
              ingredientRecorded: true,
              exact: [alternative],
              other: [],
              truncated: false,
            },
          },
        ]}
      />
    );
    const option = within(
      screen.getByRole('list', { name: 'Same ingredient, strength and form' })
    ).getByRole('button');
    expect(option).toBeDisabled();
    fireEvent.click(option);
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    // One visible explanation describes the match and its nested alternatives.
    const reason = 'Wait for the current counter action to finish.';
    expect(screen.getAllByText(reason)).toHaveLength(1);
    expect(option).toHaveAccessibleDescription(reason);
  });
});

it('separates strength, form and stock into labeled lines below the medicine identity', () => {
  render(
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
  const result = screen.getByRole('button', { name: /Panadol.*Paracetamol/ });
  for (const label of ['Strength:', 'Form:', 'Stock:']) {
    const field = within(result).getByText(label).parentElement;
    expect(field).toHaveClass('block');
  }
  expect(within(result).getByText('Strength:').parentElement).toHaveTextContent('500 mg');
  expect(within(result).getByText('Form:').parentElement).toHaveTextContent('Tablet');
  expect(within(result).getByText('Stock:').parentElement).toHaveTextContent('240 tabs');
});
