/**
 * DEV-80 — lost-demand procurement advice.
 *
 * Pure decision logic only: it reads facts the caller loaded and returns advice.
 * Nothing here writes a document. The only actions an advice card offers are a
 * DRAFT purchase order, a DRAFT transfer request and Ignore; every draft still has
 * to be approved by a permitted human before any live action. Purchase orders use
 * the existing approval workflow. Transfer requests remain inert drafts; their
 * continuation is a separate owner decision. Nothing is sent from here.
 *
 * Every threshold and planning assumption is a per-branch configurable value. The
 * defaults below are starting points taken from the research brief, not facts.
 * Advice copy is in-app only and is built from computed values; it is never used as
 * WhatsApp text.
 */
import { z } from 'zod';

const DAY_MS = 86_400_000;
const INT_MAX = 2_147_483_647;

export const lostDemandTriggerConfigSchema = z
  .object({
    /** Requests for the same SKU or salt/strength within `requestWindowDays`. */
    requestCountThreshold: z.number().int().min(1).max(10_000),
    requestWindowDays: z.number().int().min(1).max(90),
    /** Recorded estimated lost value within `lossWindowDays`, in minor units. */
    estimatedLossThresholdMinor: z.number().int().min(1).max(INT_MAX),
    lossWindowDays: z.number().int().min(1).max(365),
    /** Branch walk-outs as a share of visits, in basis points (1000 = 10%). */
    walkOutRateThresholdBps: z.number().int().min(1).max(10_000),
    /** Sales history used for the daily demand rate. */
    forecastWindowDays: z.number().int().min(7).max(365),
    /** Safety stock expressed as days of forecast demand. */
    safetyStockDays: z.number().int().min(0).max(180),
    /** Used only when a distributor has no recorded lead time. */
    defaultLeadTimeDays: z.number().int().min(0).max(180),
  })
  .strict();

export type LostDemandTriggerConfig = z.infer<typeof lostDemandTriggerConfigSchema>;

/** Research-brief starting points (§9.5): configurable per branch, never hardcoded facts. */
export const DEFAULT_LOST_DEMAND_TRIGGERS: LostDemandTriggerConfig = Object.freeze({
  requestCountThreshold: 3,
  requestWindowDays: 7,
  estimatedLossThresholdMinor: 1_000_000,
  lossWindowDays: 30,
  walkOutRateThresholdBps: 1_000,
  forecastWindowDays: 30,
  safetyStockDays: 7,
  defaultLeadTimeDays: 3,
});

/** A stored row overrides defaults; anything invalid falls back to the defaults. */
export function resolveLostDemandTriggerConfig(
  stored: Partial<LostDemandTriggerConfig> | null | undefined
): LostDemandTriggerConfig {
  if (!stored) return { ...DEFAULT_LOST_DEMAND_TRIGGERS };
  const picked = Object.fromEntries(
    Object.keys(DEFAULT_LOST_DEMAND_TRIGGERS).map((key) => [
      key,
      stored[key as keyof LostDemandTriggerConfig] ??
        DEFAULT_LOST_DEMAND_TRIGGERS[key as keyof LostDemandTriggerConfig],
    ])
  );
  const parsed = lostDemandTriggerConfigSchema.safeParse(picked);
  return parsed.success ? parsed.data : { ...DEFAULT_LOST_DEMAND_TRIGGERS };
}

export type LostDemandEventFact = {
  id: string;
  visitId?: string | null;
  createdAt: Date;
  /** `sku:<medicineId>`, `salt:<strength key>` or `text:<normalized request>`. */
  demandKey: string;
  medicineId: string | null;
  label: string;
  /** Requested quantity in canonical units, or null when it cannot be converted. */
  canonicalUnits: number | null;
  /** Null is unknown, never zero. */
  estimatedValueMinor: number | null;
  /** The customer left without any sale. */
  walkOut: boolean;
};

export type LostDemandTrigger = 'REQUEST_COUNT' | 'ESTIMATED_LOSS' | 'WALK_OUT_RATE';

export type LostDemandTriggerResult = {
  demandKey: string;
  label: string;
  medicineIds: string[];
  requestCount: number;
  estimatedLossMinor: number;
  /** Events in the loss window whose value was not recorded. */
  unvaluedEvents: number;
  walkOuts: number;
  lostCanonicalUnits: number;
  latestEventAt: Date;
  fired: LostDemandTrigger[];
};

