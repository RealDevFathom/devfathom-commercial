import { describe, expect, it } from 'vitest';

import { canSmsCustomer, hasWhatsAppReminderConsent } from './fallback';

const NOW = new Date('2026-10-21T08:00:00.000Z');
const granted = { granted: true, revokedAt: null, recordedAt: new Date('2026-10-01T00:00:00Z') };

describe('SMS fallback consent gates (#723)', () => {
  it('requires an active customer, a granted SMS consent and no SMS STOP', () => {
    expect(canSmsCustomer({ active: true, smsOptIn: null }, granted, NOW)).toBe(true);
    expect(canSmsCustomer({ active: true, smsOptIn: true }, granted, NOW)).toBe(true);
    expect(canSmsCustomer({ active: true, smsOptIn: false }, granted, NOW)).toBe(false);
    expect(canSmsCustomer({ active: false, smsOptIn: null }, granted, NOW)).toBe(false);
    expect(canSmsCustomer({ active: true, smsOptIn: null }, null, NOW)).toBe(false);
    expect(
      canSmsCustomer({ active: true, smsOptIn: null }, { ...granted, granted: false }, NOW)
    ).toBe(false);
    const fresh = { active: true, smsOptIn: null };
    expect(canSmsCustomer(fresh, { ...granted, revokedAt: NOW }, NOW)).toBe(false);
    const future = { ...granted, recordedAt: new Date(NOW.getTime() + 1) };
    expect(canSmsCustomer(fresh, future, NOW)).toBe(false);
  });

  it('mirrors the reminder jobs WhatsApp gate', () => {
    const optedIn = { active: true, whatsappOptIn: true };
    expect(hasWhatsAppReminderConsent(optedIn, granted, NOW)).toBe(true);
    const notAsked = { active: true, whatsappOptIn: null };
    expect(hasWhatsAppReminderConsent(notAsked, granted, NOW)).toBe(false);
    expect(hasWhatsAppReminderConsent(optedIn, null, NOW)).toBe(false);
  });
});
