/**
 * PUR-09 / DEM-02 — explainable replenishment estimates.
 *
 * This module is deliberately pure and can only emit inert drafts. PUR-07's
 * deterministic result remains the source of truth unless an organization
 * explicitly enables forecasting; even then, an approver is required before a
 * requisition may advance. Nothing here can create a purchase order or move stock.
 */

import {
  demandDateMs,
  demandInstantMs,
  forecastDemandEvidence,
  safeDemandTotal,
  type DemandEvidenceInput,
  type DemandForecast,
  type DemandSource,
} from './demand-evidence';
import { blockReasonFor, planAllocation, type AllocationCandidate } from './inventory';
import {
  learnCalendarUplift,
  type SaltSalesDay,
  type SeasonalCalendarWindow,
  type SeasonalLearningConfig,
} from './seasonal-forecasting';

export * from './seasonal-forecasting';

export { forecastDemandEvidence, backtestDemandEvidence } from './demand-evidence';
export type {
  DemandScope,
  DemandSource,
  DemandEvidenceDay,
  DemandMethod,
  DemandEvidenceInput,
  DemandForecastDay,
  DemandForecast,
  DemandBacktestInput,
  DemandBacktestMetrics,
  DemandBacktest,
} from './demand-evidence';

const BPS = 10_000;

export type ForecastSetting = { organizationId: string; enabled: boolean };

export function forecastSettingForOrganization(
  organizationId: string,
  enabled = false
): ForecastSetting {
  return { organizationId, enabled };
}

export type SupplierEstimate = {
  supplierId: string;
  unitCostMinor: number;
  leadTimeDays: number;
  fillRateBps: number;
};

export type BranchStockEstimate = {
  branchId: string;
  availableUnits: number;
  forecastDemandUnits: number;
  safetyStockUnits: number;
};

export type ForecastFixtureLine = {
  medicineId: string;
  demandUnits: number;
  demandWindowDays: number;
  /** @deprecated Supply seasonalContext so uplift is learned from branch-local history. */
  seasonalityBps?: number;
  seasonalContext?: {
    branchId: string;
    saltId: string;
    forecastDate: string;
    calendar: readonly SeasonalCalendarWindow[];
    history: readonly SaltSalesDay[];
    config?: SeasonalLearningConfig;
  };
  leadTimeDays: number;
  fillRateBps: number;
  openPurchaseOrderUnits: number;
  openTransferUnits: number;
  onHandUnits: number;
  expiringBeforeLeadTimeUnits: number;
  packSize: number;
  cashLimitUnits: number;
  storageLimitUnits: number;
  unfulfilledDemandUnits: number;
  deterministicSafetyStockUnits: number;
  suppliers: readonly SupplierEstimate[];
  branches: readonly BranchStockEstimate[];
};

export type EstimateDisclosure = {
  label: 'ESTIMATE';
  method: string;
  windowDays: number;
  exclusions: readonly string[];
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
};

export type ForecastReason = {
  input:
    | 'DEMAND_VELOCITY'
    | 'SEASONALITY'
    | 'LEAD_TIME_AND_FILL_HISTORY'
    | 'OPEN_INBOUND'
    | 'EXPIRY_RISK'
    | 'PACK_ROUNDING'
    | 'CASH_AND_STORAGE_CONSTRAINTS'
    | 'UNFULFILLED_DEMAND';
  value: string;
};

export type SupplierComparison = SupplierEstimate & {
  estimatedLineCostMinor: number;
  estimate: EstimateDisclosure;
};

export type ForecastLine = {
  medicineId: string;
  forecastQuantityUnits: number;
  deterministicBaselineUnits: number;
  reasons: readonly ForecastReason[];
  estimate: EstimateDisclosure;
  supplierComparison: readonly SupplierComparison[];
};

export type ReplenishmentDraft = {
  documentType: 'REQUISITION';
  status: 'DRAFT';
  lines: readonly ForecastLine[];
};