export type BranchVisitFacts = {
  /** Completed sales in the request window. */
  completedSales: number;
  /** Walk-outs (lost-demand events with no sale) in the request window. */
  walkOuts: number;
};

/** Walk-out rate in basis points; null when there were no visits to divide by. */
export function walkOutRateBps(visits: BranchVisitFacts): number | null {
  const total = visits.completedSales + visits.walkOuts;
  if (total <= 0) return null;
  return (visits.walkOuts * 10_000) / total;
}

/**
 * Evaluates the three configured triggers per demand group. The walk-out trigger
 * is a branch-level rate, so it fires only for groups that themselves had a
 * walk-out inside the request window.
 */
export function evaluateLostDemandTriggers(
  events: readonly LostDemandEventFact[],
  visits: BranchVisitFacts,
  config: LostDemandTriggerConfig,
  now: Date
): LostDemandTriggerResult[] {
  const requestFrom = now.getTime() - config.requestWindowDays * DAY_MS;
  const lossFrom = now.getTime() - config.lossWindowDays * DAY_MS;
  const branchRate = walkOutRateBps(visits);
  const groups = new Map<string, LostDemandTriggerResult>();
  const walkOutVisits = new Map<string, Set<string>>();
  for (const event of events) {
    const at = event.createdAt.getTime();
    if (at > now.getTime() || (at < requestFrom && at < lossFrom)) continue;
    const group = groups.get(event.demandKey) ?? {
      demandKey: event.demandKey,
      label: event.label,
      medicineIds: [],
      requestCount: 0,
      estimatedLossMinor: 0,
      unvaluedEvents: 0,
      walkOuts: 0,
      lostCanonicalUnits: 0,
      latestEventAt: event.createdAt,
      fired: [],
    };
    if (event.medicineId && !group.medicineIds.includes(event.medicineId))
      group.medicineIds.push(event.medicineId);
    if (at >= requestFrom) {
      group.requestCount += 1;
      if (event.walkOut) {
        const visits = walkOutVisits.get(event.demandKey) ?? new Set<string>();
        visits.add(event.visitId ?? event.id);
        walkOutVisits.set(event.demandKey, visits);
        group.walkOuts = visits.size;
      }
    }
    if (at >= lossFrom) {
      if (event.estimatedValueMinor === null) group.unvaluedEvents += 1;
      else group.estimatedLossMinor += event.estimatedValueMinor;
      group.lostCanonicalUnits += event.canonicalUnits ?? 0;
    }
    if (at > group.latestEventAt.getTime()) group.latestEventAt = event.createdAt;
    groups.set(event.demandKey, group);
  }
  const results: LostDemandTriggerResult[] = [];
  for (const group of groups.values()) {
    if (group.requestCount >= config.requestCountThreshold) group.fired.push('REQUEST_COUNT');
    if (group.estimatedLossMinor >= config.estimatedLossThresholdMinor)
      group.fired.push('ESTIMATED_LOSS');
    if (branchRate !== null && branchRate > config.walkOutRateThresholdBps && group.walkOuts > 0)
      group.fired.push('WALK_OUT_RATE');
    if (group.fired.length) results.push(group);
  }
  return results.sort(
    (a, b) =>
      b.estimatedLossMinor - a.estimatedLossMinor ||
      b.requestCount - a.requestCount ||
      a.demandKey.localeCompare(b.demandKey)
  );
}

export type BonusScheme = { buyPacks: number; bonusPacks: number };

export type SuggestedQuantityInput = {
  /** Forecast demand per day in canonical units (may be fractional). */
  dailyDemandUnits: number;
  leadTimeDays: number;
  safetyStockUnits: number;
  onHandUnits: number;
  onOrderUnits: number;
  canonicalUnitsPerPack: number;
  scheme?: BonusScheme | null;
};

