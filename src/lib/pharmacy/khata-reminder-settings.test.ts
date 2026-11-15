import { describe, expect, it } from 'vitest';

import {
  isKhataReminderQuietHour,
  KHATA_REMINDER_DEFAULTS,
  khataReminderPayTo,
  khataReminderSettingsSchema,
} from './khata-reminder-settings';

describe('DEV-76 khata reminder settings', () => {
  it('treats 22:00 to 08:59 local as quiet hours', () => {
    for (const hour of [22, 23, 0, 3, 8]) expect(isKhataReminderQuietHour(hour)).toBe(true);
    for (const hour of [9, 12, 21]) expect(isKhataReminderQuietHour(hour)).toBe(false);
    expect(isKhataReminderQuietHour(Number.NaN)).toBe(true);
  });

  it('accepts the defaults and bounds the owner schedule', () => {
    expect(khataReminderSettingsSchema.parse(KHATA_REMINDER_DEFAULTS)).toEqual(
      KHATA_REMINDER_DEFAULTS
    );
    for (const settings of [
      { ...KHATA_REMINDER_DEFAULTS, cadenceDays: 0 },
      { ...KHATA_REMINDER_DEFAULTS, cadenceDays: 31 },
      { ...KHATA_REMINDER_DEFAULTS, cadenceDays: 1.5 },
      { ...KHATA_REMINDER_DEFAULTS, minBalanceMinor: 99 },
      { ...KHATA_REMINDER_DEFAULTS, extra: true },
    ])
      expect(khataReminderSettingsSchema.safeParse(settings).success).toBe(false);
  });

  it('prefers Raast, then JazzCash, then Easypaisa, and stays single-line', () => {
    expect(khataReminderPayTo({})).toBeNull();
    expect(
      khataReminderPayTo({
        EASYPAISA: { destination: 'Till 1', allowReferenceSkip: false },
        JAZZCASH: { destination: ' 0300\r\n1234567 ', allowReferenceSkip: false },
      })
    ).toBe('JazzCash 0300 1234567');
    expect(
      khataReminderPayTo({
        RAAST: { destination: 'PK36SCBL0000001123456702', allowReferenceSkip: false },
        JAZZCASH: { destination: '03001234567', allowReferenceSkip: false },
      })
    ).toBe('Raast PK36SCBL0000001123456702');
    expect(
      khataReminderPayTo({ RAAST: { destination: 'x'.repeat(120), allowReferenceSkip: false } })
    ).toHaveLength(80);
  });
});
