import { describe, expect, it } from 'vitest';

import { labelBillLineOptions } from './bill-line-option-label';

describe('labelBillLineOptions', () => {
  it('gives identical bill lines distinct operator-visible labels', () => {
    const options = labelBillLineOptions([
      { id: 'line-a', name: 'Chicken Tikka Bun', quantity: 1, lineSubtotal: '14.00' },
      { id: 'line-b', name: 'Chicken Tikka Bun', quantity: 1, lineSubtotal: '14.00' },
    ]);

    expect(options.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'line-a', label: 'Line 1 · 1 × Chicken Tikka Bun · 14.00' },
      { id: 'line-b', label: 'Line 2 · 1 × Chicken Tikka Bun · 14.00' },
    ]);
    expect(new Set(options.map(({ label }) => label)).size).toBe(options.length);
  });

  it('labels every option consistently instead of changing unaffected lines conditionally', () => {
    expect(
      labelBillLineOptions([
        { id: 'line-a', name: 'Chicken Tikka Bun', quantity: 1, lineSubtotal: '14.00' },
        { id: 'line-b', name: 'Masala Fries', quantity: 2, lineSubtotal: '10.00' },
      ]).map(({ label }) => label)
    ).toEqual([
      'Line 1 · 1 × Chicken Tikka Bun · 14.00',
      'Line 2 · 2 × Masala Fries · 10.00',
    ]);
  });
});
