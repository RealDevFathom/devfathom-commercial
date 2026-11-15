import { createHash } from 'node:crypto';

/**
 * DEV-79 — back-in-stock follow-up rules for DEM-03 restock interests.
 *
 * Pure policy, kept free of database access so the WhatsApp job, the GRN hook,
 * recovery linking and the owner report share one definition:
 * - a waiting request expires after `requestExpiryDays` and is never notified;
 * - waiting requests are notified first-in, first-out, once per request;
 * - the WhatsApp utility template carries only the branch name, the request
 *   date and an opaque reference. Product, salt and category names never leave
 *   the pharmacy; the customer gets details at the counter;
 * - a completed sale of the same SKU at the branch within
 *   `recoveryWindowDays` of the notice links the request, preferring the
 *   customer who asked. Recovered value is the linked sale line's value.
 *
 * The 14 and 7 day windows come from the growth research and are estimates, so
 * both are deployment configuration rather than fixed facts.
 */

export const DAY_MS = 86_400_000;

export type BackInStockPolicy = {
  /** Days after capture during which a waiting request may still be notified. */
  requestExpiryDays: number;
  /** Days after the notice during which a matching sale counts as recovered. */
  recoveryWindowDays: number;
};

export const BACK_IN_STOCK_DEFAULTS: BackInStockPolicy = {
  requestExpiryDays: 14,
  recoveryWindowDays: 7,
};

type Env = Record<string, string | undefined>;

function boundedDays(raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 1 && value <= 90 ? value : fallback;
}

export function readBackInStockPolicy(env: Env = process.env): BackInStockPolicy {
  return {
    requestExpiryDays: boundedDays(
      env.PHARMACY_BACK_IN_STOCK_REQUEST_EXPIRY_DAYS,
      BACK_IN_STOCK_DEFAULTS.requestExpiryDays
    ),
    recoveryWindowDays: boundedDays(
      env.PHARMACY_BACK_IN_STOCK_RECOVERY_WINDOW_DAYS,
      BACK_IN_STOCK_DEFAULTS.recoveryWindowDays
    ),
  };
}

/** Requests captured at or before this instant have expired. */
export function restockRequestCutoff(now: Date, policy: BackInStockPolicy) {
  return new Date(now.getTime() - policy.requestExpiryDays * DAY_MS);
}

export function isRestockRequestExpired(createdAt: Date, now: Date, policy: BackInStockPolicy) {
  return createdAt.getTime() <= restockRequestCutoff(now, policy).getTime();
}

export type WaitingRestockRequest = {
  id: string;
  status: string;
  createdAt: Date;
};

/**
 * FIFO queue of requests that may still be notified: OPEN (never notified, so
 * each request is notified at most once) and not expired. Ties on capture time
 * break on id so repeated runs order identically.
 */
export function backInStockQueue<T extends WaitingRestockRequest>(
  requests: readonly T[],
  now: Date,
  policy: BackInStockPolicy
) {
  const queue: T[] = [];
  const expired: T[] = [];
  for (const request of requests) {
    if (request.status !== 'OPEN') continue;
    if (isRestockRequestExpired(request.createdAt, now, policy)) expired.push(request);
    else queue.push(request);
  }
  const fifo = (a: T, b: T) =>
    a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { queue: queue.sort(fifo), expired: expired.sort(fifo) };
}

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Opaque, stable counter reference for one request. Derived from the request
 * id only, so it can never spell or encode a product.
 */
export function backInStockReference(interestId: string) {
  const digest = createHash('sha256').update(`back-in-stock:${interestId}`).digest();
  let reference = '';
  for (let index = 0; index < 8; index += 1)
    reference += REFERENCE_ALPHABET[digest[index]! % REFERENCE_ALPHABET.length];
  return reference;
}

/**
 * Medicine category words a notice must never carry, whatever the branch is
 * called. Product and salt names are added per request by the caller.
 */
