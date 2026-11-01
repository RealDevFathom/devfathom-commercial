import { describe, expect, it } from 'vitest';

import {
  addToCartDisabledReason,
  counterSearchStockText,
  findReceiptDisabledReason,
  prescriptionCustodyLabel,
  tenderDisabledReason,
  type TenderReasonInput,
} from './counter-display';

const JARGON = /canonical|pack hierarchy|FEFO|shortfall/i;

describe('addToCartDisabledReason', () => {
  const stocked = { onHandUnits: 40, saleUnitCount: 2, priced: true };

  it('stays quiet while the counter is busy or when the line can be added', () => {
    expect(
      addToCartDisabledReason({ busy: true, row: null, unitSelected: false, preview: null })
    ).toBeNull();
    expect(
      addToCartDisabledReason({
        busy: false,
        row: stocked,
        unitSelected: true,
        preview: { sufficient: true, availableUnits: 40 },
      })
    ).toBeNull();
  });

  it('asks for a medicine when nothing is selected', () => {
    expect(
      addToCartDisabledReason({ busy: false, row: null, unitSelected: false, preview: null })
    ).toBe('Select a medicine from the search results first.');
  });

  it('says out of stock and points to unmet demand when nothing is on hand', () => {
    const reason = addToCartDisabledReason({
      busy: false,
      row: { onHandUnits: 0, saleUnitCount: 0, priced: true },
      unitSelected: false,
      preview: null,
    });
    expect(reason).toBe('Out of stock. Record it as unmet demand instead.');
  });

  it('explains a pack-size problem in plain words when stock exists but has no sale unit', () => {
    const reason = addToCartDisabledReason({
      busy: false,
      row: { onHandUnits: 12, saleUnitCount: 0, priced: true },
      unitSelected: false,
      preview: null,
    });
    expect(reason).toContain('pack sizes');
    expect(reason).not.toMatch(JARGON);
  });

  it('asks for a sale unit, a price, or a lower quantity as appropriate', () => {
    expect(
      addToCartDisabledReason({ busy: false, row: stocked, unitSelected: false, preview: null })
    ).toBe('Choose pack, strip or unit first.');
    expect(
      addToCartDisabledReason({
        busy: false,
        row: { ...stocked, priced: false },
        unitSelected: true,
        preview: null,
      })
    ).toBe('This medicine has no price yet. Ask your manager to set it.');
    expect(
      addToCartDisabledReason({
        busy: false,
        row: stocked,
        unitSelected: true,
        preview: { sufficient: false, availableUnits: 40 },
      })
    ).toBe('Only 40 units in stock. Lower the quantity.');
  });
});

describe('findReceiptDisabledReason', () => {
  it('asks for a receipt number when the field is empty', () => {
    expect(findReceiptDisabledReason({ locked: false, value: '' })).toBe(
      'Enter a receipt number.'
    );
    expect(findReceiptDisabledReason({ locked: false, value: '   ' })).toBe(
      'Enter a receipt number.'
    );
  });

  it.each(['-0000', '0', '-5', '1.5'])('explains an unusable receipt number %s', (value) => {
    expect(findReceiptDisabledReason({ locked: false, value })).toBe(
      'Enter the receipt number as printed, for example 1042.'
    );
  });

  it('returns null for a valid number or while the panel is locked', () => {
    expect(findReceiptDisabledReason({ locked: false, value: '1042' })).toBeNull();
    expect(findReceiptDisabledReason({ locked: true, value: '' })).toBeNull();
  });
});

describe('tenderDisabledReason', () => {
  const ready: TenderReasonInput = {
    state: 'ready',
    balanceMinor: 25_000,
    disabled: false,
    takingPayment: false,
    unknownOutcome: false,
    blocked: false,
    amountValid: true,
    cashProblem: false,
    manual: false,
    manualLoading: false,
    manualReady: true,
    manualDetailsValid: true,
    khata: false,
    khataLoading: false,
    khataAccountChosen: true,
    khataOverLimitUnapproved: false,
  };

  it('returns null when payment can be taken', () => {
    expect(tenderDisabledReason(ready)).toBeNull();
  });

  it('leaves non-ready bills to the status line above the button', () => {
    for (const state of ['idle', 'loading', 'stale', 'error', 'unavailable'] as const) {
      expect(tenderDisabledReason({ ...ready, state })).toBeNull();
    }
    expect(tenderDisabledReason({ ...ready, unknownOutcome: true })).toBeNull();
    expect(tenderDisabledReason({ ...ready, takingPayment: true })).toBeNull();
  });

  it('says a settled bill is fully paid', () => {
    expect(tenderDisabledReason({ ...ready, state: 'settled', balanceMinor: 0 })).toBe(
      'This bill is fully paid.'
    );
  });

  it('names the first thing the cashier must fix', () => {
    expect(tenderDisabledReason({ ...ready, blocked: true })).toBe(
      'Clear the safety block on this bill first.'
    );
    expect(tenderDisabledReason({ ...ready, amountValid: false })).toBe(
      'Enter an amount up to the balance due.'
    );
    expect(tenderDisabledReason({ ...ready, cashProblem: true })).toBe('Check the cash received.');
    expect(tenderDisabledReason({ ...ready, manual: true, manualDetailsValid: false })).toBe(
      'Enter the payer name and payment reference.'
    );
    expect(tenderDisabledReason({ ...ready, manual: true, manualReady: false })).toBe(
      'Payment details for this method are not set up.'
    );
    expect(tenderDisabledReason({ ...ready, khata: true, khataAccountChosen: false })).toBe(
      'Choose a khata account.'
    );
    expect(tenderDisabledReason({ ...ready, khata: true, khataOverLimitUnapproved: true })).toBe(
      'This goes over the credit limit. The owner must approve it.'
    );
  });
});

describe('counterSearchStockText', () => {
  const base = {
    presentation: '10 x 10',
    dosageForm: 'Capsule',
    batchNumber: 'B-7',
    nearestSafeExpiry: '2028-06-30T00:00:00.000Z',
    onHandUnits: 30,
    sellable: true,
    notes: ['Store'],
  };

  it('shows batch, expiry and stock for a medicine on hand', () => {
    expect(counterSearchStockText(base)).toBe(
      '10 x 10 · Capsule · Batch B-7 · Exp 2028-06-30 · 30 units · Store'
    );
  });

  it('shows Out of stock rather than empty batch and expiry placeholders', () => {
    const text = counterSearchStockText({
      ...base,
      batchNumber: null,
      nearestSafeExpiry: null,
      onHandUnits: 0,
      sellable: false,
      notes: [],
    });
    expect(text).toBe('10 x 10 · Capsule · Out of stock');
    expect(text).not.toContain('—');
  });

  it('flags stock that cannot be sold yet', () => {
    expect(counterSearchStockText({ ...base, sellable: false, notes: [] })).toBe(
      '10 x 10 · Capsule · Batch B-7 · Exp 2028-06-30 · 30 units · Cannot be sold yet'
    );
  });
});

describe('prescriptionCustodyLabel', () => {
  it('describes where the original prescription is in plain words', () => {
    expect(prescriptionCustodyLabel('HELD_AT_PHARMACY')).toBe('Original kept here');
    expect(prescriptionCustodyLabel('NOT_HELD')).toBe('Patient kept original');
    expect(prescriptionCustodyLabel('SOMETHING_NEW')).toBe('something new');
  });
});