export type RebalanceDraft = {
  documentType: 'TRANSFER';
  status: 'DRAFT';
  medicineId: string;
  fromBranchId: string;
  toBranchId: string;
  quantityUnits: number;
  reasons: readonly string[];
  estimate: EstimateDisclosure;
};

export type ForecastComparison = {
  organizationId: string;
  forecastingEnabled: boolean;
  selectedSource: 'DETERMINISTIC_BASELINE' | 'FORECAST';
  deterministicBaseline: readonly { medicineId: string; quantityUnits: number }[];
  forecast: readonly ForecastLine[];
  drafts: readonly ReplenishmentDraft[];
  rebalanceDrafts: readonly RebalanceDraft[];
};

export class ForecastApprovalError extends Error {
  constructor(readonly reason: 'APPROVER_REQUIRED' | 'SELF_APPROVAL') {
    super(reason);
  }
}

function integer(value: number, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError('Forecast inputs must be non-negative safe integers');
  }
}

function disclosure(line: ForecastFixtureLine): EstimateDisclosure {
  const confidence =
    line.demandWindowDays >= 90 && line.fillRateBps >= 9_000
      ? 'HIGH'
      : line.demandWindowDays >= 30 && line.fillRateBps >= 7_500
        ? 'MEDIUM'
        : 'LOW';
  return {
    label: 'ESTIMATE',
    method: 'lead-time demand from observed velocity, adjusted for seasonality and fill history',
    windowDays: line.demandWindowDays,
    exclusions: ['future promotions', 'supplier price changes', 'unrecorded demand'],
    confidence,
  };
}

function forecastLine(line: ForecastFixtureLine): ForecastLine {
  [
    line.demandUnits,
    line.openPurchaseOrderUnits,
    line.openTransferUnits,
    line.onHandUnits,
    line.expiringBeforeLeadTimeUnits,
    line.cashLimitUnits,
    line.storageLimitUnits,
    line.unfulfilledDemandUnits,
    line.deterministicSafetyStockUnits,
  ].forEach((value) => integer(value));
  [line.demandWindowDays, line.leadTimeDays, line.packSize].forEach((value) =>
    integer(value, false)
  );
  const learnedUplift = line.seasonalContext ? learnCalendarUplift(line.seasonalContext) : null;
  const seasonalityBps = learnedUplift?.upliftBps ?? line.seasonalityBps ?? BPS;
  if (seasonalityBps <= 0 || line.fillRateBps <= 0 || line.fillRateBps > BPS) {
    throw new RangeError('Rates must be positive basis points and fill rate cannot exceed 100%');
  }

  const velocityLeadDemand = Math.ceil(
    (line.demandUnits * line.leadTimeDays * seasonalityBps * BPS) /
      (line.demandWindowDays * BPS * line.fillRateBps)
  );
  const inbound = line.openPurchaseOrderUnits + line.openTransferUnits;
  const usableOnHand = Math.max(0, line.onHandUnits - line.expiringBeforeLeadTimeUnits);
  const rawNeed = Math.max(
    0,
    velocityLeadDemand + line.unfulfilledDemandUnits - usableOnHand - inbound
  );
  const packRounded = Math.ceil(rawNeed / line.packSize) * line.packSize;
  const constrainedLimit = Math.min(line.cashLimitUnits, line.storageLimitUnits);
  const forecastQuantityUnits =
    Math.floor(Math.min(packRounded, constrainedLimit) / line.packSize) * line.packSize;
  const estimate = disclosure(line);
  const deterministicBaselineUnits = Math.max(
    0,
    line.deterministicSafetyStockUnits - line.onHandUnits - inbound
  );

  return {
    medicineId: line.medicineId,
    forecastQuantityUnits,
    deterministicBaselineUnits,
    estimate,
    reasons: [
      {
        input: 'DEMAND_VELOCITY',
        value: `${line.demandUnits} units / ${line.demandWindowDays} days`,
      },
      {
        input: 'SEASONALITY',
        value: learnedUplift
          ? `${seasonalityBps} bps learned from ${learnedUplift.eventDays} branch event days (${learnedUplift.windowName})`
          : `${seasonalityBps} bps${line.seasonalityBps ? ' legacy input' : ' neutral (insufficient calendar history)'}`,
      },
      {
        input: 'LEAD_TIME_AND_FILL_HISTORY',
        value: `${line.leadTimeDays} days; ${line.fillRateBps} bps fill`,
      },
      {
        input: 'OPEN_INBOUND',
        value: `${inbound} units (${line.openPurchaseOrderUnits} PO + ${line.openTransferUnits} transfer)`,
      },
      {
        input: 'EXPIRY_RISK',
        value: `${line.expiringBeforeLeadTimeUnits} units expire within lead time`,
      },
      {
        input: 'PACK_ROUNDING',
        value: `${rawNeed} raw units rounded to packs of ${line.packSize}`,
      },
      {
        input: 'CASH_AND_STORAGE_CONSTRAINTS',
        value: `${line.cashLimitUnits} cash / ${line.storageLimitUnits} storage units`,
      },
      { input: 'UNFULFILLED_DEMAND', value: `${line.unfulfilledDemandUnits} captured units` },
    ],
    supplierComparison: [...line.suppliers]
      .map((supplier) => ({
        ...supplier,
        estimatedLineCostMinor: forecastQuantityUnits * supplier.unitCostMinor,
        estimate,
      }))
      .sort(
        (a, b) =>
          a.estimatedLineCostMinor - b.estimatedLineCostMinor ||
          a.supplierId.localeCompare(b.supplierId)
      ),
  };
}

