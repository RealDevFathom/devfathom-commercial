import { describe, expect, it } from 'vitest';
import { buildStarterCatalogue, validateStarterCatalogue } from './starter-reference';

const item = {
  sourceId: '001',
  legacyCode: 'LEG-A',
  name: 'QA product A',
  packSize: 12,
  class: 'NARCOTICS',
  verifiedGeneric: null,
  manufacturerLabel: null,
  active: false,
  controlled: false,
};

describe('starter reference input boundary', () => {
  it('accepts verified overlays only for the same code and name, preserving inactive and controlled status', () => {
    const other = { ...item, sourceId: '002', name: 'QA product B' };
    const result = buildStarterCatalogue(
      [other, item],
      [
        { sourceId: '001', name: item.name, verifiedGeneric: 'QA generic' },
        { sourceId: '002', name: 'QA different', verifiedGeneric: 'Wrong generic' },
        { sourceId: '003', name: item.name, verifiedGeneric: 'Wrong generic' },
      ]
    );
    expect(result.rows).toEqual([
      { ...item, controlled: true, verifiedGeneric: 'QA generic' },
      { ...other, controlled: true },
    ]);
    expect(result.reconciliation).toEqual({ matched: 1, differentName: 1, absentCode: 1 });
  });

  it('rejects extra fields in either input and in the generated product', () => {
    expect(() => buildStarterCatalogue([{ ...item, stock: 1 }], [])).toThrow();
    expect(() =>
      buildStarterCatalogue([item], [{ sourceId: item.sourceId, name: item.name, supplier: 'QA' }])
    ).toThrow();
    expect(() => validateStarterCatalogue([{ ...item, price: 1 }])).toThrow();
  });

  it('refuses duplicate identities, missing required fields and uncontrolled NARCOTICS output', () => {
    expect(() => buildStarterCatalogue([item, item], [])).toThrow();
    const overlay = { sourceId: item.sourceId, name: item.name, packSize: 2 };
    expect(() => buildStarterCatalogue([item], [overlay, overlay])).toThrow();
    expect(() => validateStarterCatalogue([{ ...item, class: undefined }])).toThrow();
    expect(() => validateStarterCatalogue([item])).toThrow();
  });
});
