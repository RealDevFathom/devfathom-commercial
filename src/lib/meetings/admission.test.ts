import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import { hashGuestToken, isJoinableOccurrence } from './admission';

describe('meeting admission primitives', () => {
  const now = new Date('2026-08-27T10:00:00.000Z');

  it('uses a stable one-way guest credential hash', () => {
    expect(hashGuestToken('secret')).toBe(
      '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b'
    );
    expect(hashGuestToken('secret')).not.toContain('secret');
  });

  it.each([
    [
      'before window',
      new Date('2026-08-27T10:01:00Z'),
      new Date('2026-08-27T11:00:00Z'),
      'OPEN',
      null,
    ],
    [
      'after window',
      new Date('2026-08-27T09:00:00Z'),
      new Date('2026-08-27T09:59:00Z'),
      'OPEN',
      null,
    ],
    [
      'cancelled',
      new Date('2026-08-27T09:00:00Z'),
      new Date('2026-08-27T11:00:00Z'),
      'CANCELLED',
      now,
    ],
    ['ended', new Date('2026-08-27T09:00:00Z'), new Date('2026-08-27T11:00:00Z'), 'ENDED', null],
  ])('rejects %s occurrences', (_label, joinOpensAt, joinClosesAt, status, cancelledAt) => {
    expect(isJoinableOccurrence({ now, joinOpensAt, joinClosesAt, status, cancelledAt })).toBe(
      false
    );
  });

  it('accepts an occurrence only inside its explicit join bounds', () => {
    expect(
      isJoinableOccurrence({
        now,
        joinOpensAt: new Date('2026-08-27T09:55:00Z'),
        joinClosesAt: new Date('2026-08-27T11:00:00Z'),
        status: 'OPEN',
        cancelledAt: null,
      })
    ).toBe(true);
  });
});
