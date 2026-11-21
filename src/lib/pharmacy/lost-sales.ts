/**
 * DEV-81 (#735): lost-sales capture.
 *
 * A short or out-of-stock line at the counter is an UnfulfilledDemandEvent.
 * This module groups those lines into visits, records what the customer did
 * (the counter outcome chip), and estimates the PKR lost:
 *
 *   loss = quantity × server-side unit price × p(outcome)
 *
 * p(outcome): substitute taken 0, ordered for customer 0, will return 0 that
 * becomes 1 when no matching sale follows within 7 days, went elsewhere 1,
 * unknown on a walk-out 1, unknown on a partial visit the branch's configured
 * default (0.43, a grocery-study estimate) until the branch has enough known
 * outcomes to use its own measured rate. A walk-out also loses the in-stock
 * lines the customer left behind.
 *
 * Everything here runs on the server; the counter only sends what it saw.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { priceFromLot } from './medicine';
import type { LedgerScope } from './stock-ledger';

export const MAX_COUNTER_DEMAND_QUANTITY = 10_000;

export const LOST_SALE_OUTCOMES = [
  'SUBSTITUTE_TAKEN',
  'WILL_RETURN',
  'WENT_ELSEWHERE',
  'ORDERED_FOR_CUSTOMER',
  'UNKNOWN',
] as const;
export type LostSaleOutcome = (typeof LOST_SALE_OUTCOMES)[number];
export type LostSaleVisitType = 'PARTIAL' | 'WALK_OUT';

/**
 * Fallbacks when a branch row does not carry its own values. The unknown-loss
 * probability is an estimate from grocery research, never a pharmacy fact;
 * branches override it in `pharmacy_branches.lostSalesUnknownLossProbability`.
 */
export const LOST_SALES_DEFAULTS = {
  unknownLossProbability: 0.43,
  measuredRateMinEvents: 200,
  visitWindowMs: 10 * 60 * 1000,
  willReturnWindowMs: 7 * 24 * 60 * 60 * 1000,
  /** The counter chip panel defaults to UNKNOWN after this long. */
  chipAutoDismissMs: 5000,
} as const;

export class LostSalesError extends Error {
  constructor(readonly reason: 'NOT_FOUND' | 'CONSENT_REQUIRED' | 'INVALID_SETTINGS') {
    super(reason);
  }
}

type VisitLine = {
  id: string;
  terminalKey: string;
  customerId: string | null;
  createdAt: Date;
};

/** Same terminal, same customer (or both anonymous), within the visit window. */
export function isSameVisit(
  previous: Pick<VisitLine, 'terminalKey' | 'customerId' | 'createdAt'>,
  next: Pick<VisitLine, 'terminalKey' | 'customerId' | 'createdAt'>,
  windowMs: number = LOST_SALES_DEFAULTS.visitWindowMs
): boolean {
  const gap = next.createdAt.getTime() - previous.createdAt.getTime();
  return (
    previous.terminalKey === next.terminalKey &&
    (previous.customerId ?? null) === (next.customerId ?? null) &&
    gap >= 0 &&
    gap <= windowMs
  );
}

/**
 * Groups lines into visits. A line joins the latest visit of its terminal and
 * customer when it falls within the window of that visit's previous line.
 * Returns line id → visit key (the id of the visit's first line).
 */
export function groupVisits(
  lines: readonly VisitLine[],
  windowMs: number = LOST_SALES_DEFAULTS.visitWindowMs
): Map<string, string> {
  const sorted = [...lines].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const open = new Map<string, { visitId: string; last: VisitLine }>();
  const result = new Map<string, string>();
  for (const line of sorted) {
    const key = `${line.terminalKey}\u0000${line.customerId ?? ''}`;
    const current = open.get(key);
    const visitId =
      current && isSameVisit(current.last, line, windowMs) ? current.visitId : line.id;
    open.set(key, { visitId, last: line });
    result.set(line.id, visitId);
  }
  return result;
}

