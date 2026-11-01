import { describe, expect, it } from 'vitest';
import { licenceDateValid } from './licence-validity';

describe('inclusive licence expiry in the organization timezone', () => {
  it.each([
    ['2026-10-20T23:59:59Z', true], // 04:59:59 PKT
    ['2026-10-21T00:00:00Z', true], // 05:00 PKT
    ['2026-10-21T18:59:59.999Z', true],
    ['2026-10-21T19:00:00Z', false],
  ])('expiry today at %s is valid: %s', (instant, expected) => {
    const at = new Date(instant);
    expect(licenceDateValid('2026-10-21', at)).toBe(expected);
    expect(licenceDateValid(new Date('2026-10-21T00:00:00Z'), at)).toBe(expected);
  });

  it('honours an organization timezone override', () => {
    const at = new Date('2026-10-21T19:00:00Z');
    expect(licenceDateValid('2026-10-21', at, 'UTC')).toBe(true);
    expect(licenceDateValid('2026-10-21', at, 'Asia/Karachi')).toBe(false);
  });
});
