import type {
  PharmacyDailyWorkPack,
  PharmacyWorkPackEvidence,
  PharmacyWorkPackSource,
} from '@/lib/pharmacy/daily-work-pack';
import { workspaceTimezone } from '@/lib/timezone';

/**
 * DEV-595: the one place the Daily work pack turns the pack's internal source kinds, group
 * keys, states and field names into words an owner reads. The component renders only what
 * these helpers return, never a raw value from the pack, so a new enum value falls back to a
 * plain phrase instead of leaking onto the page.
 */

type Group = PharmacyDailyWorkPack['groups'][number]['key'];
type SourceKind = PharmacyWorkPackSource['kind'];
type ReferenceKind = PharmacyWorkPackEvidence['reference']['kind'];
export type WorkPackTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';
type StateLabel = { label: string; tone: WorkPackTone };

/** `lists` names what goes missing from the to-do list when this source does not load. */
export const workPackSourceLabels: Record<
  SourceKind,
  { name: string; lists: string; plural: boolean }
> = {
  'stock-dashboard': { name: 'Stock alerts', lists: 'stock alerts', plural: true },
  'stock-digest': { name: 'Your assigned alerts', lists: 'alerts assigned to you', plural: true },
  anomalies: { name: 'Unusual activity checks', lists: 'unusual sales', plural: true },
  expiry: { name: 'Expiry checks', lists: 'expiring stock', plural: false },
  'supplier-credit': { name: 'Supplier credit checks', lists: 'supplier credits', plural: true },
};

export const workPackGroupLabels: Record<Group, { title: string; action: string }> = {
  'inventory-review': {
    title: 'Check stock alerts and expiring stock',
    action: 'Open stock reports',
  },
  'anomaly-review': {
    title: 'Look into unusual discounts, refunds and cash',
    action: 'Open unusual activity',
  },
  'supplier-credit-review': {
    title: 'Follow up supplier credits and returns',
    action: 'Open supplier returns',
  },
};

const stockAlertKinds: Record<string, string> = {
  LOW_STOCK: 'Low stock',
  STOCKOUT: 'Out of stock',
  PROJECTED_STOCKOUT: 'Likely to run out',
  INBOUND_COVERAGE: 'Delivery may not cover sales',
  NEAR_EXPIRY: 'Close to expiry',
  RETURN_WINDOW: 'Return window closing',
  RECALL: 'Recalled stock',
  QUARANTINE: 'Stock on hold',
  COLD_CHAIN: 'Cold storage problem',
  COUNT_VARIANCE: 'Stock count difference',
};

