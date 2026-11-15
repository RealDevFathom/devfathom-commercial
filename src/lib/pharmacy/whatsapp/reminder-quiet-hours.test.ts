import { describe, expect, it } from 'vitest';

import { isUtilityReminderQuietHour, reminderLocalHour } from './reminder-quiet-hours';

describe('utility reminder quiet hours', () => {
  it('treats 22:00 to 08:59 local as quiet hours', () => {
    for (const hour of [22, 23, 0, 3, 8]) expect(isUtilityReminderQuietHour(hour)).toBe(true);
    for (const hour of [9, 12, 21]) expect(isUtilityReminderQuietHour(hour)).toBe(false);
    expect(isUtilityReminderQuietHour(Number.NaN)).toBe(true);
  });

  it('reads the hour in the workspace zone', () => {
    const now = new Date('2026-10-21T03:30:00Z');
    expect(reminderLocalHour(now, 'Asia/Karachi')).toBe(8);
    expect(reminderLocalHour(now, 'UTC')).toBe(3);
  });
});
