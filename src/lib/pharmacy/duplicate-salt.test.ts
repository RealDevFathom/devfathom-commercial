import { describe, expect, it } from 'vitest';

import {
  duplicateSaltGroups,
  duplicateSaltIngredientKey,
  type DuplicateSaltLine,
} from './duplicate-salt';

const paracetamol = { ingredientId: 'ing-pcm', name: 'Paracetamol' };
const caffeine = { ingredientId: 'ing-caf', name: 'Caffeine' };
const ibuprofen = { ingredientId: 'ing-ibu', name: 'Ibuprofen' };

function line(
  ref: string,
  medicineId: string,
  displayName: string,
  activeIngredients: DuplicateSaltLine['activeIngredients']
): DuplicateSaltLine {
  return { ref, medicineId, displayName, activeIngredients };
}

describe('duplicateSaltGroups (#724)', () => {
  it('groups two paracetamol brands on one bill', () => {
    expect(
      duplicateSaltGroups([
        line('l1', 'panadol', 'Panadol 500mg', [paracetamol]),
        line('l2', 'calpol', 'Calpol 500mg', [paracetamol]),
      ])
    ).toEqual([
      {
        ingredientKey: 'paracetamol',
        ingredientName: 'Paracetamol',
        medicines: [
          { medicineId: 'panadol', displayName: 'Panadol 500mg', ref: 'l1' },
          { medicineId: 'calpol', displayName: 'Calpol 500mg', ref: 'l2' },
        ],
      },
    ]);
  });

  it('detects a shared salt inside a combination product', () => {
    const groups = duplicateSaltGroups([
      line('l1', 'panadol', 'Panadol', [paracetamol]),
      line('l2', 'panadol-extra', 'Panadol Extra', [paracetamol, caffeine]),
    ]);
    expect(groups.map((group) => group.ingredientKey)).toEqual(['paracetamol']);
  });

  it('matches the same salt across catalog rows that differ only in case or spacing', () => {
    const groups = duplicateSaltGroups([
      line('l1', 'a', 'Brand A', [{ ingredientId: 'x1', name: 'Paracetamol' }]),
      line('l2', 'b', 'Brand B', [{ ingredientId: 'x2', name: '  paracetamol ' }]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.medicines.map((medicine) => medicine.medicineId)).toEqual(['a', 'b']);
  });

  it('does not flag the same medicine sold on two lines', () => {
    expect(
      duplicateSaltGroups([
        line('l1', 'panadol', 'Panadol', [paracetamol]),
        line('l2', 'panadol', 'Panadol', [paracetamol]),
      ])
    ).toEqual([]);
  });

  it('does not flag medicines with different salts or with no ingredient data', () => {
    expect(
      duplicateSaltGroups([
        line('l1', 'panadol', 'Panadol', [paracetamol]),
        line('l2', 'brufen', 'Brufen', [ibuprofen]),
        line('l3', 'unknown', 'Unknown', []),
      ])
    ).toEqual([]);
  });

  it('lists three brands of one salt once, in cart order', () => {
    const groups = duplicateSaltGroups([
      line('l1', 'a', 'A', [paracetamol]),
      line('l2', 'b', 'B', [paracetamol]),
      line('l3', 'a', 'A', [paracetamol]),
      line('l4', 'c', 'C', [paracetamol]),
    ]);
    expect(groups[0]!.medicines.map((medicine) => medicine.ref)).toEqual(['l1', 'l2', 'l4']);
  });

  it('normalizes ingredient keys deterministically', () => {
    expect(duplicateSaltIngredientKey('  Para   Cetamol ')).toBe('para cetamol');
  });
});
