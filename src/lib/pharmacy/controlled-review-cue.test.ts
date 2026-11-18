import { describe, expect, it } from 'vitest';

import {
  CONTROLLED_REVIEW_FLAG,
  controlledReviewCues,
  legacyGroupingCells,
} from './controlled-review-cue';

describe('DEV-854 legacy controlled-drug review cues', () => {
  it.each(['NARCOTICS', 'Narcotics', ' narcotic drugs ', 'NARCOTCS', 'NARKOTICS'])(
    'holds a legacy %j class for pharmacist review',
    (legacyClass) => {
      expect(controlledReviewCues({ legacyClass })).toEqual(['LEGACY_CLASS_NARCOTICS']);
    }
  );

  it('treats distributor-name classes and ordinary categories as no cue', () => {
    expect(
      controlledReviewCues({
        legacyClass: 'Muller & Phipps',
        legacyCategory: 'Antibiotcs',
        productName: 'Amoxil 500mg Capsule',
      })
    ).toEqual([]);
    expect(controlledReviewCues({})).toEqual([]);
  });

  it('flags controlled terms in a misspelled category and suspected substances by name', () => {
    expect(
      controlledReviewCues({
        legacyClass: 'Getz Pharma',
        legacyCategory: 'Psychotrophic',
        productName: 'Xanax 0.5mg',
        alias: 'Alprazolam',
      })
    ).toEqual(['LEGACY_CATEGORY_CONTROLLED_TERM', 'NAME_SUGGESTS_CONTROLLED_SUBSTANCE']);
    expect(controlledReviewCues({ productName: 'TRAMADOL 50MG CAP' })).toEqual([
      'NAME_SUGGESTS_CONTROLLED_SUBSTANCE',
    ]);
    // Whole words only: a longer unrelated word does not match a substance.
    expect(controlledReviewCues({ productName: 'Codeinex syrup base' })).toEqual([]);
  });

  it('finds the legacy class and category by header, ignoring lineage columns', () => {
    expect(
      legacyGroupingCells({
        Name: 'X',
        classname: 'NARCOTICS',
        Category: 'Tablets',
        __review_flags: CONTROLLED_REVIEW_FLAG,
      })
    ).toEqual({ legacyClass: 'NARCOTICS', legacyCategory: 'Tablets' });
    expect(legacyGroupingCells({ Name: 'X' })).toEqual({
      legacyClass: null,
      legacyCategory: null,
    });
  });
});
