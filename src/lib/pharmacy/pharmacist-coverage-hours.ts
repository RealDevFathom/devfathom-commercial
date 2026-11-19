import { z } from '@/lib/zod-csp';

/**
 * DEV-846 / DEV-86 — the hours the owner records a pharmacist as covering a
 * branch. This is the owner's record only: the live-sale hours check reads the
 * jurisdiction rule set's `pharmacistCoverageRule.values.presenceHours`
 * (src/lib/pharmacy/regulatory.ts) and stays off until the pharmacist adviser's
 * Punjab and Sindh rules are published there. A roster alone cannot establish
 * who is present, so these hours never refuse a sale; the per-sale pharmacist
 * check is unchanged.
 *
 * The stored shape matches the rule set's `presenceHours` contract:
 * `{ timeZone, windows: [{ days (0 = Sunday), start 'HH:MM', end 'HH:MM' }] }`,
 * a window running from `start` up to, not including, `end`.
 */

export const PHARMACIST_COVERAGE_HOURS_SET_ACTION = 'pharmacy.branch.pharmacist_coverage.set';

export const PHARMACIST_COVERAGE_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Most windows a branch may record: four shifts a day for a week. */
export const PHARMACIST_COVERAGE_MAX_WINDOWS = 28;

/** The zone the presence gate assumes when none is recorded (regulatory.ts). */
export const PHARMACIST_COVERAGE_DEFAULT_TIME_ZONE = 'Asia/Karachi';

const START = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const END = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export function coverageMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours! * 60 + minutes!;
}

export const pharmacistCoverageWindowSchema = z
  .object({
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1, 'Choose at least one day.')
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'Choose each day once.'),
    start: z.string().regex(START, 'Enter a start time such as 09:00.'),
    end: z.string().regex(END, 'Enter an end time such as 17:00, or 24:00 for midnight.'),
  })
  .strict()
  .refine((window) => coverageMinutes(window.start) < coverageMinutes(window.end), {
    path: ['end'],
    message: 'End must follow start. Split a shift past midnight into two windows.',
  });

export type PharmacistCoverageWindow = z.infer<typeof pharmacistCoverageWindowSchema>;

export const pharmacistCoverageWindowsSchema = z
  .array(pharmacistCoverageWindowSchema)
  .max(
    PHARMACIST_COVERAGE_MAX_WINDOWS,
    `Record at most ${PHARMACIST_COVERAGE_MAX_WINDOWS} windows.`
  );

/** Days in week order, so the same hours always store and audit the same way. */
export function normalizeCoverageWindows(
  windows: readonly PharmacistCoverageWindow[]
): PharmacistCoverageWindow[] {
  return windows.map((window) => ({
    days: [...window.days].sort((a, b) => a - b),
    start: window.start,
    end: window.end,
  }));
}

/**
 * The windows a stored value holds, or [] when nothing (or nothing readable) is
 * recorded. Reading never throws: an unreadable value shows as "no hours".
 */
export function storedCoverageWindows(value: unknown): PharmacistCoverageWindow[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const parsed = pharmacistCoverageWindowsSchema.safeParse(
    (value as { windows?: unknown }).windows
  );
  return parsed.success ? parsed.data : [];
}

/** "Mon–Fri" style summary of a window's days, for the saved-hours list. */
export function coverageDaysLabel(days: readonly number[]): string {
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => PHARMACIST_COVERAGE_WEEKDAYS[day]?.slice(0, 3) ?? '')
    .join(', ');
}