export const BACK_IN_STOCK_CATEGORY_TERMS = [
  'analgesic',
  'antibiotic',
  'antidepressant',
  'antidiabetic',
  'antifungal',
  'antihistamine',
  'antihypertensive',
  'antiviral',
  'biological',
  'capsule',
  'contraceptive',
  'inhaler',
  'injection',
  'insulin',
  'narcotic',
  'ointment',
  'opioid',
  'painkiller',
  'pharmaceutical',
  'psychotropic',
  'sedative',
  'steroid',
  'supplement',
  'syrup',
  'tablet',
  'vaccine',
  'vitamin',
] as const;

function normalizeForMatch(text: string) {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * True when any parameter contains a forbidden term. Terms shorter than three
 * characters are ignored: they would match ordinary words, not product names.
 */
export function templateNamesProduct(
  parameters: readonly string[],
  forbiddenTerms: readonly (string | null | undefined)[]
) {
  const terms = [...BACK_IN_STOCK_CATEGORY_TERMS, ...forbiddenTerms]
    .filter((term): term is string => typeof term === 'string')
    .map(normalizeForMatch)
    .filter((term) => term.length >= 3);
  const texts = parameters.map(normalizeForMatch);
  return texts.some((text) => terms.some((term) => text.includes(term)));
}

export class BackInStockTemplateError extends Error {
  constructor() {
    super('BACK_IN_STOCK_TEMPLATE_NAMES_PRODUCT');
    this.name = 'BackInStockTemplateError';
  }
}

/**
 * Body parameters for the approved utility template, in placeholder order:
 * "The item you asked about at {{1}} on {{2}} is now available. Ref #{{3}}.
 * Reply STOP to opt out." Throws rather than send a notice that would name the
 * product, its salt or its category.
 */
export function backInStockTemplateParameters(
  input: { branchName: string; requestedOn: string; interestId: string },
  forbiddenTerms: readonly (string | null | undefined)[]
): [string, string, string] {
  const branchName = input.branchName.replace(/\s+/g, ' ').trim();
  if (!branchName || !/^\d{4}-\d{2}-\d{2}$/.test(input.requestedOn))
    throw new BackInStockTemplateError();
  const parameters: [string, string, string] = [
    branchName,
    input.requestedOn,
    backInStockReference(input.interestId),
  ];
  if (templateNamesProduct(parameters, forbiddenTerms)) throw new BackInStockTemplateError();
  return parameters;
}

export type RecoveryCandidateLine = {
  saleLineId: string;
  saleId: string;
  medicineId: string;
  /** Patient behind the sale's customer, when the sale named one. */
  patientId: string | null;
  completedAt: Date;
};

/**
 * The sale line that recovers one notified request: the same SKU, completed
 * after the notice and within the recovery window. A sale to the customer who
 * asked wins over another customer's; then the earliest sale; then the id.
 * Lines already linked to another request are excluded by the caller.
 */
export function selectRecoveryLine<T extends RecoveryCandidateLine>(
  request: { medicineId: string; patientId: string | null; notifiedAt: Date },
  candidates: readonly T[],
  policy: BackInStockPolicy
): T | null {
  const opens = request.notifiedAt.getTime();
  const closes = opens + policy.recoveryWindowDays * DAY_MS;
  const eligible = candidates.filter(
    (line) =>
      line.medicineId === request.medicineId &&
      line.completedAt.getTime() > opens &&
      line.completedAt.getTime() <= closes
  );
  const sameCustomer = (line: T) =>
    request.patientId !== null && line.patientId === request.patientId ? 0 : 1;
  eligible.sort(
    (a, b) =>
      sameCustomer(a) - sameCustomer(b) ||
      a.completedAt.getTime() - b.completedAt.getTime() ||
      (a.saleLineId < b.saleLineId ? -1 : a.saleLineId > b.saleLineId ? 1 : 0)
  );
  return eligible[0] ?? null;
}

/** Owner-facing definitions for the DEV-79 lost-sales recovery report. */
export const LOST_SALES_RECOVERY_DEFINITIONS = {
  estimatedLost:
    'Sum of recorded estimated values on explicit POS-10 demand events captured in the selected branches and inclusive UTC dates. Events without an estimate add nothing and are counted separately.',
  recovered:
    'Net value (gross less discount) of the receipted sale line each event was linked to: a back-in-stock recovery within the configured window after the notice, or a recorded alternate.',
  net: 'Estimated lost less recovered. An estimate, not a realized loss.',
  salt: 'Ingredients of the requested item. A combination item counts under each salt, so salt rows overlap.',
  distributor:
    "Supplier of the item's latest posted goods receipt at the branch. Items never received there show as unknown.",
} as const;

export type LostSalesRecoveryRow = {
  branchId: string;
  branchName: string;
  /** Salt (ingredient) names of the requested SKU; empty when unresolved. */
  salts: readonly string[];
  /** Supplier of the SKU's latest posted receipt at the branch, when known. */
  distributor: string | null;
  estimatedLostMinor: number | null;
  recoveredMinor: number;
};

export type LostSalesRecoveryTotals = {
  estimatedLostMinor: number;
  recoveredMinor: number;
  netMinor: number;
  events: number;
  recoveredEvents: number;
};

type Group = LostSalesRecoveryTotals & { key: string; label: string };

function emptyTotals(): LostSalesRecoveryTotals {
  return { estimatedLostMinor: 0, recoveredMinor: 0, netMinor: 0, events: 0, recoveredEvents: 0 };
}

function add(target: LostSalesRecoveryTotals, row: LostSalesRecoveryRow) {
  target.estimatedLostMinor += row.estimatedLostMinor ?? 0;
  target.recoveredMinor += row.recoveredMinor;
  target.netMinor = target.estimatedLostMinor - target.recoveredMinor;
  target.events += 1;
  if (row.recoveredMinor > 0) target.recoveredEvents += 1;
}

/**
 * Owner dashboard totals: estimated lost value, recovered value and the net
 * still lost, overall and by branch, salt and distributor. A combination SKU
 * counts under each of its salts, so salt groups may overlap; branch and
 * distributor groups partition the events.
 */
export function summarizeLostSalesRecovery(rows: readonly LostSalesRecoveryRow[]) {
  const totals = emptyTotals();
  const byBranch = new Map<string, Group>();
  const bySalt = new Map<string, Group>();
  const byDistributor = new Map<string, Group>();
  const group = (map: Map<string, Group>, key: string, label: string) => {
    let entry = map.get(key);
    if (!entry) {
      entry = { key, label, ...emptyTotals() };
      map.set(key, entry);
    }
    return entry;
  };
  for (const row of rows) {
    add(totals, row);
    add(group(byBranch, row.branchId, row.branchName), row);
    const salts = row.salts.length ? [...new Set(row.salts)] : ['Unresolved salt'];
    for (const salt of salts) add(group(bySalt, salt, salt), row);
    const distributor = row.distributor ?? 'Unknown distributor';
    add(group(byDistributor, distributor, distributor), row);
  }
  const ranked = (map: Map<string, Group>) =>
    [...map.values()].sort(
      (a, b) =>
        b.netMinor - a.netMinor ||
        b.estimatedLostMinor - a.estimatedLostMinor ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
    );
  return {
    totals,
    byBranch: ranked(byBranch),
    bySalt: ranked(bySalt),
    byDistributor: ranked(byDistributor),
    missingEstimates: rows.filter((row) => row.estimatedLostMinor == null).length,
  };
}

/**
 * Runs the back-in-stock capture for each lot a goods receipt posted. Each lot
 * is captured on its own, after the receipt has committed, so a lot that cannot
 * notify (quarantined, nothing accepted) never undoes the receipt or blocks the
 * other lots. Returns the lots whose capture failed.
 */
export async function captureReceiptArrivals(
  inventoryLotIds: readonly string[],
  capture: (inventoryLotId: string) => Promise<unknown>,
  onError?: (inventoryLotId: string, error: unknown) => void
) {
  const failed: string[] = [];
  for (const inventoryLotId of new Set(inventoryLotIds)) {
    try {
      await capture(inventoryLotId);
    } catch (error) {
      failed.push(inventoryLotId);
      onError?.(inventoryLotId, error);
    }
  }
  return failed;
}
