import { describe, expect, it } from 'vitest';

import { emailLookupSchema, emailSchema, normalizeEmail } from './email-address';

describe('normalizeEmail', () => {
  it.each([
    ['Alex@Company.com', 'alex@company.com'],
    ['ALEX@COMPANY.COM', 'alex@company.com'],
    ['  alex@company.com  ', 'alex@company.com'],
    ['\talex@company.com\n', 'alex@company.com'],
    // Unicode: case-folded by the same rule, never transliterated or stripped.
    ['Renée@Café.example', 'renée@café.example'],
    ['ÅSA@example.com', 'åsa@example.com'],
    ['ÇAĞLA@example.com', 'çağla@example.com'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it('leaves an already-canonical address untouched', () => {
    expect(normalizeEmail('alex@company.com')).toBe('alex@company.com');
  });
});

describe('emailSchema', () => {
  it.each([
    ['Alex@Company.com', 'alex@company.com'],
    ['  ALEX@COMPANY.COM ', 'alex@company.com'],
  ])('parses %j to %j', (input, expected) => {
    expect(emailSchema.parse(input)).toBe(expected);
  });

  it.each([['not-an-email'], ['@company.com'], ['alex@'], ['']])('rejects %j', (input) => {
    expect(emailSchema.safeParse(input).success).toBe(false);
  });

  it('rejects an address longer than the RFC maximum', () => {
    const long = `${'a'.repeat(250)}@company.com`;
    expect(emailSchema.safeParse(long).success).toBe(false);
  });
});

describe('emailLookupSchema', () => {
  // Used by forgot-password: a malformed address must be indistinguishable from
  // an unknown one, so this normalizes without validating the format.
  it('normalizes without judging the format', () => {
    expect(emailLookupSchema.parse('  NoT-An-Email  ')).toBe('not-an-email');
  });

  it('still rejects an empty value', () => {
    expect(emailLookupSchema.safeParse('   ').success).toBe(false);
  });
});
