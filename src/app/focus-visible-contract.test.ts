import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const globals = readFileSync(join(__dirname, 'globals.css'), 'utf8');

describe('global keyboard focus indicator', () => {
  it('provides an unscoped focus-visible outline after layered component styles', () => {
    const rule = globals.match(
      /(?:^|\n):focus-visible\s*\{\s*outline:\s*(\d+)px solid var\(--ring\);\s*outline-offset:\s*(\d+)px;\s*\}/
    );

    expect(rule, 'a global :focus-visible rule must cover bespoke controls').not.toBeNull();
    expect(Number(rule?.[1])).toBeGreaterThanOrEqual(2);
    expect(Number(rule?.[2])).toBeGreaterThanOrEqual(2);
    expect(globals.indexOf(rule?.[0] ?? '')).toBeGreaterThan(globals.lastIndexOf('@layer'));
  });

  it('retains a system focus color in Windows forced-colors mode', () => {
    expect(globals).toMatch(
      /@media \(forced-colors: active\)\s*\{\s*:focus-visible\s*\{\s*outline-color:\s*Highlight;/
    );
  });
});
