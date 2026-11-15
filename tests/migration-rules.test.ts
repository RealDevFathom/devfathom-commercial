import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isUnchanged,
  LEDGER_FILE,
  LEGACY_FILE,
  readBaseLedger,
  readBaseList,
} from '../scripts/qa/migration-rules';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('frozen migration list', () => {
  const base = ['20261120000000_a', '20261121000000_b'];

  it('accepts only the unchanged names in their original order', () => {
    expect(isUnchanged(base, [...base])).toBe(true);
    expect(isUnchanged(base, [...base, '20261122000000_c'])).toBe(false);
    expect(isUnchanged(base, base.slice(1))).toBe(false);
    expect(isUnchanged(base, [...base].reverse())).toBe(false);
    expect(isUnchanged(base, [base[0], '20261121000000_renamed'])).toBe(false);
  });

  it('rejects a back-dated migration hidden in the legacy exemptions', () => {
    const backdated = '20261119000000_bypass';
    const tamperedLegacy = [...base, backdated];
    // This would exclude the new migration from timestamp, wrapping and rerun checks.
    expect(new Set(tamperedLegacy).has(backdated)).toBe(true);
    expect(backdated.slice(0, 14) < base[0].slice(0, 14)).toBe(true);
    expect(isUnchanged(base, tamperedLegacy)).toBe(false);
  });
});

describe.each([LEGACY_FILE, LEDGER_FILE])('origin/develop list: %s', (file) => {
  const read = () => (file === LEDGER_FILE ? readBaseLedger() : readBaseList(file));

  it('reads the base list from the requested path', () => {
    vi.mocked(execFileSync).mockReturnValue('# frozen\n20261120000000_a\n');
    expect(read()).toEqual(['20261120000000_a']);
    expect(execFileSync).toHaveBeenCalledWith('git', ['show', `origin/develop:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  it('fails closed when the base cannot be read in CI', () => {
    vi.stubEnv('CI', 'true');
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('missing ref');
    });
    expect(read).toThrow(`Cannot read origin/develop:${file}`);
  });

  it('signals a local skip when the base cannot be read', () => {
    vi.stubEnv('CI', undefined);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('missing ref');
    });
    expect(read()).toBeNull();
  });

  it('preserves an empty base as readable', () => {
    vi.mocked(execFileSync).mockReturnValue('');
    expect(read()).toEqual([]);
  });
});