/** A visit that sold at least one line is partial; one that sold nothing is a walk-out. */
export function classifyVisitType(input: { soldLineCount: number }): LostSaleVisitType {
  return input.soldLineCount > 0 ? 'PARTIAL' : 'WALK_OUT';
}

/**
 * The UNKNOWN-outcome probability for a branch: its configured default until
 * `minEvents` known outcomes exist, then its own measured loss rate.
 */
export function unknownLossProbability(input: {
  configured: number;
  minEvents: number;
  knownOutcomeEvents: number;
  lostKnownOutcomeEvents: number;
}): { probability: number; source: 'CONFIGURED_DEFAULT' | 'BRANCH_MEASURED' } {
  if (input.knownOutcomeEvents >= input.minEvents && input.knownOutcomeEvents > 0) {
    return {
      probability: clampProbability(input.lostKnownOutcomeEvents / input.knownOutcomeEvents),
      source: 'BRANCH_MEASURED',
    };
  }
  return { probability: clampProbability(input.configured), source: 'CONFIGURED_DEFAULT' };
}

export function lossProbability(input: {
  outcome: LostSaleOutcome;
  visitType: LostSaleVisitType | null;
  createdAt: Date;
  now: Date;
  /** When a matching later sale was found for a WILL_RETURN line. */
  matchedSaleAt?: Date | null;
  unknownProbability: number;
  willReturnWindowMs?: number;
}): number {
  switch (input.outcome) {
    case 'SUBSTITUTE_TAKEN':
    case 'ORDERED_FOR_CUSTOMER':
      return 0;
    case 'WENT_ELSEWHERE':
      return 1;
    case 'WILL_RETURN': {
      const windowMs = input.willReturnWindowMs ?? LOST_SALES_DEFAULTS.willReturnWindowMs;
      const deadline = input.createdAt.getTime() + windowMs;
      if (input.matchedSaleAt && input.matchedSaleAt.getTime() <= deadline) return 0;
      return input.now.getTime() >= deadline ? 1 : 0;
    }
    case 'UNKNOWN':
      return input.visitType === 'WALK_OUT' ? 1 : clampProbability(input.unknownProbability);
  }
}

/** PKR minor units, rounded half up; null when the server could not price the line. */
export function estimateLossMinor(input: {
  quantity: number;
  unitPriceMinor: number | null;
  probability: number;
}): number | null {
  if (input.unitPriceMinor === null) return null;
  return Math.round(input.quantity * input.unitPriceMinor * input.probability);
}

/** A visit's loss: its lines' estimates plus, on a walk-out, the in-stock lines left behind. */
export function visitLossMinor(input: {
  visitType: LostSaleVisitType | null;
  lineLossesMinor: readonly (number | null)[];
  leftBehindInStockMinor: number;
}): number {
  const lines = input.lineLossesMinor.reduce<number>((sum, loss) => sum + (loss ?? 0), 0);
  return lines + (input.visitType === 'WALK_OUT' ? input.leftBehindInStockMinor : 0);
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
}

const KNOWN_FINAL = ['SUBSTITUTE_TAKEN', 'ORDERED_FOR_CUSTOMER', 'WENT_ELSEWHERE'] as const;

type BranchScope = Pick<LedgerScope, 'organizationId' | 'branchId'>;

