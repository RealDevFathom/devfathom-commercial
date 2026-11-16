import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LEDGER_FILE, readBaseLedger } from '../scripts/qa/migration-rules';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
});

describe('origin/develop migration ledger', () => {
  it('reads the base ledger from origin/develop', () => {
    vi.mocked(execFileSync).mockReturnValue('# ledger\n20261120000000_a\n');
    expect(readBaseLedger()).toEqual(['20261120000000_a']);
    expect(execFileSync).toHaveBeenCalledWith('git', ['show', `origin/develop:${LEDGER_FILE}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  it('retains the empty base when the ledger cannot be read', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('missing ref');
    });
    expect(readBaseLedger()).toEqual([]);
  });

  it('preserves a readable empty base', () => {
    vi.mocked(execFileSync).mockReturnValue('');
    expect(readBaseLedger()).toEqual([]);
  });
});
