import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import {
  coverageDaysLabel,
  normalizeCoverageWindows,
  pharmacistCoverageWindowsSchema,
  storedCoverageWindows,
} from './pharmacist-coverage-hours';
import { pharmacistPresentAt, presenceHoursCheckEnabled } from './regulatory';

describe('pharmacist coverage hours (DEV-846)', () => {
  it('accepts a day shift and a window ending at midnight', () => {
    const parsed = pharmacistCoverageWindowsSchema.safeParse([
      { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
      { days: [6], start: '18:00', end: '24:00' },
    ]);
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['an end before its start', { days: [1], start: '17:00', end: '09:00' }, 'end'],
    ['a start of 24:00', { days: [1], start: '24:00', end: '24:00' }, 'start'],
    ['no days', { days: [], start: '09:00', end: '17:00' }, 'days'],
    ['a repeated day', { days: [1, 1], start: '09:00', end: '17:00' }, 'days'],
    ['a day outside the week', { days: [7], start: '09:00', end: '17:00' }, 'days'],
    ['a loose time', { days: [1], start: '9am', end: '17:00' }, 'start'],
  ])('refuses %s', (_label, window, field) => {
    const parsed = pharmacistCoverageWindowsSchema.safeParse([window]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path[1]).toBe(field);
  });

  it('refuses more than 28 windows', () => {
    const window = { days: [1], start: '09:00', end: '10:00' };
    expect(pharmacistCoverageWindowsSchema.safeParse(Array(29).fill(window)).success).toBe(false);
  });

  it('stores days in week order', () => {
    expect(normalizeCoverageWindows([{ days: [5, 0, 2], start: '09:00', end: '17:00' }])).toEqual([
      { days: [0, 2, 5], start: '09:00', end: '17:00' },
    ]);
    expect(coverageDaysLabel([5, 0])).toBe('Sun, Fri');
  });

  it('reads a stored record, and shows nothing for a missing or unreadable one', () => {
    const windows = [{ days: [1], start: '09:00', end: '17:00' }];
    expect(storedCoverageWindows({ timeZone: 'Asia/Karachi', windows })).toEqual(windows);
    expect(storedCoverageWindows(null)).toEqual([]);
    expect(storedCoverageWindows({ windows: 'Mon 9-5' })).toEqual([]);
    expect(storedCoverageWindows([windows])).toEqual([]);
  });
});

describe('live-sale hours check stays behind the rule set (DEV-846)', () => {
  it('is off for a rule set that publishes no presence hours', () => {
    expect(presenceHoursCheckEnabled({ provisional: true, values: {} })).toBe(false);
    expect(
      presenceHoursCheckEnabled({ provisional: false, values: { dispenseGrantRequired: true } })
    ).toBe(false);
    expect(presenceHoursCheckEnabled(null)).toBe(false);
    expect(presenceHoursCheckEnabled({ values: [] })).toBe(false);
  });

  it('is on exactly when the rule set publishes presence hours, as the gate reads them', () => {
    const rule = {
      provisional: false,
      values: {
        presenceHours: { windows: [{ days: [1], start: '09:00', end: '17:00' }] },
      },
    };
    expect(presenceHoursCheckEnabled(rule)).toBe(true);
    // Monday 03:00 in Karachi: the published hours refuse it.
    expect(pharmacistPresentAt(rule, new Date('2026-11-15T22:00:00.000Z'))).toBe(false);
  });

  it('an owner roster never restricts a sale: rules without presence hours allow any time', () => {
    const rule = { provisional: false, values: {} };
    expect(pharmacistPresentAt(rule, new Date('2026-11-16T22:00:00.000Z'))).toBe(true);
  });
});
