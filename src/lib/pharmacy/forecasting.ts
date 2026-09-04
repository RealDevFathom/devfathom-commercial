/**
 * PUR-09 / DEM-02 — explainable replenishment estimates.
 *
 * This module is deliberately pure and can only emit inert drafts. PUR-07's
 * deterministic result remains the source of truth unless an organization
 * explicitly enables forecasting; even then, an approver is required before a
 * requisition may advance. Nothing here can create a purchase order or move stock.
 */

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
  seasonalityBps: number;
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
  if (line.seasonalityBps <= 0 || line.fillRateBps <= 0 || line.fillRateBps > BPS) {
    throw new RangeError('Rates must be positive basis points and fill rate cannot exceed 100%');
  }

  const velocityLeadDemand = Math.ceil(
    (line.demandUnits * line.leadTimeDays * line.seasonalityBps * BPS) /
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
      { input: 'SEASONALITY', value: `${line.seasonalityBps} bps` },
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
