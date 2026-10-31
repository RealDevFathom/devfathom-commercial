import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = join(process.cwd(), 'src');
const globalsPath = join(srcRoot, 'app', 'globals.css');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : extname(path) === '.tsx' ? [path] : [];
  });
}

describe('Studio token migration', () => {
  const globals = readFileSync(globalsPath, 'utf8');
  const productSource = sourceFiles(srcRoot)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  it('has one authoritative token block per theme with the documented control radius', () => {
    expect(globals.match(/^:root \{/gm)).toHaveLength(1);
    expect(globals.match(/^\[data-theme='dark'\] \{/gm)).toHaveLength(1);
    expect(globals).toMatch(/--radius-sm:\s*12px/);
  });

  it('does not expose or consume retired palette utilities', () => {
    expect(globals).not.toMatch(/--color-(?:abyss|brass|paper-white|paper-\d+)/);
    expect(globals).not.toMatch(/\.\S*(?:abyss-|brass-|paper-white)/);
    expect(productSource).not.toMatch(/(?:abyss-|brass-|paper-white)/);
  });

  it('routes controls and elevation through Studio tokens', () => {
    expect(productSource).not.toContain('rounded-[3px]');
    expect(productSource).not.toMatch(/shadow-\[[^\]]*rgba/);
  });
});
