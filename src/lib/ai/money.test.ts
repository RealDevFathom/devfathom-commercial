import { describe, expect, it } from 'vitest';
import { addSafeMinor, minorFromUsd, safeMinorFromBigInt } from './money';

describe('AI minor-unit money', () => {
  it('converts database bigints inside the safe integer range', () => {
    expect(safeMinorFromBigInt(BigInt(0), 'spend')).toBe(0);
    expect(safeMinorFromBigInt(BigInt(19_000), 'spend')).toBe(19_000);
    expect(safeMinorFromBigInt(BigInt(Number.MAX_SAFE_INTEGER), 'spend')).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it('rejects bigint conversion and addition outside the safe integer range', () => {
    expect(() => safeMinorFromBigInt(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), 'spend')).toThrow(
      RangeError
    );
    expect(() => safeMinorFromBigInt(BigInt(-1), 'spend')).toThrow(RangeError);
    expect(() => addSafeMinor(Number.MAX_SAFE_INTEGER, 1, 'spend')).toThrow(RangeError);
    expect(() => addSafeMinor(1.5, 1, 'spend')).toThrow(RangeError);
    expect(addSafeMinor(15_000, 4_000, 'spend')).toBe(19_000);
  });

  it('rounds configured USD caps to whole cents and rejects invalid amounts', () => {
    expect(minorFromUsd(190, 'cap')).toBe(19_000);
    expect(minorFromUsd(300.125, 'cap')).toBe(30_013);
    expect(minorFromUsd(0, 'cap')).toBe(0);
    expect(() => minorFromUsd(-1, 'cap')).toThrow(RangeError);
    expect(() => minorFromUsd(Number.NaN, 'cap')).toThrow(RangeError);
    expect(() => minorFromUsd(Number.POSITIVE_INFINITY, 'cap')).toThrow(RangeError);
    expect(() => minorFromUsd(Number.MAX_SAFE_INTEGER, 'cap')).toThrow(RangeError);
  });
});
