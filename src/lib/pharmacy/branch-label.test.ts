import { describe, expect, it } from 'vitest';

import { pharmacyBranchLabel } from './branch-label';

describe('pharmacyBranchLabel', () => {
  it('names a branch by its name and city, never its code', () => {
    expect(pharmacyBranchLabel({ name: 'SehatCart Test Branch', city: 'Lahore' })).toBe(
      'SehatCart Test Branch · Lahore'
    );
    const branch = { name: 'SehatCart Test Branch', city: 'Lahore', code: 'MAIN' };
    expect(pharmacyBranchLabel(branch)).not.toContain('MAIN');
  });

  it('falls back to the name alone when no city is recorded', () => {
    expect(pharmacyBranchLabel({ name: 'Main', city: ' ' })).toBe('Main');
    expect(pharmacyBranchLabel({ name: 'Main' })).toBe('Main');
  });
});
