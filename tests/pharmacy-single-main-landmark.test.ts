import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The app shell owns the single <main id="main-content"> landmark. Pharmacy
// pages render inside it, so they must not add a nested <main>.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [p] : [];
  });
}

describe('pharmacy pages keep one main landmark', () => {
  const roots = ['src/app/(app)/pharmacy', 'src/components/pharmacy'];
  for (const root of roots) {
    it(`${root} renders no nested <main>`, () => {
      const offenders = walk(root).filter((f) => /<main[\s>]/.test(readFileSync(f, 'utf8')));
      expect(offenders).toEqual([]);
    });
  }
});
