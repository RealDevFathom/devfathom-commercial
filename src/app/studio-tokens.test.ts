import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(__dirname, '..');
const globals = readFileSync(join(__dirname, 'globals.css'), 'utf8');

function tsxSources(directory: string): Array<{ path: string; source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxSources(path);
    if (path === __filename) return [];
    return extname(entry.name) === '.tsx' ? [{ path, source: readFileSync(path, 'utf8') }] : [];
  });
}

describe('Studio token migration', () => {
  it('has one authoritative light and dark token block', () => {
    expect(globals.match(/^:root\s*{/gm)).toHaveLength(1);
    expect(globals.match(/^\[data-theme='dark'\]\s*{/gm)).toHaveLength(1);
    expect(globals).not.toMatch(/--color-(?:abyss|brass)-|--color-paper-white/);
    expect(globals).not.toContain('.platform-workspace .bg-abyss-900');
  });

  it('keeps the documented Studio radius scale', () => {
    expect(globals).toMatch(/--radius-xs:\s*8px;/);
    expect(globals).toMatch(/--radius-sm:\s*12px;/);
    expect(globals).toMatch(/--radius-md:\s*16px;/);
    expect(globals).toMatch(/--radius-lg:\s*20px;/);
    expect(globals).toMatch(/--radius-xl:\s*24px;/);
  });

  it('keeps product components on semantic palette, radius, and shadow tokens', () => {
    for (const { path, source } of tsxSources(sourceRoot)) {
      expect(source, path).not.toMatch(/(?:abyss-|brass-|paper-white)/);
      expect(source, path).not.toContain(['rounded', '[3px]'].join('-'));
      expect(source, path).not.toMatch(/shadow-\[[^\]]*rgba/);
    }
  });
});
