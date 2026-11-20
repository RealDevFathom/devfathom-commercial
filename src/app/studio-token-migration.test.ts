/**
 * DEV-351: the Studio token layer is the only token source. The legacy
 * Fieldbook :root/dark blocks, the abyss/brass/paper palette utilities and
 * their platform compatibility bridge are retired, and controls take their
 * 3px corner and their lift from the Studio radius/shadow scale instead of
 * hardcoded values.
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
    .filter(
      (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.startsWith('generated')
    )
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

  it('ships the radius scale the design contract records, with the 3px control corner', () => {
    const root = block(':root')[0]![1]!;
    for (const [token, value] of [
      ['--radius-control', '3px'],
      ['--radius-xs', '8px'],
      ['--radius-sm', '12px'],
      ['--radius-md', '16px'],
      ['--radius-lg', '20px'],
      ['--radius-xl', '24px'],
    ]) {
      expect(root).toContain(`${token}: ${value};`);
      expect(contract).toContain(`\`${token}: ${value}\``);
    }
    // The contract names the 3px token as the Control role, not a 12px step.
    expect(contract).toMatch(/\| Control\s+\| `--radius-control: 3px`/);
    expect(contract).not.toMatch(/\| Control\s+\| `--radius-sm/);
  });

  it('documents the 12px controls that still ship instead of claiming every control is 3px', () => {
    const twelvePxControlFiles = productSources().filter(({ source }) =>
      source.includes('rounded-[var(--radius-sm)]')
    );
    if (twelvePxControlFiles.length > 0) {
      expect(contract).toContain('`rounded-[var(--radius-sm)]`');
      expect(contract).toContain('`.studio-auth`');
    }
    expect(contract).not.toMatch(/never round a button\s+with a surface step/);
  });

  it('exposes the control radius and shadows as Tailwind theme tokens', () => {
    expect(globals).toContain('--radius-control: var(--radius-control);');
    expect(globals).toContain('--shadow-control: var(--shadow-control);');
    expect(globals).toContain('--shadow-control-ink: var(--shadow-control-ink);');
    const root = block(':root')[0]![1]!;
    expect(root).toMatch(/--shadow-control: [^;]+;/);
    expect(root).toMatch(/--shadow-control-ink: [^;]+;/);
  });

  it('retires the legacy abyss/brass/paper palette and its compatibility bridge', () => {
    expect(globals).not.toMatch(/abyss|brass|--paper-/);
    expect(globals).not.toMatch(/\.platform-workspace \.(?:hover\\:)?(?:bg|text|border)-/);
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
    expect(button).toMatch(/inline-flex shrink-0 items-center justify-center rounded-control /);
    expect(button).toMatch(/'bg-primary text-primary-foreground shadow-control /);
  });
});
