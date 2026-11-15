import { z } from '@/lib/zod-csp';

import type { ManualPaymentSettings } from './manual-payments';

/**
 * DEV-76 — owner-configured khata collection reminder schedule, per branch.
 * The cadence and balance floor are owner decisions, not facts: the defaults
 * below only seed a branch that has never saved its own schedule.
 */
export const KHATA_REMINDER_DEFAULTS = {
  enabled: true,
  cadenceDays: 7,
  minBalanceMinor: 10_000,
} as const;

export const KHATA_REMINDER_CADENCE_RANGE = { min: 1, max: 30 } as const;
export const KHATA_REMINDER_MIN_BALANCE_RANGE = { min: 100, max: 100_000_000 } as const;

export const khataReminderSettingsSchema = z
  .object({
    enabled: z.boolean(),
    cadenceDays: z
      .number()
      .int()
      .min(KHATA_REMINDER_CADENCE_RANGE.min, 'Remind at most once a day.')
      .max(KHATA_REMINDER_CADENCE_RANGE.max, 'Remind at least once every 30 days.'),
    minBalanceMinor: z
      .number()
      .int()
      .min(KHATA_REMINDER_MIN_BALANCE_RANGE.min, 'The minimum balance must be at least 1.00.')
      .max(KHATA_REMINDER_MIN_BALANCE_RANGE.max, 'The minimum balance is too large.'),
  })
  .strict();
export type KhataReminderSettings = z.infer<typeof khataReminderSettingsSchema>;

const PAY_TO_LABELS = { RAAST: 'Raast', JAZZCASH: 'JazzCash', EASYPAISA: 'Easypaisa' } as const;
const PAY_TO_ORDER = ['RAAST', 'JAZZCASH', 'EASYPAISA'] as const;

/**
 * The Raast / wallet destination a khata reminder asks the payer to use: the
 * branch's own merchant details, Raast first. Payment still lands through the
 * existing khata tender and reconciliation; this is only where to send money.
 * Returns null when the branch has not entered any destination.
 */
export function khataReminderPayTo(settings: ManualPaymentSettings): string | null {
  for (const type of PAY_TO_ORDER) {
    const destination = settings[type]?.destination
      ?.replace(/[\r\n\t\u2028\u2029]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (destination)
      return Array.from(`${PAY_TO_LABELS[type]} ${destination}`).slice(0, 80).join('');
  }
  return null;
}
