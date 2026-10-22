import { describe, expect, it } from 'vitest';
import { addSafeMinor, parseMajorUnitsToMinor, safeMinorFromBigInt } from './money';

describe('AI minor-unit money', () => {
  it('parses environment major units exactly', () => {
    expect(parseMajorUnitsToMinor('200.05')).toBe(20_005);
    expect(parseMajorUnitsToMinor('0.1')).toBe(10);
    expect(parseMajorUnitsToMinor('1.001')).toBeNull();
    expect(parseMajorUnitsToMinor('Infinity')).toBeNull();
  });

  it('rejects bigint conversion and addition outside the safe integer range', () => {
    expect(() => safeMinorFromBigInt(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'spend')).toThrow(
      RangeError
    );
    expect(() => addSafeMinor(Number.MAX_SAFE_INTEGER, 1, 'spend')).toThrow(RangeError);
  });
});