function rebalance(line: ForecastFixtureLine, estimate: EstimateDisclosure): RebalanceDraft[] {
  const recipients = line.branches
    .map((branch) => ({
      branch,
      shortage: Math.max(
        0,
        branch.forecastDemandUnits + branch.safetyStockUnits - branch.availableUnits
      ),
    }))
    .filter(({ shortage }) => shortage > 0);
  const donors = line.branches
    .map((branch) => ({
      branch,
      excess: Math.max(
        0,
        branch.availableUnits - branch.forecastDemandUnits - branch.safetyStockUnits
      ),
    }))
    .filter(({ excess }) => excess > 0);
  const drafts: RebalanceDraft[] = [];
  for (const recipient of recipients) {
    for (const donor of donors) {
      const quantityUnits = Math.min(recipient.shortage, donor.excess);
      if (quantityUnits === 0 || donor.branch.branchId === recipient.branch.branchId) continue;
      drafts.push({
        documentType: 'TRANSFER',
        status: 'DRAFT',
        medicineId: line.medicineId,
        fromBranchId: donor.branch.branchId,
        toBranchId: recipient.branch.branchId,
        quantityUnits,
        reasons: [
          `Estimated dead stock: ${donor.excess} units above forecast demand and safety stock`,
          `Estimated recipient shortage: ${recipient.shortage} units`,
        ],
        estimate,
      });
      donor.excess -= quantityUnits;
      recipient.shortage -= quantityUnits;
      if (recipient.shortage === 0) break;
    }
  }
  return drafts;
}

/** Runs forecast and deterministic quantities over the exact same supplied fixture window. */
export function compareReplenishment(
  fixture: readonly ForecastFixtureLine[],
  setting: ForecastSetting
): ForecastComparison {
  const forecast = fixture.map(forecastLine);
  const deterministicBaseline = fixture.map((line, index) => ({
    medicineId: line.medicineId,
    quantityUnits: forecast[index]!.deterministicBaselineUnits,
  }));
  return {
    organizationId: setting.organizationId,
    forecastingEnabled: setting.enabled,
    selectedSource: setting.enabled ? 'FORECAST' : 'DETERMINISTIC_BASELINE',
    deterministicBaseline,
    forecast,
    drafts: setting.enabled
      ? [{ documentType: 'REQUISITION', status: 'DRAFT', lines: forecast }]
      : [],
    rebalanceDrafts: setting.enabled
      ? fixture.flatMap((line, index) => rebalance(line, forecast[index]!.estimate))
      : [],
  };
}

