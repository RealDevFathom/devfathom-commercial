/** Lost-demand procurement advice. All writes stop at an inert DRAFT document. */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const MAX_QUANTITY = 2_147_483_647;

export type LostDemandTriggerConfig = {
  requestsInWindow: number;
  requestWindowDays: number;
  estimatedLossMinor: number;
  lossWindowDays: number;
  walkOutRateBps: number;
};
export const DEFAULT_LOST_DEMAND_TRIGGER_CONFIG: Readonly<LostDemandTriggerConfig> = {
  requestsInWindow: 3,
  requestWindowDays: 7,
  estimatedLossMinor: 1_000_000,
  lossWindowDays: 30,
  walkOutRateBps: 1_000,
};
export type LostDemandMetrics = {
  requests: number;
  estimatedLossMinor: number;
  walkOuts: number;
  visits: number;
};
export type LostDemandTrigger = 'REQUESTS' | 'ESTIMATED_LOSS' | 'WALK_OUT_RATE';
const safeNonNegative = (value: number, maximum = MAX_QUANTITY) =>
  Number.isSafeInteger(value) && value >= 0 && value <= maximum;

export function evaluateLostDemandTriggers(
  metrics: LostDemandMetrics,
  config: LostDemandTriggerConfig
): LostDemandTrigger[] {
  if (
    // Aggregates can exceed the Int limit of an individual event or stock quantity.
    !Object.values(metrics).every((value) => safeNonNegative(value, Number.MAX_SAFE_INTEGER)) ||
    !safeNonNegative(config.requestsInWindow) ||
    !safeNonNegative(config.estimatedLossMinor, Number.MAX_SAFE_INTEGER) ||
    !safeNonNegative(config.requestWindowDays) ||
    config.requestWindowDays === 0 ||
    !safeNonNegative(config.lossWindowDays) ||
    config.lossWindowDays === 0 ||
    !safeNonNegative(config.walkOutRateBps, 10_000) ||
    metrics.walkOuts > metrics.visits
  )
    throw new Error('INVALID_LOST_DEMAND_METRICS');
  const fired: LostDemandTrigger[] = [];
  if (metrics.requests >= config.requestsInWindow) fired.push('REQUESTS');
  if (metrics.estimatedLossMinor >= config.estimatedLossMinor) fired.push('ESTIMATED_LOSS');
  if (metrics.visits > 0 && (metrics.walkOuts / metrics.visits) * 10_000 > config.walkOutRateBps)
    fired.push('WALK_OUT_RATE');
  return fired;
}

export type LostDemandScope = 'SKU' | 'SALT';
/** One medicine's raw facts in each independently configured trailing window. */
export type LostDemandWindowFact = {
  medicineId: string;
  /** Stable salt/strength identity; null when the medicine has no strength components. */
  saltKey: string | null;
  requestsInRequestWindow: number;
  estimatedLossMinorInLossWindow: number;
};
export type LostDemandScopeAlert = {
  scope: LostDemandScope;
  key: string;
  medicineIds: string[];
  requests: number;
  /** Omitted without financial permission; the loss trigger is then never evaluated. */
  estimatedLossMinor?: number;
  fired: LostDemandTrigger[];
};

/**
 * Evaluates triggers per SKU and per salt/strength, never across unrelated items.
 * Request counts and loss sums arrive already restricted to their own windows.
 * Without financial permission the loss metric is excluded from evaluation and output,
 * so the alert cannot disclose whether a monetary threshold was crossed.
 */
