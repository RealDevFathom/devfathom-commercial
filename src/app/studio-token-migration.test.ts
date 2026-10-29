import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const globals = readFileSync(join(__dirname, 'globals.css'), 'utf8');

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('Studio token migration', () => {
  it('has one authoritative light and dark token block', () => {
    expect(globals.match(/^:root \{/gm)).toHaveLength(1);
    expect(globals.match(/^\[data-theme='dark'\] \{/gm)).toHaveLength(1);
    expect(globals).toMatch(/--radius-xs: 8px/);
    expect(globals).toMatch(/--radius-sm: 12px/);
    expect(globals).toMatch(/--radius-md: 16px/);
    expect(globals).toMatch(/--radius-lg: 20px/);
    expect(globals).toMatch(/--radius-xl: 24px/);
  });

  it('keeps product components on semantic palette, radius, and shadow utilities', () => {
    const productSource = tsxFiles(join(__dirname, '..'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    expect(productSource).not.toMatch(/(?:abyss-|brass-|paper-white)/);
    expect(productSource).not.toContain('rounded-[3px]');
    expect(productSource).not.toMatch(/shadow-\[[^\]]*rgba\(/);
  });
});
