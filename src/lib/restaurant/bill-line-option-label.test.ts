import { describe, expect, it } from 'vitest';
import { billLineOptionLabels } from './bill-line-option-label';

const bun = (id: string) => ({ id, name: 'Chicken Tikka Bun', quantity: 1, lineSubtotal: '14.00' });

describe('billLineOptionLabels', () => {
  it('distinguishes identical lines', () => {
    const labels = billLineOptionLabels([bun('a'), bun('b')]);
    expect(labels.get('a')).toBe('1 × Chicken Tikka Bun — 14.00 (line 1 of 2)');
    expect(labels.get('b')).toBe('1 × Chicken Tikka Bun — 14.00 (line 2 of 2)');
  });
  it('leaves unique lines plain and keeps numbering stable when one is comped', () => {
    const all = [bun('a'), bun('b'), { id: 'c', name: 'Chai', quantity: 2, lineSubtotal: '6.00' }];
    const labels = billLineOptionLabels(all, [all[1], all[2]]);
    expect(labels.get('b')).toContain('(line 2 of 2)');
    expect(labels.get('c')).toBe('2 × Chai — 6.00');
  });
});
