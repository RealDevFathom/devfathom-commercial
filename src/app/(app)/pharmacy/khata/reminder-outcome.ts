import type { KhataReminderRunResult } from '@/lib/pharmacy/whatsapp/khata-reminders';

/**
 * Notice code for one owner-triggered reminder. WhatsApp outcomes win, then the DEV-87 SMS
 * fallback, so a reminder that went out by SMS is never reported as "not configured".
 */
export function reminderOutcome(result: KhataReminderRunResult): string {
  if (result.sent) return 'reminder-sent';
  if (result.prepared) return 'reminder-prepared';
  if (result.sms.sent) return 'reminder-sms-sent';
  if (result.sms.prepared) return 'reminder-sms-prepared';
  if (result.duplicate || result.sms.duplicate) return 'reminder-duplicate';
  if (result.failed || result.unknown || result.sms.failed || result.sms.unknown)
    return 'reminder-failed';
  if (!result.scanned && !result.configured) return 'reminder-not-configured';
  if (result.skippedConfiguration) return 'reminder-not-configured';
  if (result.skippedQuietHours) return 'reminder-quiet-hours';
  if (result.skippedNoConsent) return 'reminder-no-consent';
  return 'reminder-not-due';
}
