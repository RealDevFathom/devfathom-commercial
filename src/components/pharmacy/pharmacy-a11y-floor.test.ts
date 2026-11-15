import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// DEV-506: pharmacy text never drops below 12px and counter controls are >= 44px (h-11).
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const roots = [
  join(process.cwd(), 'src/components/pharmacy'),
  join(process.cwd(), 'src/app/(app)/pharmacy'),
];

describe('pharmacy accessibility floor', () => {
  it('has no text below 12px', () => {
    const tiny = /text-\[(?:\d(?:\.\d+)?|1[01](?:\.\d+)?)px\]|text-\[0\.(?:[0-6]\d*|7[0-4]\d*)rem\]/;
    const offenders = roots
      .flatMap(sources)
      .filter((file) => tiny.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('has no sub-44px fixed-height controls in the counter', () => {
    const offenders = sources(join(process.cwd(), 'src/components/pharmacy/counter')).filter(
      (file) => /className="[^"]*\bh-(?:[6-9]|10)\b/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it('counter offers skip links', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/pharmacy/counter/counter-console.tsx'),
      'utf8'
    );
    expect(src).toContain('Skip to bill total');
    expect(src).toContain('Skip to scan or search');
  });
});