/** The branch's current UNKNOWN probability, from its settings and known outcomes. */
export async function branchUnknownLossProbability(db: ScopedDb, scope: BranchScope, now: Date) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId },
    select: { lostSalesUnknownLossProbability: true, lostSalesMeasuredRateMinEvents: true },
  });
  const willReturnSettled = new Date(now.getTime() - LOST_SALES_DEFAULTS.willReturnWindowMs);
  const base = { organizationId: scope.organizationId, branchId: scope.branchId };
  const [finalKnown, settledWillReturn, wentElsewhere, unreturned] = await Promise.all([
    db.unfulfilledDemandEvent.count({ where: { ...base, outcome: { in: [...KNOWN_FINAL] } } }),
    db.unfulfilledDemandEvent.count({
      where: {
        ...base,
        outcome: 'WILL_RETURN',
        OR: [{ resolvedAt: { not: null } }, { createdAt: { lte: willReturnSettled } }],
      },
    }),
    db.unfulfilledDemandEvent.count({ where: { ...base, outcome: 'WENT_ELSEWHERE' } }),
    db.unfulfilledDemandEvent.count({
      where: {
        ...base,
        outcome: 'WILL_RETURN',
        resolvedAt: null,
        createdAt: { lte: willReturnSettled },
      },
    }),
  ]);
  return unknownLossProbability({
    configured:
      branch?.lostSalesUnknownLossProbability === undefined
        ? LOST_SALES_DEFAULTS.unknownLossProbability
        : Number(branch.lostSalesUnknownLossProbability),
    minEvents: branch?.lostSalesMeasuredRateMinEvents ?? LOST_SALES_DEFAULTS.measuredRateMinEvents,
    knownOutcomeEvents: finalKnown + settledWillReturn,
    lostKnownOutcomeEvents: wentElsewhere + unreturned,
  });
}

/**
 * The branch's current price for one sale unit of a medicine, from its most
 * recently received lot. Never trusts a client figure. STRIP has no frozen
 * size on the lot, so it is left unpriced rather than guessed.
 */
export async function serverUnitPriceMinor(
  db: ScopedDb,
  scope: BranchScope,
  medicineId: string | undefined,
  saleUnit: 'PACK' | 'STRIP' | 'UNIT'
): Promise<number | null> {
  if (!medicineId || saleUnit === 'STRIP') return null;
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      packLevel: { presentation: { medicineId } },
    },
    orderBy: { createdAt: 'desc' },
    select: { printedMrpMinor: true, unitsPerPack: true },
  });
  if (!lot || lot.unitsPerPack <= 0 || lot.printedMrpMinor <= 0) return null;
  if (saleUnit === 'PACK') return lot.printedMrpMinor;
  try {
    return priceFromLot({
      printedMrpMinor: lot.printedMrpMinor,
      canonicalUnitsInPack: lot.unitsPerPack,
      canonicalUnitsPerSaleUnit: 1,
    }).unitPriceMinor;
  } catch {
    return null;
  }
}

/**
 * Finds the visit a new line belongs to (same terminal and customer within the
 * window) and its provisional type: partial when the line's sale already has a
 * sold line, otherwise walk-out. A partial line upgrades earlier walk-out lines
 * of the same visit.
 */
export async function resolveVisit(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    terminalId?: string;
    customerId?: string;
    saleId?: string;
    now: Date;
    newId: () => string;
  }
): Promise<{ visitId: string; visitType: LostSaleVisitType }> {
  const since = new Date(input.now.getTime() - LOST_SALES_DEFAULTS.visitWindowMs);
  const previous = await db.unfulfilledDemandEvent.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      visitId: { not: null },
      createdAt: { gte: since, lte: input.now },
      customerId: input.customerId ?? null,
      ...(input.terminalId
        ? { terminalId: input.terminalId }
        : { terminalId: null, capturedByUserId: scope.actorId }),
    },
    orderBy: { createdAt: 'desc' },
    select: { visitId: true, visitType: true, saleId: true },
  });
  const saleId = input.saleId ?? previous?.saleId ?? undefined;
  const soldLineCount = saleId
    ? await db.pharmacySaleLine.count({
        where: { organizationId: scope.organizationId, branchId: scope.branchId, saleId },
      })
    : 0;
  let visitType = classifyVisitType({ soldLineCount });
  if (previous?.visitType === 'PARTIAL') visitType = 'PARTIAL';
  const visitId = previous?.visitId ?? input.newId();
  if (previous && visitType === 'PARTIAL' && previous.visitType !== 'PARTIAL') {
    await db.unfulfilledDemandEvent.updateMany({
      where: { organizationId: scope.organizationId, branchId: scope.branchId, visitId },
      data: { visitType: 'PARTIAL' },
    });
  }
  return { visitId, visitType };
}