/** Human approval advances only the requisition; order creation is outside this module. */
export function approveForecastDraft(
  draft: ReplenishmentDraft,
  input: { createdById: string; approverId?: string }
): { documentType: 'REQUISITION'; status: 'APPROVED'; approvedById: string } {
  if (!input.approverId) throw new ForecastApprovalError('APPROVER_REQUIRED');
  if (input.approverId === input.createdById) throw new ForecastApprovalError('SELF_APPROVAL');
  return { documentType: draft.documentType, status: 'APPROVED', approvedById: input.approverId };
}

/** Available units must already exclude reservations and other commitments. */
export type DecisionStockLot = Omit<AllocationCandidate, 'expiresAt'> & {
  medicineId: string;
  expiresAt: Date | null;
};

export type DecisionInbound = {
  id: string;
  confirmed: boolean;
  knownAt: string;
  arrivalAt: string | null;
  /** Expected receipt eligibility; receipt at arrival remains a scenario assumption. */
  lot: Omit<DecisionStockLot, 'receivedAt'>;
};

export type DecisionOrderTerms = {
  source: DemandSource;
  packSize: number;
  minimumOrderUnits: number;
  unitCostMinor: number | null;
  budgetMinor: number | null;
  /** Incremental order capacity, already net of existing/inbound stock. */
  storageLimitUnits: number | null;
  arrivalAt: string | null;
  /** Canonically normalized expiry instant; null means unknown, never no-expiry. */
  expiresAt: string | null;
};

export type ReplenishmentDecisionInput = {
  demand: DemandEvidenceInput;
  currency: string;
  inventorySource: DemandSource;
  stock: readonly DecisionStockLot[];
  inbound: readonly DecisionInbound[];
  /** Reuse legacy quantities, or explicitly label operator-entered alternatives. */
  policies:
    | { source: 'EXISTING_COMPARISON'; comparison: ForecastComparison }
    | { source: 'MANUAL_SCENARIO'; currentQuantityUnits: number; proposedQuantityUnits: number };
  orderTerms: DecisionOrderTerms;
};

export type DecisionOrder = {
  status: 'FEASIBLE' | 'CONSTRAINED' | 'INFEASIBLE' | 'UNKNOWN';
  requestedUnits: number;
  quantityUnits: number | null;
  committedCashMinor: number | null;
  reasons: readonly string[];
};

export type DecisionOutcome = {
  demandUnits: number;
  fulfilledUnits: number;
  shortageUnits: number;
  expiredUnits: number;
  endingStockUnits: number;
  pendingInboundUnits: number;
};

export type ReplenishmentDecision = {
  label: 'CONDITIONAL_SCENARIO';
  demand: DemandForecast;
  inventorySource: DemandSource;
  money: {
    currency: string;
    scale: 'MINOR_UNITS';
    definition: string;
    period: DemandForecast['period'];
    scope: DemandForecast['scope'];
    source: DemandForecast['source'];
    coverage: 'SUPPLIED_ORDER_TERMS_ONLY';
  };
  policySource: ReplenishmentDecisionInput['policies']['source'];
  selectedSource: ForecastComparison['selectedSource'] | 'MANUAL_SCENARIO';
  approvalRequired: true;
  scenarios: readonly {
    policy: 'NO_ORDER' | 'CURRENT' | 'PROPOSED';
    order: DecisionOrder;
    outcome: DecisionOutcome | null;
    days: readonly (Omit<DecisionOutcome, 'pendingInboundUnits'> & { date: string })[];
    /** Canonical lot/location allocations, allowing deterministic FEFO audit. */
    allocations: readonly {
      date: string;
      inventoryLotId: string;
      stockLocationId: string;
      units: number;
    }[];
  }[];
  excludedStock: readonly { inventoryLotId: string; stockLocationId: string; reason: string }[];
  excludedInbound: readonly { id: string; reason: string }[];
  assumptions: readonly string[];
  unknowns: readonly string[];
};