export function evaluateLostDemandScopes(
  facts: readonly LostDemandWindowFact[],
  config: LostDemandTriggerConfig,
  options: { financial: boolean }
): LostDemandScopeAlert[] {
  const groups = new Map<string, Omit<LostDemandScopeAlert, 'fired'> & { loss: number }>();
  const add = (scope: LostDemandScope, key: string, fact: LostDemandWindowFact) => {
    const id = `${scope}:${key}`;
    const group = groups.get(id) ?? {
      scope,
      key,
      medicineIds: [],
      requests: 0,
      loss: 0,
    };
    group.medicineIds.push(fact.medicineId);
    group.requests += fact.requestsInRequestWindow;
    group.loss += fact.estimatedLossMinorInLossWindow;
    groups.set(id, group);
  };
  for (const fact of facts) {
    add('SKU', fact.medicineId, fact);
    if (fact.saltKey) add('SALT', fact.saltKey, fact);
  }
  const alerts: LostDemandScopeAlert[] = [];
  for (const { loss, ...group } of groups.values()) {
    const fired = evaluateLostDemandTriggers(
      {
        requests: group.requests,
        estimatedLossMinor: options.financial ? loss : 0,
        // No visit or walk-out capture exists yet; the walk-out trigger cannot be evaluated.
        walkOuts: 0,
        visits: 0,
      },
      options.financial ? config : { ...config, estimatedLossMinor: Number.MAX_SAFE_INTEGER }
    ).filter((trigger) => options.financial || trigger !== 'ESTIMATED_LOSS');
    // A salt alert made of a single SKU repeats that SKU alert.
    if (!fired.length || (group.scope === 'SALT' && group.medicineIds.length < 2)) continue;
    alerts.push({
      ...group,
      medicineIds: [...group.medicineIds].sort(),
      ...(options.financial ? { estimatedLossMinor: loss } : {}),
      fired,
    });
  }
  return alerts.sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
}

const DAY_MS = 86_400_000;

/** Reads trailing windows ending at `at` for one authorized branch. */
export async function loadLostDemandScopeAlerts(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  options: { financial: boolean; at?: Date; config?: LostDemandTriggerConfig }
) {
  const at = options.at ?? new Date();
  const config = options.config ?? DEFAULT_LOST_DEMAND_TRIGGER_CONFIG;
  const base = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    requestedMedicineId: { not: null },
  };
  const requestFrom = new Date(at.getTime() - config.requestWindowDays * DAY_MS);
  const lossFrom = new Date(at.getTime() - config.lossWindowDays * DAY_MS);
  const [requestRows, lossRows] = await Promise.all([
    db.unfulfilledDemandEvent.groupBy({
      by: ['requestedMedicineId'],
      where: { ...base, createdAt: { gte: requestFrom, lt: at } },
      _count: { _all: true },
    }),
    options.financial
      ? db.unfulfilledDemandEvent.groupBy({
          by: ['requestedMedicineId'],
          where: { ...base, createdAt: { gte: lossFrom, lt: at } },
          _sum: { estimatedValueMinor: true },
        })
      : Promise.resolve([]),
  ]);
  const facts = new Map<string, LostDemandWindowFact>();
  const fact = (medicineId: string) => {
    const row = facts.get(medicineId) ?? {
      medicineId,
      saltKey: null,
      requestsInRequestWindow: 0,
      estimatedLossMinorInLossWindow: 0,
    };
    facts.set(medicineId, row);
    return row;
  };
  for (const row of requestRows)
    if (row.requestedMedicineId)
      fact(row.requestedMedicineId).requestsInRequestWindow = row._count._all;
  for (const row of lossRows)
    if (row.requestedMedicineId)
      fact(row.requestedMedicineId).estimatedLossMinorInLossWindow =
        row._sum.estimatedValueMinor ?? 0;
  if (facts.size) {
    const components = await db.medicineStrengthComponent.findMany({
      where: { organizationId: scope.organizationId, medicineId: { in: [...facts.keys()] } },
      select: { medicineId: true, ingredientId: true, value: true, unit: true },
    });
    const byMedicine = new Map<string, string[]>();
    for (const row of components) {
      const parts = byMedicine.get(row.medicineId) ?? [];
      parts.push(`${row.ingredientId}@${row.value.toString()}${row.unit.trim().toLowerCase()}`);
      byMedicine.set(row.medicineId, parts);
    }
    for (const [medicineId, parts] of byMedicine) fact(medicineId).saltKey = parts.sort().join('+');
  }
  return {
    at,
    config,
    walkOutRateEvaluated: false as const,
    alerts: evaluateLostDemandScopes([...facts.values()], config, options),
  };
}

