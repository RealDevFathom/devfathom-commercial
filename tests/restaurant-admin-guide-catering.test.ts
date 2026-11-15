// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(resolve('docs/product/restaurant-administrator-guide.md'), 'utf8');

describe('restaurant administrator guide: catering cancellation and stock report', () => {
  it('says cancellation retains consumption and needs explicit dispositions', () => {
    expect(guide).toContain('Cancelling does not reverse stock automatically');
    expect(guide).toContain('UNUSED_RETURN');
    expect(guide).toContain('selected stock location');
    expect(guide).not.toMatch(/Cancelling\s+from READY or DELIVERED reverses/);
    expect(guide).not.toContain("branch's earliest-created");
  });

  it('prints the correct stock-movement worked example arithmetic', () => {
    expect(guide).toContain('+5 kg net movement');
    expect(guide).not.toContain('−5 kg net movement');
    expect(20 + (10 - 5)).toBe(25);
  });
});
