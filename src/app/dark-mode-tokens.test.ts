/**
 * DEV-51 — dark mode showed light, hard-coded colours on several screens and
 * primary buttons with no hover change. These source-level checks keep shared
 * chrome and primary actions on Studio semantic tokens so both themes (and
 * tenant brand overrides) restyle them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'generated' || name === 'node_modules' ? [] : sourceFiles(path);
    }
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(srcRoot).map((path) => ({
  path: path.slice(srcRoot.length + 1),
  lines: readFileSync(path, 'utf8').split('\n'),
}));

function offenders(test: (line: string) => boolean): string[] {
  return files.flatMap(({ path, lines }) =>
    lines.flatMap((line, index) => (test(line) ? [`${path}:${index + 1}`] : []))
  );
}

const read = (relative: string) => readFileSync(join(srcRoot, relative), 'utf8');

describe('dark-mode tokens (DEV-51)', () => {
  it('never hard-codes a primary hover colour', () => {
    expect(offenders((line) => /hover:bg-\[#0C2E2C\]/i.test(line))).toEqual([]);
  });

  it('pairs a primary fill with the primary foreground token, not white', () => {
    expect(
      offenders(
        (line) =>
          /(?<![\w:/-])bg-primary(?=[\s'"`])/.test(line) &&
          /(?<![\w:/-])text-white(?=[\s'"`])/.test(line)
      )
    ).toEqual([]);
  });

  it('themes the workspace shell warning banners', () => {
    const shell = read('components/layout/app-shell.tsx');
    expect(shell).not.toMatch(/\b(bg|border|text)-amber-\d+/);
    expect(shell.match(/bg-warning\/10/g)).toHaveLength(2);
  });

  it('themes the platform destructive lifecycle card', () => {
    const page = read('app/platform/(console)/organizations/[id]/page.tsx');
    expect(page).not.toContain('bg-red-100');
    expect(page).toContain('border border-destructive bg-destructive/10 p-5');
  });

  it('themes both error boundaries', () => {
    for (const boundary of ['app/error.tsx', 'app/(app)/error.tsx']) {
      const source = read(boundary);
      expect(source, boundary).not.toMatch(/\[#[0-9a-f]{3,8}\]/i);
      expect(source, boundary).not.toMatch(/\b(bg|text)-red-\d+/);
      expect(source, boundary).toContain('hover:bg-primary-hover');
    }
  });
});
