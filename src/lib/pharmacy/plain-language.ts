import { formatWorkspaceDateTime, workspaceToday } from '@/lib/timezone';
import { formatMinor } from './counter-receipt';

/** Display copy only. Keys can be translated without changing report contracts or permissions. */
export const PHARMACY_COPY = {
  details: 'Details',
  calculation: 'How is this calculated?',
  reportsDescription: 'Sales, stock and accounts for your shop.',
  allBranches: 'All branches',
  selectedBranch: 'Selected branch',
  unavailable: 'Unavailable',
  currencyUnconfirmed: 'currency not confirmed',
  workPack: {
    title: 'Daily work pack',
    checkNote1:
      'Latest stock alerts for all staff; due dates checked at the time shown. Selected dates do not apply.',
    checkNote2:
      'Your saved stock alerts: overdue, due in the next 24 hours, needing a new check or reminders resuming. Selected dates do not apply.',
    checkNote3: 'Saved money checks for the selected dates; these checks have not been run again.',
    checkNote4:
      'Available stock not yet expired, compared with sales from the last 30 days. Selected dates do not apply.',
    checkNote5:
      'Latest supplier claims, credits and returns; ages and send-by dates checked at the time shown. Selected dates do not apply.',
    checkNote6:
      'This digest shows your alerts only. Alerts due later or still postponed are excluded. Some also appear on the stock dashboard.',
    checkNote7: 'Some stock information is missing.',
    checkNote8: 'This alert needs a new check. Confirm the stock before acting.',
    checkNote9: 'This money check is old. Confirm the records before acting.',
    checkNote10: 'This record includes information added after the selected check time.',
    loading: 'Checking your records. Other reports are still available.',
    failed:
      'Daily work pack could not load. Refresh to try again, or ask your administrator to check your access.',
    refresh: 'Refresh daily work pack',
    retry: 'Retry daily work pack',
    preparation: 'Things to check today',
    prepared: 'How this list was prepared',
    moneyHidden: 'Money-related checks are not shown for your role.',
    explanation:
      'This list only reads your records; it does not change stock or create drafts. Supplier, ingredient and batch filters do not apply. Amounts are shown to two decimal places; a dash means the figure was not available, not zero.',
    nothing: 'Nothing to act on from these checks.',
    partialEmpty: 'Nothing to do from the checks that loaded.',
    nothingToActOn: 'Nothing to act on',
    reviewItems: 'Items to review',
    checked: 'Checked',
    couldNotCheck: "Couldn't check — records or access are unavailable. Refresh to try again.",
    incomplete: 'The latest check may not include every item.',
    sourceNames: {
      'stock-dashboard': 'Stock dashboard',
      'stock-digest': 'Your stock digest',
      anomalies: 'Money checks',
      expiry: 'Expiry advice',
      'supplier-credit': 'Supplier credit',
    },
    titles: {
      'inventory-review': 'Check stock and expiry',
      'anomaly-review': 'Check unusual payments and amounts',
      'supplier-credit-review': 'Follow up supplier claims and returns',
    },
    results: {
      'inventory-review': 'Stock or expiry needs your attention.',
      'anomaly-review': 'Some payments or amounts need a check.',
      'supplier-credit-review': 'Supplier claims or returns need follow-up.',
    },
    actions: {
      'inventory-review': 'Review stock',
      'anomaly-review': 'Review money checks',
      'supplier-credit-review': 'Review supplier returns',
    },
    completeness:
      'Checks can overlap. Figures are estimates or recorded values, not savings to add together. An empty list does not mean every item was checked.',
    savedCheck: 'Saved checks may not reflect the latest records.',
    currentCheck: 'These are current records, not records saved for an earlier date.',
    expiryFailureDetail:
      'No stock or supplier-return data was changed. Expiry risk has not been assessed.',
    emptyCheck: 'No items were returned by this check; other items may still need attention.',
    failedCheck: 'This check could not load. Refresh or open the report to try again.',
    expiryFailure:
      'Expiry advice could not load; refresh to try again.',
  },
  account: {
    exportCsv: 'Download CSV',
    amountUnconfirmed: 'Amount unavailable (currency not confirmed)',
    noTotals: 'No account totals found',
    totalsMismatch: 'These totals do not match',
    allZero: 'All supplied amounts are zero',
    totalsChecked: 'Totals checked',
    chequeStates: {
      PDC: 'Post-dated',
      CLEARED: 'Cleared',
      BOUNCED: 'Bounced',
      REVERSED: 'Reversed',
      UNKNOWN: 'Not confirmed',
    },
    cashFlowClasses: {
      OPERATING: 'Day-to-day trade',
      INVESTING: 'Assets',
      FINANCING: 'Funding',
      UNCLASSIFIED: 'Needs a category',
    },
  },
  tender: {
    balance: 'Balance due',
    payments: 'Recorded payments',
    nextPayment: 'Payment',
    remaining: 'Remaining after this payment',
    cashShort: 'Cash received is less than the payment amount.',
    locked: 'Payment locked',
  },
  owner: {
    currentStock:
      'Stock figures show the latest records; sales and money figures use the selected dates.',
    amountNote: 'Amounts use two decimal places. A dash means unavailable, not zero.',
    currencyNote:
      'The currency is your current shop setting; older payments may use a different currency.',
    noCurrency: 'The currency could not be confirmed.',
    short: 'short',
    over: 'over',
    balanced: 'Balanced',
    noClose: 'Not computed · no final day close in period',
  },
} as const;

