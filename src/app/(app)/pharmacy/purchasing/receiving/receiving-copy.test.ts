import { describe, expect, it } from 'vitest';

import { units } from '../_lib/console';

describe('Goods-in unit copy', () => {
  it('uses the singular label for one canonical unit', () => {
    expect(`1 pack = ${units(1)}`).toBe('1 pack = 1 unit');
  });
});
