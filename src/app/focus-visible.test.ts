import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const globals = readFileSync(join(__dirname, 'globals.css'), 'utf8');

describe('global keyboard focus indicator', () => {
  it('provides an unclippable unlayered semantic outline for every focus-visible element', () => {
    const focusRule = globals.match(
      /^:focus-visible\s*\{\s*outline:\s*2px solid var\(--ring\) !important;\s*outline-offset:\s*-2px !important;\s*\}/m
    );

    expect(focusRule).not.toBeNull();
    expect(focusRule!.index).toBeGreaterThan(globals.lastIndexOf('@layer'));
    expect(globals.match(/^:focus-visible\s*\{/gm)).toHaveLength(1);
    expect(globals.slice(focusRule!.index! + focusRule![0].length)).not.toMatch(
      /outline(?:-style)?:\s*(?:0|none)/
    );
  });
});