const PHONE = /^\+?\d{10,15}$/;

/** Validates the optional notify-when-back capture: a phone needs an explicit opt-in. */
export function notifyCapture(input: { notifyOptIn?: boolean; notifyPhone?: string }): {
  notifyOptIn: boolean;
  notifyPhone: string | null;
} {
  const phone = input.notifyPhone?.replace(/[\s-]/g, '') || null;
  if (phone && !input.notifyOptIn) throw new LostSalesError('CONSENT_REQUIRED');
  if (phone && !PHONE.test(phone)) throw new LostSalesError('CONSENT_REQUIRED');
  return { notifyOptIn: Boolean(input.notifyOptIn), notifyPhone: phone };
}

/**
 * What a chip tap returns. DEV-817: the router redacts the phone to a
 * has-contact flag before it leaves the server.
 */
const DEMAND_OUTCOME_RESULT = {
  id: true,
  outcome: true,
  substituteProductId: true,
  notifyOptIn: true,
  notifyPhone: true,
  lossProbability: true,
  estLossPkrMinor: true,
} as const;

/** One tap on a counter outcome chip. Recomputes the loss on the server. */
export async function setDemandOutcome(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    demandId: string;
    outcome: LostSaleOutcome;
    substituteProductId?: string;
    notifyOptIn?: boolean;
    notifyPhone?: string;
    freeText?: string;
  },
  now: Date = new Date()
) {
  const demand = await db.unfulfilledDemandEvent.findFirst({
    where: { id: input.demandId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: {
      id: true,
      quantity: true,
      unitPricePkrMinor: true,
      visitType: true,
      createdAt: true,
      notifyOptIn: true,
      notifyPhone: true,
    },
  });
  if (!demand) throw new LostSalesError('NOT_FOUND');
  const notify =
    input.notifyOptIn === undefined && input.notifyPhone === undefined
      ? { notifyOptIn: demand.notifyOptIn, notifyPhone: demand.notifyPhone }
      : notifyCapture(input);
  const unknown =
    input.outcome === 'UNKNOWN' && demand.visitType !== 'WALK_OUT'
      ? (await branchUnknownLossProbability(db, scope, now)).probability
      : 0;
  const probability = lossProbability({
    outcome: input.outcome,
    visitType: demand.visitType,
    createdAt: demand.createdAt,
    now,
    unknownProbability: unknown,
  });
  return db.unfulfilledDemandEvent.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: demand.id } },
    data: {
      outcome: input.outcome,
      substituteProductId:
        input.outcome === 'SUBSTITUTE_TAKEN' ? (input.substituteProductId ?? null) : null,
      ...notify,
      ...(input.freeText !== undefined ? { freeText: input.freeText.trim() || null } : {}),
      lossProbability: probability,
      estLossPkrMinor: estimateLossMinor({
        quantity: demand.quantity,
        unitPriceMinor: demand.unitPricePkrMinor,
        probability,
      }),
    },
    select: DEMAND_OUTCOME_RESULT,
  });
}

/** The look-back the settlement pass re-evaluates; older rows are final. */
const SETTLE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const SETTLE_BATCH = 500;

/**
 * Re-evaluates open lines: confirms visit type from the sale's final status,
 * flips WILL_RETURN to lost after 7 days without a matching sale (or resolves
 * it to the sale that came back), and refreshes UNKNOWN lines to the branch's
 * current probability. Idempotent.
 */