/** Format an instant for display without changing its filtering or business-day meaning. */
export function formatShopTime(
  value: string | Date | null | undefined,
  timeZone = 'Asia/Karachi',
  now = new Date()
): string {
  if (!value || !Number.isFinite(new Date(value).getTime())) return PHARMACY_COPY.unavailable;
  const formatted = formatWorkspaceDateTime(value, timeZone);
  if (workspaceToday(timeZone, new Date(value)) !== workspaceToday(timeZone, now)) return formatted;
  return `Today ${formatted.split(', ')[1]}`;
}

/** Calendar date labels deliberately keep the report's selected dates, not shifted instants. */
export function formatShopPeriod(from: string, to: string): string {
  const label = (value: string) => {
    const date = new Date(`${value}T12:00:00Z`);
    if (!Number.isFinite(date.getTime())) return PHARMACY_COPY.unavailable;
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(from.slice(0, 4) !== to.slice(0, 4) ? { year: 'numeric' as const } : {}),
      timeZone: 'UTC',
    }).format(date);
  };
  return from === to ? label(from) : `${label(from)} – ${label(to)}`;
}

export function cashVarianceLabel(value: number | null, currency: string | null): string {
  if (value === null || !Number.isSafeInteger(value)) return '—';
  if (value === 0) return PHARMACY_COPY.owner.balanced;
  const amount = formatMinor(Math.abs(value))
    .replace(/\B(?=(\d{3})+\.)/g, ',')
    .replace(/\.00$/, '');
  const prefix = currency ? `${currency} ` : '';
  return `${prefix}${amount}${currency ? '' : ` (${PHARMACY_COPY.currencyUnconfirmed})`} ${value < 0 ? PHARMACY_COPY.owner.short : PHARMACY_COPY.owner.over}`;
}

const WORK_PACK_STATES: Readonly<Record<string, string>> = {
  RECORDED: 'Recorded',
  OPEN: 'Open',
  ACKNOWLEDGED: 'Seen',
  SNOOZED: 'Postponed',
  STALE: 'Needs a new check',
  CLOSED: 'Closed',
  AT_RISK: 'Needs review',
  RETURNABLE: 'Can be returned',
  INSUFFICIENT_HISTORY: 'Not enough sales history',
  OUTSTANDING: 'Still due',
  overdue: 'Overdue',
  due: 'Due',
  upcoming: 'Due soon',
  unknown: 'Not confirmed',
  ready: 'Ready',
  blocked: 'Needs review',
};

export function workPackStateLabel(state: string): string {
  return WORK_PACK_STATES[state] ?? 'Needs review';
}

// Existing report-copy API retained while the remaining screens adopt keyed copy.
/**
 * Plain-language copy for the reports overview and Daily work pack.
 * Every sentence lives under a key so a translation (Urdu) can replace the
 * English text without touching the screens.
 */
