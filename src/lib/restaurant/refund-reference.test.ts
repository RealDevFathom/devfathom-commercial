import { describe, expect, it } from 'vitest';

import { refundReferenceProblem } from './refund-reference';

describe('refundReferenceProblem', () => {
  it('accepts blank and ordinary machine references', () => {
    for (const ok of ['', 'RRN-42/AB', 'abc123', 'A'.repeat(40), '1234-5678', '123456789012']) {
      expect(refundReferenceProblem(ok)).toBeNull();
    }
  });
  it('rejects more than 40 characters and characters outside letters, digits, dash and slash', () => {
    expect(refundReferenceProblem('A'.repeat(41))).toMatch(/at most 40/);
    for (const bad of ['REF 42', 'REF_42', 'REF#42', 'REF.42']) {
      expect(refundReferenceProblem(bad)).toMatch(/letters, digits/);
    }
  });
  it('rejects 13-19 digit runs, with or without dashes, including Luhn-valid numbers', () => {
    for (const bad of [
      '4111111111111111',
      '4111-1111-1111-1111',
      '4111/1111/1111/1111',
      '4111-1111/1111-1111',
      '4111111111111112',
      '1234567890123',
      '1234567890123456789',
      'REF4111111111111111',
      '4111111111111111/X',
      '12345678901234567890',
    ]) {
      expect(refundReferenceProblem(bad), bad).toMatch(/card number/);
    }
  });
  it('normalises other separators and Unicode digits before the card-number check', () => {
    const arabicIndic = [...'4111111111111111']
      .map((d) => String.fromCodePoint(0x0660 + Number(d)))
      .join('');
    const fullwidth = [...'4111111111111111']
      .map((d) => String.fromCodePoint(0xff10 + Number(d)))
      .join('');
    for (const bad of [
      '4111.1111.1111.1111',
      '4111_1111_1111_1111',
      '4111 1111 1111 1111',
      arabicIndic,
      fullwidth,
      `REF-${arabicIndic}`,
    ]) {
      expect(refundReferenceProblem(bad), bad).toMatch(/card number/);
    }
  });
});