const alertStates: Record<string, StateLabel> = {
  OPEN: { label: 'Open', tone: 'info' },
  ACKNOWLEDGED: { label: 'Seen', tone: 'neutral' },
  SNOOZED: { label: 'Snoozed', tone: 'neutral' },
  STALE: { label: 'Needs a fresh check', tone: 'warning' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
  DISMISSED: { label: 'Dismissed', tone: 'neutral' },
};

const evidenceKinds: Record<
  ReferenceKind,
  { title: string; states: Record<string, StateLabel | null>; due: string }
> = {
  'stock-kind': { title: 'Stock alerts', states: { RECORDED: null }, due: 'Due' },
  'stock-signal': { title: 'Stock alert for you', states: alertStates, due: 'Due' },
  anomaly: { title: 'Unusual activity', states: alertStates, due: 'Due' },
  lot: {
    title: 'Batch close to expiry',
    states: {
      AT_RISK: { label: 'May expire unsold', tone: 'warning' },
      RETURNABLE: { label: 'Can go back to the supplier', tone: 'info' },
      INSUFFICIENT_HISTORY: { label: 'Not enough sales history', tone: 'neutral' },
    },
    due: 'Expires',
  },
  'debit-note': { title: 'Supplier credit still owed', states: { OUTSTANDING: null }, due: 'Due' },
  return: {
    title: 'Supplier return not sent yet',
    states: {
      review: { label: 'Send before the deadline', tone: 'warning' },
      closed: { label: 'Return window closed', tone: 'danger' },
      unknown: { label: 'Deadline not recorded', tone: 'neutral' },
    },
    due: 'Send by',
  },
};

/** Recorded anomalies carry their kind only through the figures they hold. */
const anomalyTitles: [key: string, title: string][] = [
  ['discountMinor', 'Large discount'],
  ['unmatchedAmountMinor', 'Refund without a matching return'],
  ['varianceMinor', 'Cash count difference'],
  ['driftMinor', 'Purchase price change'],
  ['missingUnits', 'Stock count shortfall'],
];

const factLabels: Record<string, string> = {
  open: 'Open',
  acknowledged: 'Seen',
  snoozed: 'Snoozed',
  stale: 'Need a fresh check',
  overdue: 'Overdue',
  onHandUnits: 'Units on hand',
  projectedUnsoldUnits: 'Units likely to go unsold',
  historyDays: 'Days of sales history',
  ageDays: 'Days waiting',
  expectedUnits: 'Expected units',
  countedUnits: 'Counted units',
  missingUnits: 'Missing units',
  approvedThresholdUnits: 'Allowed difference (units)',
  grossMinor: 'Sale amount',
  discountMinor: 'Discount given',
  unmatchedAmountMinor: 'Refunded',
  expectedMinor: 'Expected cash',
  countedMinor: 'Counted cash',
  varianceMinor: 'Difference',
  currentUnitCostMinor: 'Cost per unit now',
  trailingUnitCostMinor: 'Earlier cost per unit',
  driftMinor: 'Change per unit',
  valueAtRiskMinor: 'Value at risk',
  outstandingMinor: 'Still owed',
  allocatedMinor: 'Already credited',
};

/** A field name the map does not know yet reads as words, never as a code. */
export function workPackFactLabel(key: string) {
  return (
    factLabels[key] ??
    key
      .replace(/Minor$/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/^./, (letter) => letter.toUpperCase())
  );
}

export function workPackEvidenceLabel(evidence: PharmacyWorkPackEvidence) {
  const kind = evidenceKinds[evidence.reference.kind];
  const keys = new Set([
    ...Object.keys(evidence.counts),
    ...(evidence.amounts ?? []).map((amount) => amount.key),
  ]);
  const title =
    evidence.reference.kind === 'stock-kind'
      ? (stockAlertKinds[evidence.reference.id] ?? kind?.title ?? 'Stock alerts')
      : evidence.reference.kind === 'anomaly'
        ? (anomalyTitles.find(([key]) => keys.has(key))?.[1] ?? kind.title)
        : (kind?.title ?? 'Item to review');
  const state = kind?.states[evidence.state];
  return {
    title,
    // Unmapped states still get a pill, in words, so nothing raw reaches the owner.
    state: state === null ? null : (state ?? { label: 'Needs review', tone: 'neutral' as const }),
    due: kind?.due ?? 'Due',
  };
}

function joinWords(words: string[]) {
  return words.length < 2
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const lowerFirst = (text: string) => text.replace(/^./, (letter) => letter.toLowerCase());

/**
 * One plain sentence naming every source that did not load and what is therefore missing
 * from the list, or null when every source loaded. It never says the list is complete.
 */
export function workPackMissingSourceNote(
  pack: Pick<PharmacyDailyWorkPack, 'sources' | 'scope'>,
  branchName: (id: string) => string
) {
  const unavailable = pack.sources.filter((source) => source.status !== 'available');
  if (!unavailable.length) return null;
  const kinds = (Object.keys(workPackSourceLabels) as SourceKind[]).filter((kind) =>
    unavailable.some((source) => source.kind === kind)
  );
  const branches = Array.from(new Set(unavailable.map((source) => source.scope.branchId)));
  const everywhere = kinds.every((kind) =>
    pack.scope.branchIds.every((branchId) =>
      unavailable.some((source) => source.kind === kind && source.scope.branchId === branchId)
    )
  );
  const where =
    everywhere || pack.scope.branchIds.length < 2
      ? ''
      : ` for ${joinWords(branches.map(branchName))}`;
  const names = kinds.map((kind, index) =>
    index ? lowerFirst(workPackSourceLabels[kind].name) : workPackSourceLabels[kind].name
  );
  const plural = kinds.length > 1 || workPackSourceLabels[kinds[0]!].plural;
  return `${joinWords(names)} couldn't load${where}, so ${joinWords(
    kinds.map((kind) => workPackSourceLabels[kind].lists)
  )} ${plural ? "aren't" : "isn't"} listed here.`;
}

/** A source that hit its row cap loaded, but only partly; say so in the same plain voice. */
export function workPackCapNote(pack: Pick<PharmacyDailyWorkPack, 'sources'>) {
  const capped = pack.sources.filter(
    (source) => source.status === 'available' && source.limitReached
  );
  if (!capped.length) return null;
  const kinds = Array.from(new Set(capped.map((source) => source.kind)));
  return `${joinWords(
    kinds.map((kind, index) =>
      index ? lowerFirst(workPackSourceLabels[kind].name) : workPackSourceLabels[kind].name
    )
  )} found more than this list can show; open the full report for the rest.`;
}

export const workPackOperationalOnlyNote =
  "Your role doesn't include money reports, so expiry, supplier credit and unusual sales checks aren't part of this list.";

export function workPackDate(iso: string | null, timeZone: string | null | undefined) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: workspaceTimezone(timeZone),
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

export function workPackTime(iso: string, timeZone: string | null | undefined) {
  if (!Number.isFinite(Date.parse(iso))) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: workspaceTimezone(timeZone),
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
