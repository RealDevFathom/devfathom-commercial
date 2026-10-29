/**
 * Lost-demand procurement advice (§9.5/§9.9).
 *
 * This module deliberately stops at a draft boundary. Sending and approval are
 * owned by the existing purchasing/transfer workflows; advice can never call
 * either operation.
 */

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
  estimatedLossMinor: 1_000_000, // PKR 10,000, stored in minor units
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

/** The caller supplies metrics calculated over the configured branch windows. */
export function evaluateLostDemandTriggers(
  metrics: LostDemandMetrics,
  config: LostDemandTriggerConfig
): LostDemandTrigger[] {
  const fired: LostDemandTrigger[] = [];
  if (metrics.requests >= config.requestsInWindow) fired.push('REQUESTS');
  if (metrics.estimatedLossMinor >= config.estimatedLossMinor) fired.push('ESTIMATED_LOSS');
  if (metrics.visits > 0 && metrics.walkOuts * 10_000 > metrics.visits * config.walkOutRateBps)
    fired.push('WALK_OUT_RATE');
  return fired;
}

export type ReplenishmentTerms = {
  packUnits: number;
  schemeBuyPacks?: number;
  schemeFreePacks?: number;
};

/**
 * Forecast over supplier lead time + safety stock - usable stock - open supply,
 * rounded up to an order quantity that honours both pack size and buy/get scheme.
 */
export function suggestedProcurementQuantity(input: {
  forecastUnitsOverLeadTime: number;
  safetyStockUnits: number;
  onHandUnits: number;
  onOrderUnits: number;
  terms: ReplenishmentTerms;
}): { requiredUnits: number; orderedPacks: number; bonusPacks: number; suppliedUnits: number } {
  const values = [
    input.forecastUnitsOverLeadTime,
    input.safetyStockUnits,
    input.onHandUnits,
    input.onOrderUnits,
    input.terms.packUnits,
    input.terms.schemeBuyPacks ?? 0,
    input.terms.schemeFreePacks ?? 0,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    input.terms.packUnits < 1
  )
    throw new Error('Lost-demand quantities must be non-negative safe integers.');
  const buy = input.terms.schemeBuyPacks ?? 0;
  const free = input.terms.schemeFreePacks ?? 0;
  if ((buy === 0) !== (free === 0))
    throw new Error('A bonus scheme requires both buy and free packs.');

  const requiredUnits = Math.max(
    0,
    input.forecastUnitsOverLeadTime +
      input.safetyStockUnits -
      input.onHandUnits -
      input.onOrderUnits
  );
  let orderedPacks = buy > 0 ? 0 : Math.ceil(requiredUnits / input.terms.packUnits);
  if (buy > 0) {
    while (
      (orderedPacks + Math.floor(orderedPacks / buy) * free) * input.terms.packUnits <
      requiredUnits
    )
      orderedPacks += 1;
  }
  const bonusPacks = buy > 0 ? Math.floor(orderedPacks / buy) * free : 0;
  return {
    requiredUnits,
    orderedPacks,
    bonusPacks,
    suppliedUnits: (orderedPacks + bonusPacks) * input.terms.packUnits,
  };
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
  branchId: string;
  medicineId: string;
  fired: LostDemandTrigger[];
  metrics: LostDemandMetrics;
  quantity: ReturnType<typeof suggestedProcurementQuantity>;
  distributors: DistributorAdvice[];
  alternates: AlternateAdvice[];
  transfers: TransferAdvice[];
};

export type ProcurementDraftWriter = {
  createPurchaseOrderDraft(input: {
    branchId: string;
    medicineId: string;
    supplierId: string;
    orderedPacks: number;
    bonusPacks: number;
    createdByUserId: string;
    status: 'DRAFT';
  }): Promise<{ id: string; status: 'DRAFT' }>;
  createTransferDraft(input: {
    fromBranchId: string;
    toBranchId: string;
    medicineId: string;
    quantityUnits: number;
    createdByUserId: string;
    status: 'DRAFT';
  }): Promise<{ id: string; status: 'DRAFT' }>;
  ignore(input: { branchId: string; medicineId: string; actorId: string }): Promise<void>;
};

/** Permission is checked at the human action; the advice computation performs no write. */
export async function actOnLostDemandAdvice(input: {
  action: 'DRAFT_PO' | 'DRAFT_TRANSFER' | 'IGNORE';
  advice: LostDemandAdvice;
  actorId: string;
  canProcure: boolean;
  supplierId?: string;
  fromBranchId?: string;
  writer: ProcurementDraftWriter;
}) {
  if (input.action !== 'IGNORE' && !input.canProcure)
    throw new Error('PROCUREMENT_PERMISSION_REQUIRED');
  if (input.action === 'IGNORE') {
    await input.writer.ignore({
      branchId: input.advice.branchId,
      medicineId: input.advice.medicineId,
      actorId: input.actorId,
    });
    return { status: 'IGNORED' as const };
  }
  if (input.action === 'DRAFT_PO') {
    if (!input.supplierId) throw new Error('SUPPLIER_REQUIRED');
    return input.writer.createPurchaseOrderDraft({
      branchId: input.advice.branchId,
      medicineId: input.advice.medicineId,
      supplierId: input.supplierId,
      orderedPacks: input.advice.quantity.orderedPacks,
      bonusPacks: input.advice.quantity.bonusPacks,
      createdByUserId: input.actorId,
      status: 'DRAFT',
    });
  }
  const transfer = input.advice.transfers.find((item) => item.fromBranchId === input.fromBranchId);
  if (!transfer) throw new Error('SURPLUS_TRANSFER_REQUIRED');
  return input.writer.createTransferDraft({
    fromBranchId: transfer.fromBranchId,
    toBranchId: input.advice.branchId,
    medicineId: input.advice.medicineId,
    quantityUnits: Math.min(transfer.surplusUnits, input.advice.quantity.requiredUnits),
    createdByUserId: input.actorId,
    status: 'DRAFT',
  });
}

/** Policy-safe notification: item, salt, strength, and category are intentionally absent. */
export function lostDemandWhatsAppText(
  advice: Pick<LostDemandAdvice, 'metrics' | 'fired'>
): string {
  return `Procurement review available: ${advice.metrics.requests} customer requests and PKR ${(advice.metrics.estimatedLossMinor / 100).toFixed(2)} estimated demand. Open the app to review a draft; nothing has been sent.`;
}
