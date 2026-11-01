// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  catalogueNameKey,
  catalogueNameKeys,
  catalogueStrengthKey,
  findHandEnteredMatches,
  handEnteredMatchReason,
  type CatalogueMatchItem,
  type HandEnteredMedicine,
} from './default-catalogue-match';

const DISPRIN: CatalogueMatchItem = {
  sourceKey: 'catalog-00',
  productName: 'DISPRIN 300MG TAB',
  brandName: 'DISPRIN 300MG TAB',
  manufacturer: 'RECKIT&BENCKISER(BMC )',
  strength: '300MG',
  dosageForm: 'Tablet',
};

function medicine(overrides: Partial<HandEnteredMedicine> = {}): HandEnteredMedicine {
  return {
    id: 'med_1',
    productName: 'Disprin 300mg Tab',
    brandName: null,
    manufacturer: null,
    strengths: [],
    dosageForms: ['Tablet'],
    ...overrides,
  };
}

describe('hand-entered duplicate matching', () => {
  it('normalises names, strengths and units', () => {
    expect(catalogueNameKey('DISPRIN  300MG TAB')).toBe('disprin300mgtab');
    expect(catalogueNameKey('Disprin 300mg-Tab.')).toBe('disprin300mgtab');
    expect(catalogueStrengthKey('0.50 MG')).toBe('0.5mg');
    expect(catalogueStrengthKey('500MG/5ML')).toBe('500mg/5ml');
    expect(catalogueNameKeys([DISPRIN, { ...DISPRIN, brandName: 'Disprin' }])).toEqual([
      'disprin300mgtab',
      'disprin',
    ]);
  });

  it('matches on name + strength + dosage form, and says why', () => {
    expect(
      handEnteredMatchReason(
        DISPRIN,
        medicine({
          strengths: [{ value: '300.000000', unit: 'mg' }],
          manufacturer: 'Reckit & Benckiser (BMC)',
        })
      )
    ).toBe(
      'name "disprin300mgtab" (catalogue productName = medicine productName); strength 300mg; ' +
        'dosage form tablet; manufacturer reckitbenckiserbmc'
    );
  });

  it('matches a brand name to a product name and reads a strength held only in the name', () => {
    expect(
      handEnteredMatchReason(
        DISPRIN,
        medicine({ productName: 'Aspirin', brandName: 'DISPRIN  300MG TAB' })
      )
    ).toBe(
      'name "disprin300mgtab" (catalogue productName = medicine brandName); ' +
        "strength 300mg (in the medicine's name; no structured strength); dosage form tablet; " +
        'manufacturer not compared (none on the medicine)'
    );
  });

  it('refuses a different strength, dosage form or manufacturer', () => {
    expect(
      handEnteredMatchReason(DISPRIN, medicine({ strengths: [{ value: 325, unit: 'mg' }] }))
    ).toBeNull();
    expect(handEnteredMatchReason(DISPRIN, medicine({ dosageForms: ['Syrup'] }))).toBeNull();
    expect(handEnteredMatchReason(DISPRIN, medicine({ dosageForms: [] }))).toBeNull();
    expect(handEnteredMatchReason(DISPRIN, medicine({ manufacturer: 'Bayer' }))).toBeNull();
    expect(handEnteredMatchReason(DISPRIN, medicine({ productName: 'Disprin' }))).toBeNull();
  });

  it('never reads 1mg out of an 11mg name', () => {
    const item = { ...DISPRIN, productName: 'X 11MG', brandName: 'X 11MG', strength: '1MG' };
    expect(handEnteredMatchReason(item, medicine({ productName: 'x 11mg' }))).toBeNull();
  });

  it('compares the manufacturer only when both sides have one', () => {
    const item = { ...DISPRIN, manufacturer: null };
    expect(handEnteredMatchReason(item, medicine({ manufacturer: 'Bayer' }))).toContain(
      'manufacturer not compared (none on the catalogue item)'
    );
  });

  it('lists every match in id order', () => {
    const matches = findHandEnteredMatches(DISPRIN, [
      medicine({ id: 'med_b' }),
      medicine({ id: 'med_x', productName: 'Panadol' }),
      medicine({ id: 'med_a' }),
    ]);
    expect(matches.map((match) => match.medicine.id)).toEqual(['med_a', 'med_b']);
  });
});