export type SuggestedQuantity = {
  forecastLeadTimeUnits: number;
  /** forecast over lead time + safety stock - on-hand - on-order, floored at 0. */
  netRequiredUnits: number;
  /** Packs needed to cover the net requirement, rounded up to whole packs. */
  requiredPacks: number;
  /** Packs paid for, after rounding to the bonus scheme. */
  orderedPacks: number;
  bonusPacks: number;
  /** Units that arrive, paid plus bonus. */
  suppliedUnits: number;
};

function nonNegativeInt(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be >= 0.`);
}

/**
 * suggested qty = forecast over lead time + safety stock - on-hand - on-order,
 * rounded up to whole packs and then to the distributor's bonus scheme: the
 * fewest paid packs whose paid + bonus packs cover the requirement.
 */
export function suggestedOrderQuantity(input: SuggestedQuantityInput): SuggestedQuantity {
  if (!Number.isFinite(input.dailyDemandUnits) || input.dailyDemandUnits < 0)
    throw new RangeError('dailyDemandUnits must be >= 0.');
  nonNegativeInt(input.leadTimeDays, 'leadTimeDays');
  nonNegativeInt(input.safetyStockUnits, 'safetyStockUnits');
  nonNegativeInt(input.onHandUnits, 'onHandUnits');
  nonNegativeInt(input.onOrderUnits, 'onOrderUnits');
  if (!Number.isSafeInteger(input.canonicalUnitsPerPack) || input.canonicalUnitsPerPack <= 0)
    throw new RangeError('canonicalUnitsPerPack must be > 0.');
  const forecastLeadTimeUnits = Math.ceil(input.dailyDemandUnits * input.leadTimeDays);
  const netRequiredUnits = Math.max(
    0,
    forecastLeadTimeUnits + input.safetyStockUnits - input.onHandUnits - input.onOrderUnits
  );
  const requiredPacks = Math.ceil(netRequiredUnits / input.canonicalUnitsPerPack);
  let orderedPacks = requiredPacks;
  let bonusPacks = 0;
  const scheme = input.scheme;
  if (
    scheme &&
    requiredPacks > 0 &&
    Number.isSafeInteger(scheme.buyPacks) &&
    Number.isSafeInteger(scheme.bonusPacks) &&
    scheme.buyPacks > 0 &&
    scheme.bonusPacks > 0
  ) {
    const cycle = scheme.buyPacks + scheme.bonusPacks;
    const fullCycles = Math.floor(requiredPacks / cycle);
    const remainder = requiredPacks - fullCycles * cycle;
    // A partial cycle is paid in full up to `buyPacks`; past that it earns its bonus.
    orderedPacks = fullCycles * scheme.buyPacks + Math.min(remainder, scheme.buyPacks);
    bonusPacks = Math.floor(orderedPacks / scheme.buyPacks) * scheme.bonusPacks;
  }
  return {
    forecastLeadTimeUnits,
    netRequiredUnits,
    requiredPacks,
    orderedPacks,
    bonusPacks,
    suppliedUnits: (orderedPacks + bonusPacks) * input.canonicalUnitsPerPack,
  };
}

export type DistributorFact = {
  supplierId: string;
  supplierName: string;
  medicineId: string;
  packLevelId: string;
  canonicalUnitsPerPack: number;
  lastListPricePerPackMinor: number;
  lastDiscountBps: number;
  lastRebateBps?: number;
  lastTaxBps?: number;
  lastTaxCreditable?: boolean;
  lastOrderedAt: Date;
  scheme: BonusScheme | null;
  /** Null when no lead time was ever recorded for this distributor. */
  leadTimeDays: number | null;
};

export type DistributorOption = DistributorFact & {
  leadTimeSource: 'RECORDED' | 'CONFIGURED_DEFAULT';
  effectiveLeadTimeDays: number;
  quantity: SuggestedQuantity;
  /** Paid packs at the last list price after the last discount. */
  estimatedCostMinor: number;
};

export type AlternateFact = {
  medicineId: string;
  label: string;
  availableUnits: number;
  /** Last recorded margin per canonical unit; null when never sold. */
  marginPerUnitMinor: number | null;
};

export type BranchStockFact = {
  branchId: string;
  branchName: string;
  availableUnits: number;
  dailyDemandUnits: number;
};

export type TransferSuggestion = {
  fromBranchId: string;
  fromBranchName: string;
  surplusUnits: number;
  quantityUnits: number;
};

/**
 * A donor keeps its own lead-time demand plus safety stock; only what is above
 * that is surplus. The largest surplus wins, ties broken by branch id.
 */
export function suggestTransfer(
  donors: readonly BranchStockFact[],
  neededUnits: number,
  coverageDays: number
): TransferSuggestion | null {
  if (neededUnits <= 0) return null;
  let best: TransferSuggestion | null = null;
  for (const donor of donors) {
    const keep = Math.ceil(donor.dailyDemandUnits * coverageDays);
    const surplus = donor.availableUnits - keep;
    if (surplus <= 0) continue;
    if (
      !best ||
      surplus > best.surplusUnits ||
      (surplus === best.surplusUnits && donor.branchId < best.fromBranchId)
    ) {
      best = {
        fromBranchId: donor.branchId,
        fromBranchName: donor.branchName,
        surplusUnits: surplus,
        quantityUnits: Math.min(surplus, neededUnits),
      };
    }
  }
  return best;
}

export type LostDemandAdviceInput = {
  trigger: LostDemandTriggerResult;
  config: LostDemandTriggerConfig;
  medicineId: string | null;
  dailyDemandUnits: number;
  onHandUnits: number;
  onOrderUnits: number;
  distributors: readonly DistributorFact[];
  alternates: readonly AlternateFact[];
  donors: readonly BranchStockFact[];
  currency: string;
};

export type LostDemandAdviceAction = 'DRAFT_PURCHASE_ORDER' | 'TRANSFER_REQUEST' | 'IGNORE';

export type LostDemandAdvice = {
  demandKey: string;
  label: string;
  medicineId: string | null;
  trigger: LostDemandTriggerResult;
  dailyDemandUnits: number;
  safetyStockUnits: number;
  onHandUnits: number;
  onOrderUnits: number;
  distributors: DistributorOption[];
  alternates: AlternateFact[];
  transfer: TransferSuggestion | null;
  actions: LostDemandAdviceAction[];
  /** Every action produces a draft; approval and sending stay with a permitted human. */
  draftOnly: true;
  summary: string;
  limitations: string[];
};

function formatMoney(minor: number, currency: string) {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${currency} ${Math.floor(abs / 100).toLocaleString('en-US')}${
    abs % 100 ? `.${String(abs % 100).padStart(2, '0')}` : ''
  }`;
}