function constrainDecisionOrder(requestedUnits: number, terms: DecisionOrderTerms): DecisionOrder {
  integer(requestedUnits);
  if (requestedUnits === 0)
    return {
      status: 'FEASIBLE',
      requestedUnits,
      quantityUnits: 0,
      committedCashMinor: 0,
      reasons: [],
    };
  if (
    terms.unitCostMinor === null ||
    terms.budgetMinor === null ||
    terms.storageLimitUnits === null
  ) {
    return {
      status: 'UNKNOWN',
      requestedUnits,
      quantityUnits: null,
      committedCashMinor: null,
      reasons: [
        'Unit cost, budget and net storage capacity must be known; unknown is not zero or unlimited.',
      ],
    };
  }
  const pack = BigInt(terms.packSize);
  const ceilPacks = (units: number) => (BigInt(units) + pack - BigInt(1)) / pack;
  const requestedPacks = ceilPacks(Math.max(requestedUnits, terms.minimumOrderUnits));
  const packCost = pack * BigInt(terms.unitCostMinor);
  const storagePacks = BigInt(terms.storageLimitUnits) / pack;
  const cashPacks = packCost === BigInt(0) ? storagePacks : BigInt(terms.budgetMinor) / packCost;
  const limitPacks = cashPacks < storagePacks ? cashPacks : storagePacks;
  const minimumPacks = ceilPacks(Math.max(1, terms.minimumOrderUnits));
  if (limitPacks < minimumPacks) {
    return {
      status: 'INFEASIBLE',
      requestedUnits,
      quantityUnits: 0,
      committedCashMinor: 0,
      reasons: ['Budget or storage cannot fund a whole pack meeting MOQ.'],
    };
  }
  const packs = requestedPacks < limitPacks ? requestedPacks : limitPacks;
  const quantityUnits = Number(packs * pack);
  const committedCashMinor = Number(packs * packCost);
  integer(quantityUnits);
  integer(committedCashMinor);
  const reasons: string[] = [];
  if (BigInt(requestedUnits) !== requestedPacks * pack)
    reasons.push('Requested quantity rounded upward to whole packs and MOQ.');
  if (packs < requestedPacks)
    reasons.push('Whole packs reduced by budget or net storage capacity.');
  return {
    status: reasons.length ? 'CONSTRAINED' : 'FEASIBLE',
    requestedUnits,
    quantityUnits,
    committedCashMinor,
    reasons,
  };
}

function validateDecisionLot(lot: DecisionStockLot): void {
  integer(lot.availableUnits);
  if (!lot.inventoryLotId.trim() || !lot.stockLocationId.trim())
    throw new RangeError('Stock identity is required');
  for (const date of [lot.expiresAt, lot.receivedAt]) {
    if (date !== null && !Number.isFinite(date.getTime()))
      throw new RangeError('Invalid stock instant');
  }
}

function validateDecisionSource(source: DemandSource, origin: number): void {
  if (
    !source.reference.trim() ||
    !['OBSERVED_TRANSACTIONS', 'MANUAL_SCENARIO', 'SYNTHETIC_FIXTURE'].includes(source.kind) ||
    demandInstantMs(source.asOf) > origin
  ) {
    throw new RangeError('Decision source must be explicit and available at origin');
  }
}

/**
 * Read-only comparison, never an order recommendation or approval transition.
 * Feed compareReplenishment's existing quantities via EXISTING_COMPARISON; its
 * fixture-derived estimates remain labelled and its feature selection is preserved.
 * A live adapter must establish scope, evidence provenance and complete stock inputs.
 */
