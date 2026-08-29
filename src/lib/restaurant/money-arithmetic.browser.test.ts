import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('client-safe promotion money arithmetic', () => {
  it('bundles the canonical promotion evaluator for a browser target', () => {
    const result = spawnSync(
      'bun',
      ['build', resolve('src/lib/restaurant/promotion-evaluator.ts'), '--target=browser'],
      { encoding: 'utf8' }
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('server-only');
  });
});
