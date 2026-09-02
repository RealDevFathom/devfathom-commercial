import { describe, expect, it } from 'vitest';

import { evaluateSetupChecklist, type SetupEvidence } from './setup-evaluator';

const incomplete: SetupEvidence = {
  hasBranch: false,
  hasProvisionedRoles: false,
  hasStationOrPrinter: false,
  hasCatalog: false,
  hasOpeningStock: false,
  hasTax: false,
  hasFirstSale: false,
};

describe('first-run setup evaluator', () => {
  it('keeps restaurant setup open until every required fact exists', () => {
    const checklist = evaluateSetupChecklist('RESTAURANT', incomplete);
    expect(checklist.complete).toBe(false);
    expect(checklist.items.map(({ key, status }) => [key, status])).toEqual([
      ['branch', 'Needs you'],
      ['staff', 'Needs you'],
      ['stations', 'Optional'],
      ['catalog', 'Needs you'],
      ['tax', 'Needs you'],
      ['first-sale', 'Needs you'],
    ]);
  });

  it('requires both pharmacy catalog publication and received opening stock', () => {
    const checklist = evaluateSetupChecklist('PHARMACY', {
      ...incomplete,
      hasBranch: true,
      hasProvisionedRoles: true,
      hasCatalog: true,
      hasFirstSale: true,
    });
    expect(checklist.items.find((item) => item.key === 'catalog')?.status).toBe('Needs you');
    expect(checklist.items.find((item) => item.key === 'tax')?.status).toBe('Optional');
    expect(checklist.complete).toBe(false);
  });

  it('completes from evidence without manual checkbox state', () => {
    const checklist = evaluateSetupChecklist('RESTAURANT', {
      ...incomplete,
      hasBranch: true,
      hasProvisionedRoles: true,
      hasCatalog: true,
      hasTax: true,
      hasFirstSale: true,
    });
    expect(checklist.complete).toBe(true);
    expect(
      checklist.items.filter((item) => !item.optional).every((item) => item.status === 'Done')
    ).toBe(true);
  });
});
