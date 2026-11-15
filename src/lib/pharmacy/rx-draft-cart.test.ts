import { describe, expect, it } from 'vitest';

import {
  buildRxDraftCart,
  parseReadStrength,
  type RxDraftCatalogueMedicine,
} from './rx-draft-cart';
import type { RxOcrExtraction } from './rx-ocr';

const amox = { ingredientId: 'ing-amox', ingredientName: 'Amoxicillin' };
const clav = { ingredientId: 'ing-clav', ingredientName: 'Clavulanic acid' };

const catalogue: RxDraftCatalogueMedicine[] = [
  {
    id: 'med-fathom-250',
    productName: 'Fathomcillin 250 mg capsule',
    brandName: 'Fathomcillin',
    strengths: [{ ...amox, value: '250.000000', unit: 'mg' }],
    presentations: [{ id: 'pres-fathom-250', presentation: 'Capsule' }],
  },
  {
    id: 'med-generic-250',
    productName: 'Amoxil 250 mg capsule',
    brandName: 'Amoxil',
    strengths: [{ ...amox, value: '0.25', unit: 'g' }],
    presentations: [
      { id: 'pres-generic-cap', presentation: 'Capsule' },
      { id: 'pres-generic-syr', presentation: 'Syrup' },
    ],
  },
  {
    id: 'med-fathom-500',
    productName: 'Fathomcillin 500 mg capsule',
    brandName: 'Fathomcillin',
    strengths: [{ ...amox, value: '500', unit: 'mg' }],
    presentations: [{ id: 'pres-fathom-500', presentation: 'Capsule' }],
  },
  {
    id: 'med-combo',
    productName: 'Clavfathom 625',
    brandName: null,
    strengths: [
      { ...amox, value: '500', unit: 'mg' },
      { ...clav, value: '125', unit: 'mg' },
    ],
    presentations: [{ id: 'pres-combo', presentation: 'Tablet' }],
  },
  {
    id: 'med-unrelated',
    productName: 'Panafathom 500 mg',
    brandName: null,
    strengths: [
      { ingredientId: 'ing-para', ingredientName: 'Paracetamol', value: '500', unit: 'mg' },
    ],
    presentations: [{ id: 'pres-para', presentation: 'Tablet' }],
  },
];

const field = (value: string | null, confidence = 0.9) => ({ value, confidence });

function extraction(...lines: [string | null, string | null, number?][]): RxOcrExtraction {
  return {
    adapter: 'FIXTURE',
    adapterVersion: 'fixture-rx-2026-09-29.1',
    lines: lines.map(([drug, strength, confidence]) => ({
      drugName: field(drug, confidence ?? 0.9),
      strength: field(strength, confidence ?? 0.9),
      dose: field('1 capsule every 8 hours for 5 days', 0.64),
    })),
  };
}

