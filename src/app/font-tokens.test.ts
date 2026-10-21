/**
 * The Studio font tokens are wired in two files that cannot see each other:
 * `layout.tsx` pins the next/font/local faces to their family names and
 * `globals.css` names those families in `--font-sans` / `--font-mono`.
 *
 * Regression for the production build that rendered every page in the browser
 * default serif face. The theme mapped `--font-sans: var(--font-sans)` while
 * next/font declared the same `--font-sans` on <html> with Turbopack's generated
 * family (`"instrumentSans"`), which matches no @font-face. Reads the sources
 * rather than the bundle so the check runs without a build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const globals = readFileSync(join(__dirname, 'globals.css'), 'utf8');
const layout = readFileSync(join(__dirname, 'layout.tsx'), 'utf8');

/** Every `--font-*: value;` declaration in the stylesheet, in source order, comments removed. */
function fontDeclarations(css: string): Array<{ name: string; value: string }> {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...code.matchAll(/(--font-[\w-]+)\s*:\s*([^;]+);/g)].map((match) => ({
    name: match[1]!,
    value: match[2]!.replace(/\s+/g, ' ').trim(),
  }));
}

/** The family names layout.tsx pins through `declarations: [{ prop: 'font-family' }]`. */
function pinnedFamilies(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/prop:\s*'font-family',\s*value:\s*'([^']+)'/g)].map((match) => match[1]!)
  );
}

const SEMANTIC_FONT_TOKENS = ['--font-sans', '--font-mono', '--font-display', '--font-heading'];

describe('Studio font tokens', () => {
  it('never defines a --font-* custom property in terms of itself', () => {
    const cyclic = fontDeclarations(globals).filter(({ name, value }) =>
      new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(value)
    );
    expect(cyclic).toEqual([]);
  });

  it('names the next/font families in the sans and mono stacks', () => {
    const pinned = pinnedFamilies(layout);
    expect(pinned).toEqual(new Set(['Instrument Sans', 'IBM Plex Mono']));
    const declared = fontDeclarations(globals);
    const sans = declared.filter((d) => d.name === '--font-sans');
    const mono = declared.filter((d) => d.name === '--font-mono');
    expect(sans.length).toBeGreaterThan(0);
    expect(mono.length).toBeGreaterThan(0);
    // Every definition, so a later :root override cannot swap the family out again.
    for (const { value } of sans)
      expect(value).toMatch(/^'Instrument Sans', 'Instrument Sans Fallback'/);
    for (const { value } of mono)
      expect(value).toMatch(/^'IBM Plex Mono', 'IBM Plex Mono Fallback'/);
  });

  it('keeps the semantic token names out of next/font variables', () => {
    const variables = [...layout.matchAll(/variable:\s*'(--[\w-]+)'/g)].map((match) => match[1]!);
    expect(variables.length).toBe(7);
    for (const variable of variables) expect(SEMANTIC_FONT_TOKENS).not.toContain(variable);
  });

  it('ships the metric-matched fallback faces the stacks name', () => {
    expect(globals).toMatch(/@font-face\s*{\s*font-family:\s*Instrument Sans Fallback;/);
    expect(globals).toMatch(/@font-face\s*{\s*font-family:\s*IBM Plex Mono Fallback;/);
  });
});