export type ReplenishmentTerms = {
  packUnits: number;
  schemeBuyPacks?: number;
  schemeFreePacks?: number;
};
export type ProcurementQuantity = {
  requiredUnits: number;
  orderedPacks: number;
  bonusPacks: number;
  suppliedUnits: number;
};
/** Bounded, logarithmic calculation; it never loops once per requested pack. */
export function suggestedProcurementQuantity(input: {
  forecastUnitsOverLeadTime: number;
  safetyStockUnits: number;
  onHandUnits: number;
  onOrderUnits: number;
  terms: ReplenishmentTerms;
}): ProcurementQuantity {
  const buy = input.terms.schemeBuyPacks ?? 0;
  const free = input.terms.schemeFreePacks ?? 0;
  const values = [
    input.forecastUnitsOverLeadTime,
    input.safetyStockUnits,
    input.onHandUnits,
    input.onOrderUnits,
    input.terms.packUnits,
    buy,
    free,
  ];
  if (values.some((value) => !safeNonNegative(value)) || input.terms.packUnits === 0)
    throw new Error('INVALID_LOST_DEMAND_QUANTITY');
  if ((buy === 0) !== (free === 0)) throw new Error('INCOMPLETE_BONUS_SCHEME');
  const gross = input.forecastUnitsOverLeadTime + input.safetyStockUnits;
  if (!Number.isSafeInteger(gross) || gross > MAX_QUANTITY)
    throw new Error('INVALID_LOST_DEMAND_QUANTITY');
  const requiredUnits = Math.max(0, gross - input.onHandUnits - input.onOrderUnits);
  const supplies = (packs: number) =>
    (packs + (buy ? Math.floor(packs / buy) * free : 0)) * input.terms.packUnits;
  let low = 0;
  let high = Math.ceil(requiredUnits / input.terms.packUnits);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (supplies(middle) >= requiredUnits) high = middle;
    else low = middle + 1;
  }
  const orderedPacks = low;
  const bonusPacks = buy ? Math.floor(orderedPacks / buy) * free : 0;
  const suppliedUnits = supplies(orderedPacks);
  if (![orderedPacks, bonusPacks, suppliedUnits].every((value) => safeNonNegative(value)))
    throw new Error('INVALID_LOST_DEMAND_QUANTITY');
  return { requiredUnits, orderedPacks, bonusPacks, suppliedUnits };
}

export type DistributorAdvice = {
  supplierId: string;
  lastPricePerPackMinor: number | null;
  scheme: { buyPacks: number; freePacks: number } | null;
  leadTimeDays: number | null;
};
export type AlternateAdvice = { medicineId: string; sameSaltAndStrength: true; marginBps: number };
export type TransferAdvice = { fromBranchId: string; surplusUnits: number };
export type LostDemandAdvice = {
  id: string;
  organizationId: string;
  branchId: string;
  medicineId: string;
  fired: LostDemandTrigger[];
  metrics: LostDemandMetrics;
  quantity: ProcurementQuantity;
  distributors: DistributorAdvice[];
  alternates: AlternateAdvice[];
  transfers: TransferAdvice[];
};
export type LostDemandAction = 'DRAFT_PO' | 'DRAFT_TRANSFER' | 'IGNORE';
export type TrustedProcurementActor = { organizationId: string; userId: string };

