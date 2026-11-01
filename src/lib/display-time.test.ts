import { describe, expect, it } from 'vitest';

import { formatDisplayDateTime } from './display-time';

const plain = (value: string) => value.replace(/\s/g, ' ');

describe('formatDisplayDateTime', () => {
  it('shows a readable time in the workspace zone', () => {
    expect(plain(formatDisplayDateTime('2026-11-01T14:59:01.182Z', 'Asia/Karachi'))).toBe(
      '01-Nov-2026, 7:59 pm'
    );
  });

  it('labels UTC when no workspace zone is known', () => {
    expect(plain(formatDisplayDateTime(new Date('2026-11-01T14:59:01.182Z')))).toBe(
      '01-Nov-2026, 2:59 pm UTC'
    );
  });

  it('never returns a raw ISO string', () => {
    expect(formatDisplayDateTime('2026-11-01T14:59:01.182Z')).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(formatDisplayDateTime(null)).toBe('Not available');
    expect(formatDisplayDateTime('not a date')).toBe('Not available');
  });
});
