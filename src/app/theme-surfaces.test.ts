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

describe('Dark-mode control contrast (DEV-601)', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it('keeps dark input borders at 3:1 against card and raised surfaces', () => {
    const dark = studioGlobals.match(/\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const input = dark.match(/--input:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(input).toBeDefined();
    expect(ratio(input!, '#242422')).toBeGreaterThanOrEqual(3);
    expect(ratio(input!, '#2c2c29')).toBeGreaterThanOrEqual(3);
  });

  it('gives disabled buttons and inputs a legible dark style', () => {
    const button = readFileSync(join(__dirname, '../components/ui/button.tsx'), 'utf8');
    const input = readFileSync(join(__dirname, '../components/ui/input.tsx'), 'utf8');
    expect(button).toContain('dark:disabled:opacity-100');
    expect(button).toContain('dark:disabled:text-text-muted');
    expect(input).toContain('dark:disabled:text-text-muted');
    expect(input).toContain('dark:disabled:opacity-100');
  });
});
