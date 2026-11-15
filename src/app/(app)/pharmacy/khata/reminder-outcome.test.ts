import { describe, expect, it } from 'vitest';
import type { KhataReminderRunResult } from '@/lib/pharmacy/whatsapp/khata-reminders';
import { reminderOutcome } from './reminder-outcome';

function run(overrides: Partial<KhataReminderRunResult> = {}): KhataReminderRunResult {
  return {
    configured: true,
    scanned: 1,
    sent: 0,
    prepared: 0,
    unknown: 0,
    failed: 0,
    duplicate: 0,
    skippedNoConsent: 0,
    skippedQuietHours: 0,
    skippedConfiguration: 0,
    notDue: 0,
    configurationErrors: [],
    sms: { sent: 0, prepared: 0, unknown: 0, failed: 0, duplicate: 0 },
    ...overrides,
  };
}
const sms = (counts: Partial<KhataReminderRunResult['sms']>) => ({
  ...run().sms,
  ...counts,
});

describe('DEV-730 owner reminder outcome', () => {
  it('reports WhatsApp delivery first', () => {
    expect(reminderOutcome(run({ sent: 1 }))).toBe('reminder-sent');
    expect(reminderOutcome(run({ prepared: 1 }))).toBe('reminder-prepared');
  });

  it('reports an SMS fallback send even when WhatsApp is not configured', () => {
    expect(reminderOutcome(run({ configured: false, sms: sms({ sent: 1 }) }))).toBe(
      'reminder-sms-sent'
    );
    expect(reminderOutcome(run({ configured: false, sms: sms({ prepared: 1 }) }))).toBe(
      'reminder-sms-prepared'
    );
  });

  it('reports duplicates and failures on either channel', () => {
    expect(reminderOutcome(run({ duplicate: 1 }))).toBe('reminder-duplicate');
    expect(reminderOutcome(run({ sms: sms({ duplicate: 1 }) }))).toBe('reminder-duplicate');
    expect(reminderOutcome(run({ unknown: 1 }))).toBe('reminder-failed');
    expect(reminderOutcome(run({ sms: sms({ failed: 1 }) }))).toBe('reminder-failed');
  });

  it('explains why nothing was sent', () => {
    expect(reminderOutcome(run({ configured: false, scanned: 0 }))).toBe('reminder-not-configured');
    expect(reminderOutcome(run({ skippedConfiguration: 1 }))).toBe('reminder-not-configured');
    expect(reminderOutcome(run({ skippedNoConsent: 1 }))).toBe('reminder-no-consent');
    expect(reminderOutcome(run({ skippedQuietHours: 1 }))).toBe('reminder-quiet-hours');
    expect(reminderOutcome(run({ notDue: 1 }))).toBe('reminder-not-due');
    expect(reminderOutcome(run({ scanned: 0 }))).toBe('reminder-not-due');
  });
});
