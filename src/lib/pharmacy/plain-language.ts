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
    'Amounts are shown in your pharmacy currency to two decimal places. A dash means the amount is not available, not zero.',
  'workPack.noResult':
    'Nothing needs review from the sources we could read. This does not mean everything is fine; open Details to see what was missing.',
  'workPack.sourcesHeading': 'Where this came from',
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
  return `${at.label} ${at.time}`;
}

/** "28 Oct – 3 Nov" from two YYYY-MM-DD business dates. */
export function formatDateRange(from: string, to: string): string {
  const fmt = (value: string) => {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(date);
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
