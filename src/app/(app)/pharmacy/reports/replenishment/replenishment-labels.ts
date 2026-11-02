import { demandDateAfter, demandDateMs } from '@/lib/pharmacy/demand-evidence';
import type {
  PharmacyReplenishmentReport,
  PharmacyReplenishmentReportInput,
} from '@/lib/pharmacy/replenishment-report';
import { workspaceTimezone, workspaceToday } from '@/lib/timezone';

/**
 * DEV-596: the one place the replenishment report turns its enum values into words an owner
 * reads. The console renders only what these maps return; a value they do not know reads as a
 * plain fallback, never as the raw code.
 */

type Report = PharmacyReplenishmentReport;
type Decision = NonNullable<Report['planning']['decision']>;
type Policy = Decision['scenarios'][number]['policy'];
type OrderStatus = Decision['scenarios'][number]['order']['status'];
export type ReplenishmentTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';
type Labelled = { label: string; tone: ReplenishmentTone };

export const forecastMethodLabels: Record<PharmacyReplenishmentReportInput['method'], string> = {
  RECENT_MEAN: 'Average of recent days',
  // Each forecast day repeats the matching weekday from the last week of sales history.
  WEEKLY_SEASONAL_NAIVE: 'Same weekday last week',
};

export const planningBasisLabels: Record<Report['planning']['basis'], string> = {
  USER_SUPPLIED_ASSUMPTIONS: 'Your settings',
};

export const planningStatusLabels: Record<Report['planning']['status'], Labelled> = {
  NOT_REQUESTED: { label: 'Not requested', tone: 'neutral' },
  REDACTED: { label: 'Hidden for your role', tone: 'neutral' },
  INSUFFICIENT_STOCK_EVIDENCE: { label: 'No stock on record', tone: 'warning' },
  AVAILABLE: { label: 'Ready', tone: 'success' },
};

export const forecastStatusLabels: Record<Report['forecast']['status'], Labelled> = {
  AVAILABLE: { label: 'Forecast ready', tone: 'success' },
  INSUFFICIENT_EVIDENCE: { label: 'Not enough sales data', tone: 'warning' },
};

export const backtestStatusLabels: Record<Report['backtest']['status'], Labelled> = {
  INELIGIBLE: { label: 'Accuracy not checked yet', tone: 'neutral' },
};

export const stockCheckLabels: Record<
  Report['observations']['supplyCoverage']['status'],
  Labelled & { detail: string }
> = {
  UNKNOWN: {
    label: 'Stock count not confirmed',
    tone: 'warning',
    detail:
      "We can't confirm every batch is recorded, so treat these stock numbers as a minimum. If no stock shows, that doesn't mean you have none.",
  },
};

/** Whether the medicine was on the shelf all day; sales alone cannot confirm it. */
const dayStateLabels: Record<string, string> = {
  OBSERVED: 'Yes',
  UNKNOWN: 'Not confirmed',
  STOCKOUT_CENSORED: 'No, it ran out',
  CLOSED: 'Closed',
};

export const policyLabels: Record<Policy, string> = {
  NO_ORDER: "Don't order",
  CURRENT: 'Your usual order',
  PROPOSED: 'New order',
};

export const orderStatusLabels: Record<OrderStatus, Labelled & { detail: string }> = {
  FEASIBLE: { label: 'Fits your limits', tone: 'success', detail: '' },
  CONSTRAINED: {
    label: 'Cut to fit your limits',
    tone: 'warning',
    detail: 'The order was reduced to fit your budget, shelf space or pack size.',
  },
  INFEASIBLE: {
    label: "Doesn't fit your limits",
    tone: 'danger',
    detail: "Your budget or shelf space can't fit one full pack at the minimum order.",
  },
  UNKNOWN: {
    label: 'Needs more numbers',
    tone: 'neutral',
    detail: 'Add the cost per unit, budget, shelf space, arrival and expiry dates to check it.',
  },
};

const fallback: Labelled = { label: 'Not available', tone: 'neutral' };