export const plainCopy = {
  'workPack.badge.partial': 'Some information is missing',
  'workPack.badge.unknown': 'Not everything was checked',
  'workPack.details': 'Details',
  'workPack.refresh': 'Refresh daily work pack',
  'workPack.refreshNote':
    'Refresh reads the latest saved records. It does not create drafts or change any stock or money.',
  'workPack.amountNote':
    'Amounts are shown to two decimal places. The currency of these source records is not confirmed. A dash means the amount is not available, not zero.',
  'workPack.noResult':
    'Nothing needs review from the sources we could read. This does not mean everything is fine; open Details to see what was missing.',
  'workPack.sourcesHeading': 'Where this came from',
  'workPack.title': 'Daily work pack',
  'workPack.eyebrow': 'Today',
  'workPack.retry': 'Try again',
  'workPack.loading': 'Getting your daily work pack. Other reports are still available.',
  'workPack.failed':
    'The daily work pack could not load. Try again, or ask your administrator to check your access. Nothing was changed.',
  'workPack.noMoney': 'Money sources were not read for your role.',
  'workPack.notAvailable': 'Not available',
  'workPack.seen': 'Seen',
  'workPack.workedOut': 'Worked out',
  'workPack.dueOrExpires': 'Due or expires',
  'workPack.recordsRead': 'Records read',
  'workPack.checked': 'Checked',
  'workPack.limitReached': 'Only the first records were read; some may be left out.',
  'workPack.savedRecords': 'Saved records; may be out of date.',
  'workPack.currentRecords': 'Current records.',
  'workPack.couldNotLoad': 'Could not load',
  'workPack.noEligibleStock': 'No eligible stock',
  'workPack.adviceReady': 'Advice ready',
  'workPack.currencyUnverified': 'currency not confirmed',
  'workPack.updated': 'Updated',
  'workPack.periodNote':
    'Each source below keeps its own dates. Supplier, ingredient and batch filters do not apply here. These are current records, not a past snapshot.',
  'overview.outOfDate': 'Out of date',
  'overview.currencyKnown': "Amounts are in {currency}, your pharmacy's current currency setting.",
  'overview.currencyUnknown': 'Amounts have no currency because your pharmacy has not set one.',
  'overview.title': 'Reports',
  'overview.description': 'Your pharmacy figures for the dates and branch you choose.',
  'wp.title.supplier': 'Review supplier claims and deliveries',
  'wp.title.inventory': 'Review stock alerts',
  'wp.title.anomaly': 'Review unusual money records',
  'wp.completeness':
    'These groups are not separate problems; the same item can appear in more than one. Amounts are what was recorded, not savings you can add up. An empty list does not prove everything is fine.',
  'wp.savedNote': 'These are saved records and may not be fully up to date.',
  'wp.currentNote': 'These are current records, not a snapshot of the past.',
  'wp.capReached': 'Only the first 200 records were read; some may be left out.',
  'wp.capIncomplete': 'Only the first 200 records are read, so the list may be incomplete.',
  'wp.noneReturned': 'Nothing was returned; this is not an all-clear result.',
  'wp.dashboardBasis': 'Current stock alerts across all owners. The chosen dates do not apply.',
  'wp.digestBasis': 'Current stock alerts assigned to you only. The chosen dates do not apply.',
  'wp.staleRecord': 'This saved record is out of date; check the original facts.',
  'wp.afterAsOf': 'This record was updated after the time you are viewing.',
  'overview.details': 'Details',
  'overview.allBranches': 'All branches',
  'overview.updated': 'Updated',
  'overview.shortPrefix': 'PKR',
  'overview.detailsBody':
    'Sales, margin, cash, cash variance and refunds cover the selected dates. Stock alerts, recommended orders and expiry value are as of now; expiry value is not a loss yet. Margin is not cash. Margin comes from the same accounting entries as Finance, including returns and reversals, by posting date, so it can differ from sales by business date. Missing entries show as a dash. Supplier, ingredient and batch filters narrow sales, margin and stock figures. Cash, cash variance and refunds show a dash when those filters are used. The daily work pack and observed demand use branch and date filters only.',
} as const;

export type PlainCopyKey = keyof typeof plainCopy;

export const copy = (key: PlainCopyKey): string => plainCopy[key];

const PKT = 'Asia/Karachi';

function pktParts(date: Date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: PKT,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    label: `${parts.day} ${parts.month}`,
    year: parts.year,
    labelWithYear: `${parts.day} ${parts.month} ${parts.year}`,
    time: `${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toUpperCase()}`,
  };
}

/** "Today 6:20 PM", "Yesterday 9:05 AM", or "3 Nov 6:20 PM", in Pakistan time. Empty for bad input. */
export function formatPktTime(value: string | Date | null | undefined, now = new Date()): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const at = pktParts(date);
  if (at.day === pktParts(now).day) return `Today ${at.time}`;
  if (at.day === pktParts(new Date(now.getTime() - 86_400_000)).day) return `Yesterday ${at.time}`;
  const sameYear = at.year === pktParts(now).year;
  return `${sameYear ? at.label : at.labelWithYear} ${at.time}`;
}

/** "28 Oct – 3 Nov" from two YYYY-MM-DD business dates. */
export function formatDateRange(from: string, to: string): string {
  const fmt = (value: string) => {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
    }).format(date);
  };
  return from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
}

/** Cash variance as a sentence: "PKR 4 short", "PKR 4 over" or "Balanced". */
export function describeCashVariance(
  varianceMinor: number | null | undefined,
  format: (minor: number) => string
): { text: string; tone: 'short' | 'over' | 'even' | 'unknown' } {
  if (varianceMinor == null || !Number.isSafeInteger(varianceMinor))
    return { text: '—', tone: 'unknown' };
  if (varianceMinor === 0) return { text: 'Balanced', tone: 'even' };
  const amount = format(Math.abs(varianceMinor));
  return varianceMinor < 0
    ? { text: `${amount} short`, tone: 'short' }
    : { text: `${amount} over`, tone: 'over' };
}
