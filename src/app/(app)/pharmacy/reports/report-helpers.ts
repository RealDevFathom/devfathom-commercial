/**
 * Pure helpers shared by the Pharmacy Reports pages. Client-safe: no server
 * imports, no clock reads unless a `now` is passed in.
 */

const DAY_MS = 86_400_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Windows the expiry board accepts as `within`. */
export const EXPIRY_BOARD_WINDOWS = [30, 60, 90, 180] as const;
export type ExpiryBoardWindow = (typeof EXPIRY_BOARD_WINDOWS)[number];

const EXPIRY_METRIC = /^expiryValueMinor(\d+)$/;

/** Expiry board link pre-filtered to a window and, when one branch is chosen, that branch. */
export function expiryBoardHref(within?: ExpiryBoardWindow | null, branchId?: string | null) {
  const params = new URLSearchParams();
  if (within) params.set('within', String(within));
  if (branchId) params.set('branch', branchId);
  const query = params.toString();
  return `/pharmacy/inventory/expiry${query ? `?${query}` : ''}`;
}

/**
 * Drill-through target for a metric contract. Expiry-value metrics open the
 * expiry board filtered to the same window; every other metric keeps the
 * contract's own target.
 */
export function metricDrillThroughHref(
  metricKey: string,
  fallback: string | null,
  branchId?: string | null
): string | null {
  const match = EXPIRY_METRIC.exec(metricKey);
  if (match) {
    const days = Number(match[1]);
    if ((EXPIRY_BOARD_WINDOWS as readonly number[]).includes(days))
      return expiryBoardHref(days as ExpiryBoardWindow, branchId);
  }
  return fallback;
}

/** Adds `?branch=` to a report subpage link only when a branch is in focus. */
export function withBranch(path: string, branchId?: string | null) {
  return branchId ? `${path}?${new URLSearchParams({ branch: branchId })}` : path;
}

/** Back link to the reports page that keeps the branch and period the owner came from. */
export function reportsBackHref(scope: { branch?: string | null; from?: string; to?: string }) {
  const params = new URLSearchParams();
  if (scope.branch) params.set('branch', scope.branch);
  if (scope.from && YMD.test(scope.from)) params.set('from', scope.from);
  if (scope.to && YMD.test(scope.to)) params.set('to', scope.to);
  const query = params.toString();
  return `/pharmacy/reports${query ? `?${query}` : ''}`;
}

const timestampFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "1 Nov 2026, 14:59 UTC". Deterministic on server and client; unknown values read as such. */
export function formatReportTimestamp(
  value: string | Date | null | undefined,
  unavailable = 'Unavailable'
) {
  if (value == null || value === '') return unavailable;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return unavailable;
  return `${timestampFormat.format(date)} UTC`;
}

/** "26 Oct 2026" for a YYYY-MM-DD business date; anything else is returned unchanged. */
export function formatReportDate(value: string) {
  if (!YMD.test(value)) return value;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : value;
}

/** "26 Oct 2026 – 1 Nov 2026" (inclusive business dates). */
export function formatReportPeriod(from: string, to: string) {
  return from === to
    ? formatReportDate(from)
    : `${formatReportDate(from)} – ${formatReportDate(to)}`;
}

/**
 * Default repeat-purchasing window: the last 90 days ending today (the longest
 * window the report accepts), with a cutoff at the start of the current minute
 * so the datetime picker shows exactly the cutoff that was used.
 */
export function defaultRepeatWindow(now: Date) {
  const today = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${today}T00:00:00.000Z`) - 89 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const asOf = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  return { from, to: today, asOf };
}

const LOCAL_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?$/;

/**
 * A `datetime-local` value carries no timezone. Report pickers label it UTC, so
 * it becomes an explicit UTC instant. Values that already carry a timezone, or
 * are not instants at all, pass through for the existing validation to judge.
 */
export function utcInstantFromPicker(raw: string) {
  const value = raw.trim();
  const match = LOCAL_INSTANT.exec(value);
  if (!match) return value;
  return `${match[1]}${match[2] ?? ':00'}Z`;
}

/** The `datetime-local` value (UTC, minute precision) for an ISO instant; empty when invalid. */
export function pickerValueFromInstant(iso: string) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 16);
}

export type ReportFilterOption = { id: string; label: string };

/**
 * Options for a name picker. A selected ID that is not in the loaded list (an
 * older link, or beyond the list limit) stays selectable so applying the
 * filters again never silently drops it.
 */
export function pickerOptions(
  options: readonly ReportFilterOption[],
  selectedId: string | undefined,
  noun: string
): ReportFilterOption[] {
  if (!selectedId || options.some((option) => option.id === selectedId)) return [...options];
  return [{ id: selectedId, label: `Selected ${noun} (not in this list)` }, ...options];
}

/** Why "Read replenishment report" is unavailable, in plain words; null when it can run. */
export function replenishmentBlockedReason({
  branchId,
  medicineId,
  medicineCount,
  loading,
}: {
  branchId: string;
  medicineId: string;
  medicineCount: number;
  loading: boolean;
}) {
  if (loading) return null;
  if (!branchId) return 'Select a branch first, then search for a medicine.';
  if (!medicineId)
    return medicineCount
      ? 'Choose a medicine from the list to read its report.'
      : 'Search for a medicine and choose it from the list to read its report.';
  return null;
}
