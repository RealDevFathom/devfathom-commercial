/**
 * DEV-351: the Studio token layer is the only token source. The legacy
 * Fieldbook :root/dark blocks, the abyss/brass/paper palette utilities and
 * their platform compatibility bridge are retired, and controls take their
 * corners and lift from the Studio radius/shadow scale.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = join(__dirname, '..');
const globals = readFileSync(join(__dirname, 'globals.css'), 'utf8');
const contract = readFileSync(
  join(srcRoot, '..', 'docs', 'design-system', 'DEVFATHOM-STUDIO.md'),
  'utf8'
);

function productSources(): { path: string; source: string }[] {
  return readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => ({
      path: relative(srcRoot, join(srcRoot, file)),
      source: readFileSync(join(srcRoot, file), 'utf8'),
    }));
}

function block(selector: ':root' | "[data-theme='dark']") {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...globals.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{([\\s\\S]*?)\\n\\}`, 'g'))];
}

describe('Studio token source (DEV-351)', () => {
  it('defines exactly one :root and one dark-theme token block', () => {
    expect(block(':root')).toHaveLength(1);
    expect(block("[data-theme='dark']")).toHaveLength(1);
  });

  it('ships the radius scale the design contract assigns', () => {
    const root = block(':root')[0]![1]!;
    for (const [token, value] of [
      ['--radius-xs', '8px'],
      ['--radius-sm', '12px'],
      ['--radius-md', '16px'],
      ['--radius-lg', '20px'],
      ['--radius-xl', '24px'],
    ]) {
      expect(root).toContain(`${token}: ${value};`);
      expect(contract).toContain(`\`${token}: ${value}\``);
    }
  });

  it('retires the legacy abyss/brass/paper palette and its compatibility bridge', () => {
    expect(globals).not.toMatch(/abyss|brass|--paper-/);
    expect(globals).not.toMatch(/\.platform-workspace \.(?:bg|text|border)-/);
  });

  it('keeps legacy palette utilities out of product code', () => {
    const offenders = productSources()
      .filter(({ source }) =>
        /\b(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration)-(?:abyss|brass|paper|seafoam)\b/.test(
          source
        )
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('takes control corners and lift from the radius and shadow tokens', () => {
    const offenders = productSources()
      .filter(({ source }) => /rounded-\[3px\]|shadow-\[[^\]]*rgba\(/.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);

    const button = readFileSync(join(srcRoot, 'components', 'ui', 'button.tsx'), 'utf8');
    expect(button).toMatch(/inline-flex shrink-0 items-center justify-center rounded-sm /);
  });
});
