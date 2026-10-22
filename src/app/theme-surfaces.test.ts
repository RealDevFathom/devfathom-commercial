/**
 * Regression coverage for the Studio fog surround. These source-level checks
 * keep both application shells theme-aware without requiring a browser build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const globals = readFileSync(join(__dirname, 'globals.css'), 'utf8');
const studioGlobals = globals.slice(globals.indexOf('DEVFATHOM STUDIO'));

function declarations(selector: string): string {
  const match = studioGlobals.match(new RegExp(`${selector}\\s*\\{([^}]+)\\}`));
  expect(match, `missing ${selector} rule`).not.toBeNull();
  return match![1]!;
}

describe('Studio themed surfaces', () => {
  it('defines distinct fog primitives for the light and dark themes', () => {
    const light = studioGlobals.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
    const dark = studioGlobals.match(/\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1];

    expect(light).toContain('--surface-fog: #e8e8e5;');
    expect(dark).toContain('--surface-fog: #111110;');
    expect(light).not.toEqual(dark);
  });

  it('uses the fog token for the document and shared tenant/platform viewport', () => {
    expect(declarations('body')).toContain('background: var(--surface-fog);');
    expect(declarations('\\.studio-viewport')).toContain('background: var(--surface-fog);');

    const fogLiterals = globals.match(/#e8e8e5/gi) ?? [];
    expect(fogLiterals).toHaveLength(1);
  });

  it('themes the global selection colors', () => {
    const selection = declarations('::selection');
    expect(selection).toContain('background: var(--selection-background);');
    expect(selection).toContain('color: var(--selection-foreground);');

    expect(studioGlobals.match(/--selection-background:/g)).toHaveLength(2);
    expect(studioGlobals.match(/--selection-foreground:/g)).toHaveLength(2);
  });
});
