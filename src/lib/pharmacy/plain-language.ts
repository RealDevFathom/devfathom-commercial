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
    'Sales, margin, cash, cash variance and refunds cover the selected dates. Stock alerts, recommended orders and expiry value are as of now; expiry value is not a loss yet. Margin is not cash. Margin comes from the same accounting entries as Finance, including returns and reversals, by posting date, so it can differ from sales by business date. Missing entries show as a dash. Supplier, ingredient and batch filters do not change these totals, the daily work pack or observed demand.',
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