export async function settleLostSales(db: ScopedDb, scope: LedgerScope, now: Date = new Date()) {
  const unknown = (await branchUnknownLossProbability(db, scope, now)).probability;
  let evaluated = 0;
  let updated = 0;
  let cursor: string | undefined;
  // Walk every eligible row in stable (createdAt, id) order, one batch at a
  // time, so rows that stay eligible after evaluation never starve newer ones.
  for (;;) {
    const events = await settleBatch(db, scope, now, cursor);
    for (const event of events) {
      if (await settleEvent(db, scope, event, now, unknown)) updated += 1;
    }
    evaluated += events.length;
    if (events.length < SETTLE_BATCH) break;
    cursor = events[events.length - 1]!.id;
  }
  return { evaluated, updated, unknownProbability: unknown };
}

/**
 * Every visit line in the look-back is eligible: final outcomes keep their
 * fixed probability but still have their visit type reconciled against the
 * bill's final status (a voided bill makes the visit a walk-out).
 */
function settleBatch(db: ScopedDb, scope: LedgerScope, now: Date, cursor: string | undefined) {
  return db.unfulfilledDemandEvent.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      visitId: { not: null },
      resolvedAt: null,
      createdAt: { gte: new Date(now.getTime() - SETTLE_LOOKBACK_MS) },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: SETTLE_BATCH,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      saleId: true,
      visitType: true,
      outcome: true,
      quantity: true,
      unitPricePkrMinor: true,
      lossProbability: true,
      estLossPkrMinor: true,
      requestedMedicineId: true,
      customerId: true,
      createdAt: true,
      sale: { select: { status: true, createdAt: true } },
    },
  });
}

type SettleEvent = Awaited<ReturnType<typeof settleBatch>>[number];

async function settleEvent(
  db: ScopedDb,
  scope: LedgerScope,
  event: SettleEvent,
  now: Date,
  unknown: number
): Promise<boolean> {
  let visitType = event.visitType;
  if (event.sale?.status === 'COMPLETED') visitType = 'PARTIAL';
  else if (
    event.sale?.status === 'VOID' ||
    (event.sale?.status === 'OPEN' &&
      now.getTime() - event.sale.createdAt.getTime() > LOST_SALES_DEFAULTS.visitWindowMs)
  )
    visitType = 'WALK_OUT';

  let matched: { saleId: string; completedAt: Date } | null = null;
  // Only an identified customer can be matched to a returning sale; another
  // shopper buying the same medicine must not resolve an anonymous line.
  if (event.outcome === 'WILL_RETURN' && event.requestedMedicineId && event.customerId) {
    const deadline = new Date(event.createdAt.getTime() + LOST_SALES_DEFAULTS.willReturnWindowMs);
    const line = await db.pharmacySaleLine.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        medicineId: event.requestedMedicineId,
        ...(event.saleId ? { saleId: { not: event.saleId } } : {}),
        sale: {
          status: 'COMPLETED',
          completedAt: { gt: event.createdAt, lte: deadline },
          customer: { patientId: event.customerId },
        },
      },
      orderBy: { createdAt: 'asc' },
      select: { saleId: true, sale: { select: { completedAt: true } } },
    });
    if (line?.sale.completedAt)
      matched = { saleId: line.saleId, completedAt: line.sale.completedAt };
  }

  const probability = lossProbability({
    outcome: event.outcome,
    visitType,
    createdAt: event.createdAt,
    now,
    matchedSaleAt: matched?.completedAt ?? null,
    unknownProbability: unknown,
  });
  const estLossPkrMinor = estimateLossMinor({
    quantity: event.quantity,
    unitPriceMinor: event.unitPricePkrMinor,
    probability,
  });
  const changed =
    visitType !== event.visitType ||
    matched !== null ||
    event.lossProbability === null ||
    Number(event.lossProbability) !== probability ||
    event.estLossPkrMinor !== estLossPkrMinor;
  if (!changed) return false;
  await db.unfulfilledDemandEvent.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: event.id } },
    data: {
      visitType,
      lossProbability: probability,
      estLossPkrMinor,
      ...(matched ? { resolvedAt: matched.completedAt, resolvedBySaleId: matched.saleId } : {}),
    },
  });
  return true;
}

