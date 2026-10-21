import { describe, expect, it } from 'vitest';

import { daysUntilExpiry, nearExpiryAlertBand } from './near-expiry-alerts';

const AT = new Date('2026-10-21T00:00:00.000Z');
const DAY = 86_400_000;

describe('near-expiry alert bands', () => {
  it('alerts at 30, 60 and 90 Karachi calendar days and stops past 90', () => {
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 30 * DAY), AT)).toBe(30);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 60 * DAY), AT)).toBe(60);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 90 * DAY), AT)).toBe(90);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 91 * DAY), AT)).toBeNull();
    expect(nearExpiryAlertBand(AT, AT)).toBeNull();
    expect(nearExpiryAlertBand(new Date(AT.getTime() - DAY), AT)).toBeNull();
  });

  it('keeps one millisecond past an elapsed window on the same Karachi date', () => {
    expect(daysUntilExpiry(new Date(AT.getTime() + 30 * DAY + 1), AT)).toBe(30);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 30 * DAY + 1), AT)).toBe(30);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 60 * DAY + 1), AT)).toBe(60);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 90 * DAY + 1), AT)).toBe(90);
  });

  it('keeps a lot inside 30 Karachi days on the 30-day alert just after midnight PKT', () => {
    const at = new Date('2026-10-21T19:00:01.000Z');
    const expiresAt = new Date(at.getTime() + 30 * DAY + 1);
    expect(daysUntilExpiry(expiresAt, at)).toBe(30);
    expect(nearExpiryAlertBand(expiresAt, at)).toBe(30);
  });

  it('counts a partial day on the same Karachi date as a whole day remaining', () => {
    expect(daysUntilExpiry(new Date(AT.getTime() + 1), AT)).toBe(1);
    expect(daysUntilExpiry(new Date(AT.getTime() + 30 * DAY), AT)).toBe(30);
  });
});
