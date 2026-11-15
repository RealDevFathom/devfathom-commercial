/**
 * DEV-14: staffing suggestions from hourly footfall in completed sales history.
 *
 * Footfall here is the count of completed, original (non-return) receipts per local hour on
 * the workspace clock. It is observed counter traffic, not people through the door. The output
 * is a suggestion only: nothing is rostered, scheduled or messaged, and the capacity figure is
 * an owner-configurable assumption, never a fact baked into the code.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceDateRange, workspaceTimezone } from '@/lib/timezone';

export type StaffingConfig = {
  /** Assumed receipts one staff member can serve in an hour. Owner-configurable estimate. */
  receiptsPerStaffHour: number;
  /** Staff the owner wants on duty in any hour that saw sales (solo pharmacies use 1). */
  minimumStaff: number;
};

/** Starting assumption only; the report labels it as editable and the owner may override it. */
export const DEFAULT_STAFFING_CONFIG: StaffingConfig = {
  receiptsPerStaffHour: 12,
  minimumStaff: 1,
};

export const STAFFING_LIMITS = {
  receiptsPerStaffHour: { min: 1, max: 200 },
  minimumStaff: { min: 1, max: 20 },
  maximumDays: 92,
} as const;

export type HourlyFootfall = {
  /** Local hour on the workspace clock, 0–23. */
  hour: number;
  receipts: number;
  /** Mean receipts in this hour per calendar day of the window. */
  averagePerDay: number;
  /** Highest receipts seen in this hour on any one day of the window. */
  busiestDay: number;
};

export type StaffingSuggestion = HourlyFootfall & {
  /** Null when the hour saw no sales in the window: no suggestion is made. */
  suggestedStaff: number | null;
};

export class StaffingSuggestionError extends Error {}

function validConfig(config: StaffingConfig) {
  const { receiptsPerStaffHour: r, minimumStaff: m } = config;
  return (
    Number.isSafeInteger(r) &&
    r >= STAFFING_LIMITS.receiptsPerStaffHour.min &&
    r <= STAFFING_LIMITS.receiptsPerStaffHour.max &&
    Number.isSafeInteger(m) &&
    m >= STAFFING_LIMITS.minimumStaff.min &&
    m <= STAFFING_LIMITS.minimumStaff.max
  );
}

/** Count receipts by local hour; `days` is the number of calendar days in the window. */
export function hourlyFootfall(
  receiptTimes: readonly Date[],
  timeZone: string | null | undefined,
  days: number
): HourlyFootfall[] {
  if (!Number.isSafeInteger(days) || days < 1)
    throw new StaffingSuggestionError('The window must cover at least one day.');
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: workspaceTimezone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const totals = Array.from({ length: 24 }, () => 0);
  const perDay = Array.from({ length: 24 }, () => new Map<string, number>());
  for (const at of receiptTimes) {
    const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
    const hour = Number(parts.hour) % 24;
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    totals[hour] += 1;
    perDay[hour].set(day, (perDay[hour].get(day) ?? 0) + 1);
  }
  return totals.map((receipts, hour) => ({
    hour,
    receipts,
    averagePerDay: Math.round((receipts / days) * 100) / 100,
    busiestDay: Math.max(0, ...perDay[hour].values()),
  }));
}

/** Suggest staff per hour from average footfall; quiet hours (no sales) get no suggestion. */
export function suggestStaffing(
  footfall: readonly HourlyFootfall[],
  config: StaffingConfig
): StaffingSuggestion[] {
  if (!validConfig(config)) throw new StaffingSuggestionError('Invalid staffing configuration.');
  return footfall.map((row) => ({
    ...row,
    suggestedStaff:
      row.receipts === 0
        ? null
        : Math.max(config.minimumStaff, Math.ceil(row.averagePerDay / config.receiptsPerStaffHour)),
  }));
}

function windowDays(from: string, to: string) {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (
    !pattern.test(from) ||
    !pattern.test(to) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    new Date(start).toISOString().slice(0, 10) !== from ||
    new Date(end).toISOString().slice(0, 10) !== to ||
    end < start
  )
    throw new StaffingSuggestionError('Enter valid dates with From on or before To.');
  const days = (end - start) / 86_400_000 + 1;
  if (days > STAFFING_LIMITS.maximumDays)
    throw new StaffingSuggestionError(
      `Choose a window of at most ${STAFFING_LIMITS.maximumDays} days.`
    );
  return days;
}

/** Read completed sales for one branch and build suggestions on the workspace clock. */
export async function readStaffingSuggestions(
  db: ScopedDb,
  organizationId: string,
  input: {
    branchId: string;
    from: string;
    to: string;
    timeZone: string | null | undefined;
    config: StaffingConfig;
  }
) {
  const days = windowDays(input.from, input.to);
  if (!validConfig(input.config))
    throw new StaffingSuggestionError('Invalid staffing configuration.');
  const window = workspaceDateRange(input.from, input.to, input.timeZone);
  const sales = await db.pharmacySale.findMany({
    where: {
      organizationId,
      branchId: input.branchId,
      status: 'COMPLETED',
      originalSaleId: null,
      completedAt: { gte: window.from, lt: window.to },
    },
    select: { completedAt: true },
  });
  const times = sales.flatMap((sale) => (sale.completedAt ? [sale.completedAt] : []));
  return {
    label: 'Suggestion' as const,
    method: 'Completed original receipts counted by local hour, averaged per calendar day',
    exclusions: ['returns', 'voided, held and open sales', 'quotations'],
    window,
    days,
    totalReceipts: times.length,
    config: input.config,
    hours: suggestStaffing(hourlyFootfall(times, input.timeZone, days), input.config),
  };
}