/** Lost-sales estimate for a window, by visit, including left-behind walk-out lines. */
export async function lostSalesSummary(db: ScopedDb, scope: BranchScope, from: Date, to: Date) {
  const events = await db.unfulfilledDemandEvent.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      visitId: { not: null },
      createdAt: { gte: from, lt: to },
    },
    select: { visitId: true, visitType: true, outcome: true, saleId: true, estLossPkrMinor: true },
  });
  const visits = new Map<
    string,
    { visitType: LostSaleVisitType | null; losses: (number | null)[]; saleIds: Set<string> }
  >();
  const byOutcome = Object.fromEntries(LOST_SALE_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    LostSaleOutcome,
    number
  >;
  for (const event of events) {
    byOutcome[event.outcome] += 1;
    const visit = visits.get(event.visitId!) ?? {
      visitType: event.visitType,
      losses: [],
      saleIds: new Set<string>(),
    };
    if (event.visitType === 'WALK_OUT') visit.visitType = 'WALK_OUT';
    else if (event.visitType === 'PARTIAL' && visit.visitType !== 'WALK_OUT')
      visit.visitType = 'PARTIAL';
    visit.losses.push(event.estLossPkrMinor);
    if (event.saleId) visit.saleIds.add(event.saleId);
    visits.set(event.visitId!, visit);
  }
  const walkOutSaleIds = [...visits.values()]
    .filter((visit) => visit.visitType === 'WALK_OUT')
    .flatMap((visit) => [...visit.saleIds]);
  const leftBehind = walkOutSaleIds.length
    ? await db.pharmacySaleLine.groupBy({
        by: ['saleId'],
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          saleId: { in: walkOutSaleIds },
          sale: { status: { not: 'COMPLETED' } },
        },
        _sum: { grossMinor: true },
      })
    : [];
  const leftBehindBySale = new Map(leftBehind.map((row) => [row.saleId, row._sum.grossMinor ?? 0]));
  let estLossPkrMinor = 0;
  let walkOuts = 0;
  for (const visit of visits.values()) {
    if (visit.visitType === 'WALK_OUT') walkOuts += 1;
    estLossPkrMinor += visitLossMinor({
      visitType: visit.visitType,
      lineLossesMinor: visit.losses,
      leftBehindInStockMinor: [...visit.saleIds].reduce(
        (sum, saleId) => sum + (leftBehindBySale.get(saleId) ?? 0),
        0
      ),
    });
  }
  return {
    label: 'Estimate',
    method: 'Counter lines grouped into visits; loss = quantity × branch price × p(outcome)',
    window: { from, to },
    visits: visits.size,
    walkOuts,
    partialVisits: visits.size - walkOuts,
    byOutcome,
    estLossPkrMinor,
  };
}

/** Owner/manager tuning of the branch's estimate parameters. */
export async function updateLostSalesSettings(
  db: ScopedDb,
  scope: BranchScope,
  input: { unknownLossProbability?: number; measuredRateMinEvents?: number }
) {
  if (
    (input.unknownLossProbability !== undefined &&
      !(input.unknownLossProbability >= 0 && input.unknownLossProbability <= 1)) ||
    (input.measuredRateMinEvents !== undefined &&
      !(Number.isSafeInteger(input.measuredRateMinEvents) && input.measuredRateMinEvents >= 1))
  )
    throw new LostSalesError('INVALID_SETTINGS');
  const result = await db.pharmacyBranch.updateMany({
    where: { id: scope.branchId, organizationId: scope.organizationId },
    data: {
      ...(input.unknownLossProbability !== undefined
        ? { lostSalesUnknownLossProbability: input.unknownLossProbability }
        : {}),
      ...(input.measuredRateMinEvents !== undefined
        ? { lostSalesMeasuredRateMinEvents: input.measuredRateMinEvents }
        : {}),
    },
  });
  if (result.count !== 1) throw new LostSalesError('NOT_FOUND');
  return { branchId: scope.branchId, ...input };
}