export function simulateReplenishmentDecision(
  input: ReplenishmentDecisionInput
): ReplenishmentDecision {
  const demand = forecastDemandEvidence(input.demand);
  const origin = demandDateMs(demand.originDate);
  const end = demandDateMs(demand.period.endDateExclusive);
  const cutoff = Math.min(origin, demandInstantMs(input.inventorySource.asOf));
  if (!/^[A-Z]{3}$/.test(input.currency))
    throw new RangeError('Explicit currency code is required');
  const terms = input.orderTerms;
  validateDecisionSource(input.inventorySource, origin);
  validateDecisionSource(terms.source, origin);
  if (input.stock.length > 10_000 || input.inbound.length > 10_000)
    throw new RangeError('Too many stock or inbound rows');
  integer(terms.packSize, false);
  integer(terms.minimumOrderUnits);
  for (const value of [terms.unitCostMinor, terms.budgetMinor, terms.storageLimitUnits]) {
    if (value !== null) integer(value);
  }
  const orderArrival = terms.arrivalAt === null ? null : demandInstantMs(terms.arrivalAt);
  const orderExpiry = terms.expiresAt === null ? null : demandInstantMs(terms.expiresAt);
  if (orderArrival !== null && orderArrival < origin)
    throw new RangeError('A new order cannot arrive before origin');

  let quantities: readonly number[];
  let selectedSource: ReplenishmentDecision['selectedSource'];
  if (input.policies.source === 'EXISTING_COMPARISON') {
    const comparison = input.policies.comparison;
    const current = comparison.deterministicBaseline.filter(
      (line) => line.medicineId === demand.scope.medicineId
    );
    const proposed = comparison.forecast.filter(
      (line) => line.medicineId === demand.scope.medicineId
    );
    if (
      comparison.organizationId !== demand.scope.organizationId ||
      current.length !== 1 ||
      proposed.length !== 1
    ) {
      throw new RangeError('Comparison must match organization and exactly one medicine');
    }
    quantities = [0, current[0]!.quantityUnits, proposed[0]!.forecastQuantityUnits];
    selectedSource = comparison.selectedSource;
  } else if (input.policies.source === 'MANUAL_SCENARIO') {
    quantities = [0, input.policies.currentQuantityUnits, input.policies.proposedQuantityUnits];
    selectedSource = 'MANUAL_SCENARIO';
  } else throw new RangeError('Unsupported policy source');
  quantities.forEach((value) => integer(value));

  const excludedStock: ReplenishmentDecision['excludedStock'][number][] = [];
  const excludedInbound: ReplenishmentDecision['excludedInbound'][number][] = [];
  const unknowns = [...demand.unknowns];
  const identities = new Set<string>();
  const identity = (lot: Pick<AllocationCandidate, 'inventoryLotId' | 'stockLocationId'>) =>
    JSON.stringify([lot.inventoryLotId, lot.stockLocationId]);
  const register = (lot: DecisionStockLot) => {
    validateDecisionLot(lot);
    const key = identity(lot);
    if (identities.has(key) || lot.inventoryLotId.startsWith('decision-order:'))
      throw new RangeError('Duplicate or reserved stock identity');
    identities.add(key);
    // A pure calculation is not authorization, but must fail closed on mixed scopes.
    if (
      lot.organizationId !== demand.scope.organizationId ||
      lot.branchId !== demand.scope.branchId ||
      lot.medicineId !== demand.scope.medicineId
    )
      throw new RangeError('Stock scope does not match demand scope');
  };
  const scope = {
    organizationId: demand.scope.organizationId,
    branchId: demand.scope.branchId,
    at: new Date(origin),
  };
  const stock: AllocationCandidate[] = [];
  for (const lot of input.stock) {
    register(lot);
    const reason =
      lot.expiresAt === null ? 'UNKNOWN_EXPIRY' : blockReasonFor(lot as AllocationCandidate, scope);
    if (reason)
      excludedStock.push({
        inventoryLotId: lot.inventoryLotId,
        stockLocationId: lot.stockLocationId,
        reason,
      });
    else
      stock.push({
        ...lot,
        expiresAt: new Date(lot.expiresAt!),
        receivedAt: new Date(lot.receivedAt!),
      });
  }
  const arrivals: { at: number; lot: AllocationCandidate }[] = [];
  const inboundIds = new Set<string>();
  for (const inbound of input.inbound) {
    if (!inbound.id.trim() || inboundIds.has(inbound.id))
      throw new RangeError('Duplicate or missing inbound identity');
    inboundIds.add(inbound.id);
    const lot = { ...inbound.lot, receivedAt: null };
    register(lot);
    const knownAt = demandInstantMs(inbound.knownAt);
    const at = inbound.arrivalAt === null ? null : demandInstantMs(inbound.arrivalAt);
    let reason: string | null = null;
    if (!inbound.confirmed) reason = 'UNCONFIRMED';
    else if (knownAt > cutoff) reason = 'NOT_KNOWN_AT_ORIGIN';
    else if (at === null) reason = 'UNKNOWN_ARRIVAL';
    else if (at < origin) reason = 'PAST_ARRIVAL_REQUIRES_STOCK_SNAPSHOT';
    else if (lot.expiresAt === null) reason = 'UNKNOWN_EXPIRY';
    else
      reason = blockReasonFor(
        { ...lot, expiresAt: lot.expiresAt, receivedAt: new Date(at) },
        { ...scope, at: new Date(at) }
      );
    if (reason) excludedInbound.push({ id: inbound.id, reason });
    else
      arrivals.push({
        at: at!,
        lot: { ...lot, expiresAt: new Date(lot.expiresAt!), receivedAt: new Date(at!) },
      });
  }
  if (excludedStock.some((lot) => lot.reason === 'UNKNOWN_EXPIRY') || excludedInbound.length) {
    unknowns.push(
      'Excluded stock/inbound is not assumed available; outcomes cover only supplied eligible inventory and dated confirmed receipts.'
    );
  }
  if (input.policies.source === 'EXISTING_COMPARISON')
    unknowns.push(
      'Policy quantities come from the existing fixture comparison, not a verified live demand adapter.'
    );
  const scenarios = (['NO_ORDER', 'CURRENT', 'PROPOSED'] as const).map((policy, index) => {
    const order = constrainDecisionOrder(quantities[index]!, terms);
    const days: ReplenishmentDecision['scenarios'][number]['days'][number][] = [];
    const allocations: ReplenishmentDecision['scenarios'][number]['allocations'][number][] = [];
    const result = { policy, order, outcome: null as DecisionOutcome | null, days, allocations };
    if (order.quantityUnits === null || demand.days.some((day) => day.units === null))
      return result;
    if (order.quantityUnits > 0 && (orderArrival === null || orderExpiry === null)) {
      order.status = 'UNKNOWN';
      order.reasons = [...order.reasons, 'Order arrival or expiry is unknown.'];
      unknowns.push(
        `${policy}: arrival or expiry of the hypothetical order is unknown; inventory outcome unavailable.`
      );
      return result;
    }
    const lots = stock.map((lot) => ({ ...lot }));
    const pending = arrivals.map((arrival) => ({ at: arrival.at, lot: { ...arrival.lot } }));
    if (order.quantityUnits > 0)
      pending.push({
        at: orderArrival!,
        lot: {
          inventoryLotId: `decision-order:${policy}`,
          stockLocationId: 'decision-order',
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          batchState: 'ACTIVE',
          disposition: 'AVAILABLE',
          expiresAt: new Date(orderExpiry!),
          receivedAt: new Date(orderArrival!),
          availableUnits: order.quantityUnits,
        },
      });
    pending.sort((a, b) => a.at - b.at);
    // Prove aggregate arithmetic is safe before allocation/summation.
    safeDemandTotal([
      ...lots.map((lot) => lot.availableUnits),
      ...pending.map(({ lot }) => lot.availableUnits),
    ]);
    const total: DecisionOutcome = {
      demandUnits: 0,
      fulfilledUnits: 0,
      shortageUnits: 0,
      expiredUnits: 0,
      endingStockUnits: 0,
      pendingInboundUnits: 0,
    };
    const advance = (at: number, includeArrival: boolean): number => {
      while (pending.length && (includeArrival ? pending[0]!.at <= at : pending[0]!.at < at))
        lots.push(pending.shift()!.lot);
      let expired = 0;
      for (const lot of lots) {
        if (lot.expiresAt.getTime() <= at) {
          expired = safeDemandTotal([expired, lot.availableUnits]);
          lot.availableUnits = 0;
        }
      }
      return expired;
    };
    for (const day of demand.days) {
      const at = demandDateMs(day.date);
      const expiredUnits = advance(at, true);
      const dayScope = { ...scope, at: new Date(at) };
      const available = safeDemandTotal(
        lots
          .filter((lot) => blockReasonFor(lot, dayScope) === null)
          .map((lot) => lot.availableUnits)
      );
      const fulfilledUnits = Math.min(day.units!, available);
      if (fulfilledUnits > 0) {
        const plan = planAllocation({
          candidates: lots,
          scope: dayScope,
          requiredUnits: fulfilledUnits,
        });
        for (const allocation of plan.allocations) {
          const lot = lots.find((candidate) => identity(candidate) === identity(allocation))!;
          lot.availableUnits -= allocation.units;
          allocations.push({ date: day.date, ...allocation });
        }
      }
      const shortageUnits = day.units! - fulfilledUnits;
      total.demandUnits = safeDemandTotal([total.demandUnits, day.units!]);
      total.fulfilledUnits = safeDemandTotal([total.fulfilledUnits, fulfilledUnits]);
      total.shortageUnits = safeDemandTotal([total.shortageUnits, shortageUnits]);
      total.expiredUnits = safeDemandTotal([total.expiredUnits, expiredUnits]);
      days.push({
        date: day.date,
        demandUnits: day.units!,
        fulfilledUnits,
        shortageUnits,
        expiredUnits,
        endingStockUnits: safeDemandTotal(lots.map((lot) => lot.availableUnits)),
      });
    }
    // End-exclusive receipts remain pending. Expiry at the closing boundary is unavailable ending stock.
    const closingExpiry = advance(end, false);
    total.expiredUnits = safeDemandTotal([total.expiredUnits, closingExpiry]);
    total.endingStockUnits = safeDemandTotal(lots.map((lot) => lot.availableUnits));
    total.pendingInboundUnits = safeDemandTotal(pending.map(({ lot }) => lot.availableUnits));
    const lastDay = days.at(-1)!;
    lastDay.expiredUnits = safeDemandTotal([lastDay.expiredUnits, closingExpiry]);
    lastDay.endingStockUnits = total.endingStockUnits;
    result.outcome = total;
    return result;
  });
  return {
    label: 'CONDITIONAL_SCENARIO',
    demand,
    inventorySource: { ...input.inventorySource },
    money: {
      currency: input.currency,
      scale: 'MINOR_UNITS',
      definition:
        'Incremental hypothetical order quantity times supplied unit cost committed at origin; excludes existing inbound liabilities, taxes, freight, payment timing and inventory expense. Not profit or cash paid.',
      period: demand.period,
      scope: demand.scope,
      source: { ...terms.source },
      coverage: 'SUPPLIED_ORDER_TERMS_ONLY',
    },
    policySource: input.policies.source,
    selectedSource,
    approvalRequired: true,
    scenarios,
    excludedStock,
    excludedInbound,
    assumptions: [
      ...demand.assumptions,
      'All policies face identical demand; unmet demand is lost for that day, never backfilled by late receipts.',
      'Daily demand occurs at UTC day start. Receipts become available only after arrival; intraday demand/receipt timing is not modelled.',
      'Canonical blockReasonFor and planAllocation enforce eligibility, expiry at or before an instant, and FEFO receipt/id tie-breaks.',
      'Stock is an origin snapshot net of reservations; confirmed inbound must be disjoint from stock and excludes already received quantities.',
      'Hypothetical order receipts assume ACTIVE/AVAILABLE stock; future quarantine, recall, supplier failure and changes to reservations are unknown.',
      'Expired units are simulated exposure, not a posted loss; no-order has zero additional purchase commitment, not zero existing liabilities.',
      'Order terms and currency are supplied scenario assumptions; completeness and freshness of live inventory and prices are not verified here.',
      'Inventory source as-of is disclosed; no unrecorded movement between its snapshot and origin is assumed.',
      'No drafts, purchases, stock writes, authorization grants or approval transitions are emitted; existing approval rules remain required.',
    ],
    unknowns: [...new Set(unknowns)],
  };
}
