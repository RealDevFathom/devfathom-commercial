import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DEV-722: shop owners must never see developer vocabulary on pharmacy screens. This scans the
 * pharmacy page and component sources (not tests) for banned terms. Comments are ignored; they are
 * not shown to anyone. The allowlist is for Details-only strings and must not grow.
 */
const ROOTS = ['src/app/(app)/pharmacy', 'src/components/pharmacy'];
const BANNED: { name: string; pattern: RegExp }[] = [
  { name: 'minor units', pattern: /minor[- ]units?/i },
  { name: 'RFC3339', pattern: /RFC\s?3339/i },
  { name: 'UTC offset string', pattern: /\b(?:UTC|GMT)\s?[+-]\d{1,2}(?::?\d{2})?\b/ },
  // Raw enum names (ALL_CAPS_WITH_UNDERSCORES) written as visible JSX text.
  { name: 'raw enum name', pattern: />\s*[A-Z]{2,}(?:_[A-Z0-9]+)+\s*</ },
];
/** "relative/path :: banned term" entries for strings only shown inside a Details disclosure. */
const ALLOWLIST: string[] = [];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('plain-language sweep', () => {
  it('keeps developer terms off pharmacy screens', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of sources(root)) {
        const text = stripComments(readFileSync(file, 'utf8'));
        for (const { name, pattern } of BANNED) {
          if (pattern.test(text)) {
            const key = `${relative('.', file)} :: ${name}`;
            if (!ALLOWLIST.includes(key)) hits.push(key);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('does not let the allowlist grow', () => {
    expect(ALLOWLIST.length).toBeLessThanOrEqual(0);
  });
});
