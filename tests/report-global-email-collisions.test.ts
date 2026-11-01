import { describe, expect, it } from 'vitest';

import { maskAddress, maskId, parseArgs } from '../scripts/report-global-email-collisions';

describe('report-global-email-collisions masking', () => {
  it('masks the local part and keeps the domain', () => {
    expect(maskAddress('alice@example.com')).toBe('a****@example.com');
    expect(maskAddress('a@example.com')).toBe('a*@example.com');
    expect(maskAddress('not-an-address')).toBe('***');
  });

  it('truncates ids', () => {
    expect(maskId('0123456789abcdef')).toBe('01234567…');
  });

  it('masks by default and only reveals on explicit opt-in', () => {
    expect(parseArgs([]).reveal).toBe(false);
    expect(parseArgs(['--json', '--summary']).reveal).toBe(false);
    expect(parseArgs(['--unmasked']).reveal).toBe(true);
    expect(parseArgs(['--reveal']).reveal).toBe(true);
  });
});