function costAfterDiscount(packs: number, pricePerPackMinor: number, discountBps: number) {
  return Math.round((packs * pricePerPackMinor * (10_000 - discountBps)) / 10_000);
}

export function buildLostDemandAdvice(input: LostDemandAdviceInput): LostDemandAdvice {
  const { trigger, config } = input;
  const safetyStockUnits = Math.ceil(input.dailyDemandUnits * config.safetyStockDays);
  const limitations: string[] = [];
  const distributors: DistributorOption[] = input.medicineId
    ? input.distributors
        .filter((row) => row.medicineId === input.medicineId)
        .map((row) => {
          const recorded = row.leadTimeDays !== null;
          const effectiveLeadTimeDays = row.leadTimeDays ?? config.defaultLeadTimeDays;
          const quantity = suggestedOrderQuantity({
            dailyDemandUnits: input.dailyDemandUnits,
            leadTimeDays: effectiveLeadTimeDays,
            safetyStockUnits,
            onHandUnits: input.onHandUnits,
            onOrderUnits: input.onOrderUnits,
            canonicalUnitsPerPack: row.canonicalUnitsPerPack,
            scheme: row.scheme,
          });
          return {
            ...row,
            leadTimeSource: recorded ? ('RECORDED' as const) : ('CONFIGURED_DEFAULT' as const),
            effectiveLeadTimeDays,
            quantity,
            estimatedCostMinor: costAfterDiscount(
              quantity.orderedPacks,
              row.lastListPricePerPackMinor,
              row.lastDiscountBps
            ),
          };
        })
        .sort(
          (a, b) =>
            a.estimatedCostMinor - b.estimatedCostMinor ||
            a.effectiveLeadTimeDays - b.effectiveLeadTimeDays ||
            a.supplierId.localeCompare(b.supplierId)
        )
    : [];
  if (!input.medicineId)
    limitations.push('The request does not match a catalogue item, so no order can be drafted.');
  else if (!distributors.length)
    limitations.push('No distributor has supplied this item yet, so no order can be drafted.');
  if (distributors.some((row) => row.leadTimeSource === 'CONFIGURED_DEFAULT'))
    limitations.push('Some lead times are the branch default, not a recorded delivery.');
  if (trigger.unvaluedEvents > 0)
    limitations.push(
      `${trigger.unvaluedEvents} lost request(s) have no recorded value; the loss shown excludes them.`
    );
  limitations.push('Forecast and suggested quantities are estimates from recorded sales.');
  limitations.push(
    'Distributor prices and schemes are historical estimates; confirm current terms before approval.'
  );

  const neededUnits = Math.max(
    0,
    Math.ceil(input.dailyDemandUnits * (config.defaultLeadTimeDays + config.safetyStockDays)) -
      input.onHandUnits -
      input.onOrderUnits,
    trigger.lostCanonicalUnits - input.onHandUnits - input.onOrderUnits
  );
  const transfer = input.medicineId
    ? suggestTransfer(
        input.donors,
        neededUnits,
        config.defaultLeadTimeDays + config.safetyStockDays
      )
    : null;
  if (transfer)
    limitations.push(
      'Transfer requests remain drafts. Allocation and approval of an existing request are not available yet.'
    );
  const actions: LostDemandAdviceAction[] = [];
  if (distributors.some((row) => row.quantity.orderedPacks > 0))
    actions.push('DRAFT_PURCHASE_ORDER');
  if (transfer) actions.push('TRANSFER_REQUEST');
  actions.push('IGNORE');

  const reasons = trigger.fired.map((fired) =>
    fired === 'REQUEST_COUNT'
      ? `${trigger.requestCount} requests in ${config.requestWindowDays} days`
      : fired === 'ESTIMATED_LOSS'
        ? `estimated ${formatMoney(trigger.estimatedLossMinor, input.currency)} lost in ${config.lossWindowDays} days`
        : `${trigger.walkOuts} walk-out(s) while branch walk-outs exceed ${config.walkOutRateThresholdBps / 100}% of visits`
  );
  const best = distributors.find((row) => row.quantity.orderedPacks > 0);
  const suggestion = best
    ? ` Suggested: ${best.quantity.orderedPacks} pack(s)${
        best.quantity.bonusPacks ? ` + ${best.quantity.bonusPacks} bonus` : ''
      } from ${best.supplierName}, about ${formatMoney(best.estimatedCostMinor, input.currency)}.`
    : '';
  const transferText = transfer
    ? ` ${transfer.fromBranchName} has ${transfer.surplusUnits} surplus unit(s).`
    : '';
  return {
    demandKey: trigger.demandKey,
    label: trigger.label,
    medicineId: input.medicineId,
    trigger,
    dailyDemandUnits: input.dailyDemandUnits,
    safetyStockUnits,
    onHandUnits: input.onHandUnits,
    onOrderUnits: input.onOrderUnits,
    distributors,
    alternates: [...input.alternates].sort(
      (a, b) =>
        (b.marginPerUnitMinor ?? Number.NEGATIVE_INFINITY) -
          (a.marginPerUnitMinor ?? Number.NEGATIVE_INFINITY) ||
        a.medicineId.localeCompare(b.medicineId)
    ),
    transfer,
    actions,
    draftOnly: true,
    summary: `${trigger.label}: ${reasons.join('; ')}. On hand ${input.onHandUnits}, on order ${input.onOrderUnits}.${suggestion}${transferText}`,
    limitations,
  };
}

/** Advice is hidden after Ignore until a newer lost request arrives. */
export function isAdviceSuppressed(
  trigger: Pick<LostDemandTriggerResult, 'latestEventAt'>,
  lastDecisionAt: Date | null | undefined
) {
  return !!lastDecisionAt && trigger.latestEventAt.getTime() <= lastDecisionAt.getTime();
}

export const LOST_DEMAND_DECISIONS = [
  'DRAFT_PURCHASE_ORDER',
  'TRANSFER_REQUEST',
  'IGNORED',
] as const;
export type LostDemandDecision = (typeof LOST_DEMAND_DECISIONS)[number];