describe('DEV-63 Rx photo draft cart', () => {
  it('builds an unconfirmed draft from the OCR fixture line with salt and strength matches', () => {
    const cart = buildRxDraftCart(extraction(['Fathomcillin', '250 mg']), catalogue, {
      minConfidence: 0.5,
    });
    expect(cart).toMatchObject({
      status: 'DRAFT',
      requiresPharmacistConfirmation: true,
      adapter: 'FIXTURE',
      unmatchedLineNumbers: [],
    });
    const [line] = cart.lines;
    expect(line!.confirmed).toBe(false);
    // Same salt and strength, including a different brand whose strength is stored in grams.
    expect(line!.candidates.map((c) => [c.medicineId, c.matchKind, c.nameMatch])).toEqual([
      ['med-fathom-250', 'SALT_AND_STRENGTH', true],
      ['med-generic-250', 'SALT_AND_STRENGTH', false],
      ['med-fathom-500', 'SALT_ONLY', true],
    ]);
    expect(line!.candidates[0]!.salt).toBe('Amoxicillin 250 mg');
    // Two exact matches: the pharmacist chooses, nothing is suggested.
    expect(line!.suggestedMedicineId).toBeNull();
    // A combination product is not the same salt and is never offered as a substitute.
    expect(line!.candidates.some((c) => c.medicineId === 'med-combo')).toBe(false);
  });

  it('suggests (never confirms) a single exact match and its only presentation', () => {
    const cart = buildRxDraftCart(extraction(['Clavfathom', '500/125 mg']), catalogue, {
      minConfidence: 0.5,
    });
    expect(cart.lines[0]).toMatchObject({
      suggestedMedicineId: 'med-combo',
      suggestedPresentationId: 'pres-combo',
      confirmed: false,
    });
  });

  it('matches a generic salt name, flags low confidence by the configured threshold, and reports unmatched lines', () => {
    const cart = buildRxDraftCart(
      extraction(['Amoxicillin', '0.5 g', 0.4], ['Unknownmycin', '10 mg']),
      catalogue,
      { minConfidence: 0.5 }
    );
    expect(cart.lines[0]!.candidates[0]).toMatchObject({
      medicineId: 'med-fathom-500',
      matchKind: 'SALT_AND_STRENGTH',
    });
    expect(cart.lines[0]!.lowConfidence).toBe(true);
    expect(cart.lines[1]!.candidates).toEqual([]);
    expect(cart.unmatchedLineNumbers).toEqual([2]);
    const relaxed = buildRxDraftCart(extraction(['Amoxicillin', '0.5 g', 0.4]), catalogue, {
      minConfidence: 0.3,
    });
    expect(relaxed.lines[0]!.lowConfidence).toBe(false);
    expect(() => buildRxDraftCart(extraction(), catalogue, { minConfidence: 2 })).toThrow(
      RangeError
    );
  });

  it('parses strengths across units and combinations', () => {
    expect(parseReadStrength('250mg')).toEqual(parseReadStrength('0.25 g'));
    expect(parseReadStrength('500/125 mg')).toHaveLength(2);
    expect(parseReadStrength('as directed')).toEqual([]);
    expect(parseReadStrength(null)).toEqual([]);
  });

  it('keeps a concentration denominator: 250 mg/5 ml is 50 mg/ml, not 250 mg/ml', () => {
    const syrups: RxDraftCatalogueMedicine[] = [
      {
        id: 'syrup-250-per-ml',
        productName: 'Fathomcillin Forte syrup',
        brandName: 'Fathomcillin',
        strengths: [{ ...amox, value: '250', unit: 'mg/ml' }],
        presentations: [{ id: 'p1', presentation: 'Syrup' }],
      },
      {
        id: 'syrup-250-per-5ml',
        productName: 'Amoxil syrup',
        brandName: 'Amoxil',
        strengths: [{ ...amox, value: '250', unit: 'mg/5 ml' }],
        presentations: [{ id: 'p2', presentation: 'Syrup' }],
      },
    ];
    const cart = buildRxDraftCart(extraction(['Fathomcillin', '250 mg/5 ml']), syrups, {
      minConfidence: 0.5,
    });
    expect(
      Object.fromEntries(cart.lines[0]!.candidates.map((c) => [c.medicineId, c.matchKind]))
    ).toEqual({ 'syrup-250-per-5ml': 'SALT_AND_STRENGTH', 'syrup-250-per-ml': 'SALT_ONLY' });
    expect(cart.lines[0]!.suggestedMedicineId).toBe('syrup-250-per-5ml');
    expect(parseReadStrength('50 mg/ml')).toEqual(parseReadStrength('250 mg/5 ml'));
  });

  it('keeps each amount with its own ingredient in a combination', () => {
    const swapped: RxDraftCatalogueMedicine = {
      id: 'med-swapped',
      productName: 'Swapfathom',
      brandName: null,
      strengths: [
        { ...amox, value: '125', unit: 'mg' },
        { ...clav, value: '500', unit: 'mg' },
      ],
      presentations: [{ id: 'pres-swapped', presentation: 'Tablet' }],
    };
    const brand = buildRxDraftCart(
      extraction(['Clavfathom', '500/125 mg']),
      [...catalogue, swapped],
      {
        minConfidence: 0.5,
      }
    );
    expect(
      Object.fromEntries(brand.lines[0]!.candidates.map((c) => [c.medicineId, c.matchKind]))
    ).toEqual({ 'med-combo': 'SALT_AND_STRENGTH', 'med-swapped': 'SALT_ONLY' });
    const onlySwapped = buildRxDraftCart(
      extraction(['Amoxicillin + Clavulanic acid', '500/125 mg']),
      [swapped],
      { minConfidence: 0.5 }
    );
    expect(onlySwapped.lines[0]!.candidates[0]!.matchKind).toBe('SALT_ONLY');
    expect(onlySwapped.lines[0]!.suggestedMedicineId).toBeNull();
  });

  it('resolves every named ingredient of a generic combination, never monotherapy', () => {
    const cart = buildRxDraftCart(
      extraction(['Amoxicillin + Clavulanic acid', '500 mg + 125 mg']),
      catalogue,
      { minConfidence: 0.5 }
    );
    expect(cart.lines[0]!.candidates.map((c) => [c.medicineId, c.matchKind])).toEqual([
      ['med-combo', 'SALT_AND_STRENGTH'],
    ]);
    expect(cart.lines[0]!.suggestedMedicineId).toBe('med-combo');
    // An unknown second ingredient leaves the line unmatched rather than half-matched.
    const partial = buildRxDraftCart(
      extraction(['Amoxicillin + Unknownbactam', '500/125 mg']),
      catalogue,
      { minConfidence: 0.5 }
    );
    expect(partial.lines[0]!.candidates).toEqual([]);
  });
});