/** Session capability (including the solo-owner wildcard), PIN, tenant, and transaction boundary. */
export type LostDemandActionBoundary = {
  authenticate(input: { pin: string; action: LostDemandAction }): Promise<TrustedProcurementActor>;
  transaction<T>(work: (writer: LostDemandTransaction) => Promise<T>): Promise<T>;
};
export type LostDemandTransaction = {
  /** Reloads and atomically revalidates current stock, inbound supply, supplier eligibility and surplus. */
  loadCurrentAdvice(input: {
    adviceId: string;
    organizationId: string;
    userId: string;
  }): Promise<LostDemandAdvice | null>;
  createPurchaseOrderDraft(input: {
    organizationId: string;
    branchId: string;
    medicineId: string;
    supplierId: string;
    orderedPacks: number;
    bonusPacks: number;
    createdByUserId: string;
    status: 'DRAFT';
  }): Promise<{ id: string; status: 'DRAFT' }>;
  createTransferDraft(input: {
    organizationId: string;
    fromBranchId: string;
    toBranchId: string;
    medicineId: string;
    quantityUnits: number;
    createdByUserId: string;
    status: 'DRAFT';
  }): Promise<{ id: string; status: 'DRAFT' }>;
  appendAudit(input: {
    organizationId: string;
    adviceId: string;
    actorId: string;
    action: LostDemandAction;
    draftId?: string;
  }): Promise<void>;
};

/** No actor, tenant, permission boolean, or advice payload is accepted from the browser. */
export async function actOnLostDemandAdvice(input: {
  action: LostDemandAction;
  adviceId: string;
  pin: string;
  supplierId?: string;
  fromBranchId?: string;
  boundary: LostDemandActionBoundary;
}) {
  if (!['DRAFT_PO', 'DRAFT_TRANSFER', 'IGNORE'].includes(input.action))
    throw new Error('INVALID_LOST_DEMAND_ACTION');
  const actor = await input.boundary.authenticate({ pin: input.pin, action: input.action });
  return input.boundary.transaction(async (writer) => {
    const advice = await writer.loadCurrentAdvice({
      adviceId: input.adviceId,
      organizationId: actor.organizationId,
      userId: actor.userId,
    });
    if (!advice || advice.id !== input.adviceId || advice.organizationId !== actor.organizationId)
      throw new Error('LOST_DEMAND_ADVICE_NOT_AVAILABLE');
    let result: { id: string; status: 'DRAFT' } | { status: 'IGNORED' };
    if (input.action === 'IGNORE') result = { status: 'IGNORED' };
    else if (input.action === 'DRAFT_PO') {
      if (advice.quantity.orderedPacks <= 0) throw new Error('NO_REPLENISHMENT_REQUIRED');
      const distributor = advice.distributors.find((row) => row.supplierId === input.supplierId);
      if (!distributor) throw new Error('SUPPLIER_NOT_ELIGIBLE');
      result = await writer.createPurchaseOrderDraft({
        organizationId: actor.organizationId,
        branchId: advice.branchId,
        medicineId: advice.medicineId,
        supplierId: distributor.supplierId,
        orderedPacks: advice.quantity.orderedPacks,
        bonusPacks: advice.quantity.bonusPacks,
        createdByUserId: actor.userId,
        status: 'DRAFT',
      });
    } else {
      const transfer = advice.transfers.find((row) => row.fromBranchId === input.fromBranchId);
      const quantityUnits = Math.min(transfer?.surplusUnits ?? 0, advice.quantity.requiredUnits);
      if (quantityUnits <= 0) throw new Error('SURPLUS_TRANSFER_REQUIRED');
      result = await writer.createTransferDraft({
        organizationId: actor.organizationId,
        fromBranchId: transfer!.fromBranchId,
        toBranchId: advice.branchId,
        medicineId: advice.medicineId,
        quantityUnits,
        createdByUserId: actor.userId,
        status: 'DRAFT',
      });
    }
    await writer.appendAudit({
      organizationId: actor.organizationId,
      adviceId: advice.id,
      actorId: actor.userId,
      action: input.action,
      ...('id' in result ? { draftId: result.id } : {}),
    });
    return result;
  });
}

export function lostDemandWhatsAppText(
  advice: Pick<LostDemandAdvice, 'metrics' | 'fired'>
): string {
  return `Procurement review available: ${advice.metrics.requests} customer requests and PKR ${(advice.metrics.estimatedLossMinor / 100).toFixed(2)} estimated demand. Open the app to review a draft; nothing has been sent.`;
}
