import { describe, expect, it } from 'vitest';

import { assertCiMemory } from '../scripts/check-ci-memory.mjs';

const GiB = 1024 ** 3;

describe('QA runner memory preflight', () => {
  it('rejects the reviewed 6 GiB Docker VM even on a larger host', () => {
    expect(() => assertCiMemory(32 * GiB, 6 * GiB, ['max'])).toThrow(
      'effective runner/Docker memory is 6144 MiB'
    );
  });

  it('respects the runner container cap on cgroup v2', () => {
    expect(() => assertCiMemory(32 * GiB, 16 * GiB, [String(6 * GiB)])).toThrow(
      'effective runner/Docker memory is 6144 MiB'
    );
  });

  it('respects the runner container cap on cgroup v1', () => {
    expect(() => assertCiMemory(32 * GiB, 16 * GiB, ['max', String(8 * GiB)])).toThrow(
      'effective runner/Docker memory is 8192 MiB'
    );
  });

  it('accepts sufficient memory with an unlimited cgroup', () => {
    expect(() => assertCiMemory(16 * GiB, 16 * GiB, ['max', '9223372036854771712'])).not.toThrow();
  });

  it('requires headroom above the V8 heap allowance', () => {
    expect(() => assertCiMemory(8 * GiB, 16 * GiB, [])).toThrow('at least 12288 MiB');
  });
});
