import type { CampaignKind, GrowthSegment } from '@/lib/growth/view';

export const growthFieldClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export const KIND_LABEL: Record<CampaignKind, string> = {
  holiday: 'Holiday',
  slow_day: 'Slow day',
  birthday: 'Birthday',
  refill: 'Refill',
  winback: 'Win-back',
  random: 'Random',
  manual: 'Manual',
  review: 'Review',
  referral: 'Referral',
};

export const TEMPLATE_LABEL: Record<string, string> = {
  birthday_offer: 'Birthday offer',
  refill_reminder: 'Refill reminder',
  winback: 'Win-back',
  slow_day: 'Slow day',
  holiday: 'Holiday',
  review_request: 'Review request',
  referral: 'Referral',
  generic: 'Generic',
};

const KARACHI = 'Asia/Karachi';

export function formatPkr(minor: number): string {
  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  const major = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}PKR ${grouped}.${fraction}`;
}

export function rupeesInput(minor: number): string {
  const absolute = Math.abs(Math.trunc(minor));
  const major = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  const text = fraction ? `${major}.${String(fraction).padStart(2, '0')}` : String(major);
  return minor < 0 ? `-${text}` : text;
}

/** Whole rupees or rupees and paisa, as a shop would type them. */
export function minorFromRupees(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [major, fraction = ''] = value.split('.');
  return Number(major) * 100 + Number(fraction.padEnd(2, '0'));
}

export function formatDiscount(type: string | null, value: number | null): string {
  if (!type || type === 'none' || value == null) return 'No discount';
  if (type === 'percent') return `${value}%`;
  return formatPkr(value);
}

export function segmentLabel(segment: GrowthSegment): string {
  switch (segment.type) {
    case 'all':
      return 'Everyone opted in';
    case 'churn_band':
      return `Churn ${segment.band}`;
    case 'birthday':
      return `Birthdays in month ${segment.month}`;
    case 'refill_due':
      return `Refill within ${segment.withinDays} days`;
    case 'random':
      return `Random ${segment.pct}%`;
    case 'top_spenders':
      return `Top ${segment.n} spenders`;
    case 'inactive_days':
      return `Quiet ${segment.min}-${segment.max} days`;
  }
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-PK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: KARACHI,
  }).format(date);
}

export function karachiInputValue(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KARACHI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`;
}

/** Interpret a datetime-local value as Asia/Karachi, which does not observe DST. */
export function karachiLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const date = new Date(`${local}:00+05:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