/** Look up a label, never echoing an unmapped code back to the page. */
export function labelFor<T extends string, L>(map: Record<T, L>, value: string, otherwise: L): L {
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value as T] : otherwise;
}

export const statusLabel = <T extends string>(map: Record<T, Labelled>, value: string) =>
  labelFor(map, value, fallback);

export const dayStateLabel = (value: string) => labelFor(dayStateLabels, value, 'Not confirmed');

export const policyLabel = (value: string) => labelFor(policyLabels, value, 'Order plan');

export function goalResultLabel(value: boolean | null) {
  return value === null ? 'not checked' : value ? 'met' : 'not met';
}

const tokenWords: Record<string, string> = {
  ...policyLabels,
  MANUAL_SCENARIO: 'your settings',
  OBSERVED_TRANSACTIONS: 'recorded sales',
  SYNTHETIC_FIXTURE: 'sample data',
  MOQ: 'minimum order',
};

/**
 * Server notes are English but can embed codes (`NO_ORDER: arrival …`, `POSTED`, `readAt`).
 * Rewrite every such token so the technical notes still never show a raw enum value.
 */
export function plainReason(text: string) {
  return text
    .replace(/^(NO_ORDER|CURRENT|PROPOSED):/, (_, policy: Policy) => `${policyLabels[policy]}:`)
    .replace(/\breadAt\b/g, 'the read time')
    .replace(/\bknownAt\b/g, 'the first-recorded time')
    .replace(
      /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b(?:MOQ|POSTED|COMPLETED|STOCKOUT)\b/g,
      (token) => tokenWords[token] ?? token.toLowerCase().replaceAll('_', ' ')
    );
}

/**
 * Report days are calendar labels (YYYY-MM-DD) anchored at 00:00Z: the demand reader buckets
 * sales by that label and stored business dates use the same convention for the workspace's
 * own calendar day (`${workspaceToday(zone)}T00:00:00.000Z`). So a date the owner picks in the
 * workspace zone is sent as the same label, and "Forecast from" is the exclusive end of the
 * sales history. The zone decides which day is today and what can be picked: the server refuses
 * a Forecast-from label whose 00:00Z is still ahead of the read time (early morning in UTC+
 * zones), and a plan start that is not after now or more than 31 days ahead.
 */
export function serverDay(localDate: string) {
  demandDateMs(localDate);
  return localDate;
}

/** A picked arrival/expiry day as the instant the simulated day starts. */
export function serverDayStart(localDate: string) {
  return new Date(demandDateMs(localDate)).toISOString();
}

export function replenishmentDates(timeZone: string | null | undefined, now: Date) {
  const zone = workspaceTimezone(timeZone);
  const today = workspaceToday(zone, now);
  const utcToday = now.toISOString().slice(0, 10);
  const latestForecastFrom = today < utcToday ? today : utcToday;
  const earliestPlanStart = demandDateAfter(utcToday, 1);
  const latestPlanStart = new Date(now.getTime() + 31 * 86_400_000).toISOString().slice(0, 10);
  const tomorrow = demandDateAfter(today, 1);
  return {
    timeZone: zone,
    zoneName:
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'long' })
        .formatToParts(now)
        .find((part) => part.type === 'timeZoneName')?.value ?? zone,
    latestForecastFrom,
    earliestPlanStart,
    latestPlanStart,
    defaultPlanStart: tomorrow < earliestPlanStart ? earliestPlanStart : tomorrow,
  };
}

/** A report day label for reading, e.g. "2 Nov 2026"; labels are formatted as written. */
export function dayLabel(date: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(demandDateMs(date)));
  } catch {
    return 'Unknown date';
  }
}

/** The last day a period covers, from its exclusive end label. */
export const lastDayLabel = (endDateExclusive: string) => {
  try {
    return dayLabel(demandDateAfter(endDateExclusive, -1));
  } catch {
    return 'Unknown date';
  }
};

export function readTimeLabel(iso: string, timeZone: string | null | undefined) {
  if (!Number.isFinite(Date.parse(iso))) return 'Unknown time';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: workspaceTimezone(timeZone),
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
