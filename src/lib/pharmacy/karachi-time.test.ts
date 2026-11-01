import { describe, expect, it } from 'vitest';

import { formatKarachiDateTime } from './karachi-time';

describe('formatKarachiDateTime', () => {
  it('prints Asia/Karachi wall time, including the midnight that UTC still calls the previous day', () => {
    expect(formatKarachiDateTime(new Date('2026-01-15T19:30:00.000Z'))).toBe(
      '2026-01-16 00:30 PKT'
    );
    expect(formatKarachiDateTime(new Date('2026-06-15T07:05:00.000Z'))).toBe(
      '2026-06-15 12:05 PKT'
    );
  });
});
