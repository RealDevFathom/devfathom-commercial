import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { hashArchiveBytes } from './cutover';
import { computeComparison } from './parallel-run';

function comparison(devfathom: number, legacy: number, threshold: number) {
  return computeComparison({
    metric: 'SALES',
    devfathomMinor: BigInt(devfathom),
    legacyMinor: BigInt(legacy),
    thresholdMinor: BigInt(threshold),
  });
}

describe('MIG-04 daily comparison', () => {
  it('signs the diff from this system towards the incumbent', () => {
    expect(comparison(120_000, 100_000, 0).diffMinor).toBe(BigInt(20_000));
    expect(comparison(100_000, 120_000, 0).diffMinor).toBe(BigInt(-20_000));
  });

  it('agreeing totals produce a zero diff that is never material', () => {
    const result = comparison(100_000, 100_000, 0);
    expect(result.diffMinor).toBe(BigInt(0));
    expect(result.material).toBe(false);
  });

  /**
   * D05 default is zero, so with no contract threshold ANY disagreement is
   * material — the direction that delays finality rather than granting it.
   */
  it('makes any non-zero diff material at the default zero threshold', () => {
    expect(comparison(100_001, 100_000, 0).material).toBe(true);
  });

  it('judges materiality on magnitude, so a shortfall counts like an excess', () => {
    expect(comparison(99_000, 100_000, 500).material).toBe(true);
    expect(comparison(101_000, 100_000, 500).material).toBe(true);
  });

  it('treats a diff exactly at the threshold as immaterial', () => {
    expect(comparison(100_500, 100_000, 500).material).toBe(false);
    expect(comparison(100_501, 100_000, 500).material).toBe(true);
  });

  it('stays exact past the range of a 32-bit minor amount', () => {
    const result = computeComparison({
      metric: 'STOCK_VALUE',
      devfathomMinor: BigInt('9007199254740993000'),
      legacyMinor: BigInt('9007199254740992000'),
      thresholdMinor: BigInt(0),
    });
    expect(result.diffMinor).toBe(BigInt(1000));
    expect(result.material).toBe(true);
  });
});

describe('MIG-04 legacy archive reference', () => {
  it('identifies an archive by the SHA-256 of its bytes', () => {
    expect(hashArchiveBytes('legacy-backup')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashArchiveBytes('legacy-backup')).toBe(hashArchiveBytes('legacy-backup'));
    expect(hashArchiveBytes('legacy-backup')).not.toBe(hashArchiveBytes('legacy-backup!'));
  });
});
