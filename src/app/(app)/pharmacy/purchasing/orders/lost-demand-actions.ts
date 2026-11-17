'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';

import {
  destination,
  field,
  integerField,
  moneyFieldMinor,
  NO_ACTOR,
  optionalField,
  purchasingCaller,
  purchasingOutcome,
  PurchasingValidationError,
  PURCHASING_ROUTE,
} from '../_lib/console';

const ROUTE = `${PURCHASING_ROUTE}/orders`;
const STALE =
  'This advice has changed since the page loaded. Reload the page to see the current suggestion.';

/**
 * DEV-80: every lost-demand action is re-derived from the server's current advice,
 * so a stale or edited form cannot change the supplier terms or quantity. Each one
 * creates a DRAFT only; approval and sending stay on the normal order workflow.
 */
export async function draftLostDemandOrder(form: FormData): Promise<string> {
  const branchId = field(form, 'branchId');
  const outcome = purchasingOutcome();
  try {
    const caller = await purchasingCaller();
    if (!caller) throw new PurchasingValidationError(NO_ACTOR);
    const demandKey = field(form, 'demandKey');
    const supplierId = field(form, 'supplierId');
    const { advice } = await caller.lostDemandAdvice({ branchId });
    const card = advice.find((row) => row.demandKey === demandKey);
    const option = card?.distributors.find((row) => row.supplierId === supplierId);
    if (!card?.medicineId || !option || option.quantity.orderedPacks <= 0)
      throw new PurchasingValidationError(STALE);
    const created = await outcome.write(caller.createPurchaseOrder)({
      reference: `LD-${randomUUID().slice(0, 8).toUpperCase()}`,
      supplierId,
      branchId,
      lostDemandKey: demandKey,
      note: `Drafted from lost-demand advice: ${card.summary}`.slice(0, 2000),
      lines: [
        {
          medicineId: card.medicineId,
          packLevelId: option.packLevelId,
          orderedPacks: option.quantity.orderedPacks,
          bonusPacks: option.quantity.bonusPacks,
          canonicalUnitsPerPack: option.canonicalUnitsPerPack,
          listPricePerPackMinor: option.lastListPricePerPackMinor,
          discountBps: option.lastDiscountBps,
          rebateBps: option.lastRebateBps ?? 0,
          taxBps: option.lastTaxBps ?? 0,
          taxCreditable: option.lastTaxCreditable ?? false,
          // No lead time: the order line keeps none unless a quote states it, so a
          // branch default is never later read back as a recorded delivery time.
        },
      ],
    });
    revalidatePath(ROUTE);
    return destination(
      ROUTE,
      {
        message: `Draft order ${created.reference} created. It is not sent: submit it for approval when ready.`,
        kind: 'success',
      },
      { po: created.id, branch: branchId }
    );
  } catch (error) {
    return destination(
      ROUTE,
      { ...outcome.failure(error, 'Could not draft the order.'), kind: 'error' },
      { branch: branchId }
    );
  }
}

export async function requestLostDemandTransfer(form: FormData): Promise<string> {
  const branchId = field(form, 'branchId');
  const outcome = purchasingOutcome();
  try {
    const caller = await purchasingCaller();
    if (!caller) throw new PurchasingValidationError(NO_ACTOR);
    const requested = await outcome.write(caller.requestLostDemandTransfer)({
      branchId,
      demandKey: field(form, 'demandKey'),
      fromBranchId: field(form, 'fromBranchId'),
    });
    revalidatePath(ROUTE);
    const units = requested.lines.reduce((total, line) => total + line.quantityUnits, 0);
    return destination(
      ROUTE,
      {
        message: `Transfer request for ${units} units recorded as a draft. Nothing has been allocated or moved: the source branch allocates it in Stock transfers and a colleague approves it before dispatch.`,
        kind: 'success',
      },
      { branch: branchId }
    );
  } catch (error) {
    return destination(
      ROUTE,
      { ...outcome.failure(error, 'Could not request the transfer.'), kind: 'error' },
      { branch: branchId }
    );
  }
}

export async function ignoreLostDemandAdvice(form: FormData): Promise<string> {
  const branchId = field(form, 'branchId');
  const outcome = purchasingOutcome();
  try {
    const caller = await purchasingCaller();
    if (!caller) throw new PurchasingValidationError(NO_ACTOR);
    await outcome.write(caller.ignoreLostDemandAdvice)({
      branchId,
      demandKey: field(form, 'demandKey'),
      reason: optionalField(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return destination(
      ROUTE,
      { message: 'Advice ignored until a new request is recorded.', kind: 'success' },
      { branch: branchId }
    );
  } catch (error) {
    return destination(
      ROUTE,
      { ...outcome.failure(error, 'Could not ignore the advice.'), kind: 'error' },
      { branch: branchId }
    );
  }
}

/** "10" or "12.5" percent → basis points, exactly; anything else names the field. */
function percentFieldBps(form: FormData, name: string, label: string): number {
  const raw = field(form, name);
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw))
    throw Object.assign(
      new PurchasingValidationError(`${label}: enter a percentage like 10 or 12.5.`),
      {
        field: name,
      }
    );
  const [whole, fraction = ''] = raw.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/**
 * DEV-80: per-branch trigger thresholds and planning assumptions. The research
 * figures are only the starting defaults; a manager or owner changes them here,
 * and the server enforces both the permission and every bound.
 */
export async function saveLostDemandTriggers(form: FormData): Promise<string> {
  const branchId = field(form, 'branchId');
  const outcome = purchasingOutcome();
  try {
    const settings = {
      requestCountThreshold: integerField(form, 'requestCountThreshold', 'Requests'),
      requestWindowDays: integerField(form, 'requestWindowDays', 'Request window'),
      estimatedLossThresholdMinor: moneyFieldMinor(
        form,
        'estimatedLossThreshold',
        'Estimated loss'
      ),
      lossWindowDays: integerField(form, 'lossWindowDays', 'Loss window'),
      walkOutRateThresholdBps: percentFieldBps(form, 'walkOutRatePercent', 'Walk-out rate'),
      forecastWindowDays: integerField(form, 'forecastWindowDays', 'Forecast window'),
      safetyStockDays: integerField(form, 'safetyStockDays', 'Safety stock'),
      defaultLeadTimeDays: integerField(form, 'defaultLeadTimeDays', 'Default lead time'),
    };
    const caller = await purchasingCaller();
    if (!caller) throw new PurchasingValidationError(NO_ACTOR);
    await outcome.write(caller.setLostDemandTriggerSettings)({ branchId, settings });
    revalidatePath(ROUTE);
    return destination(
      ROUTE,
      { message: 'Lost-demand triggers saved for this branch.', kind: 'success' },
      { branch: branchId }
    );
  } catch (error) {
    return destination(
      ROUTE,
      { ...outcome.failure(error, 'Could not save the triggers.'), kind: 'error' },
      { branch: branchId }
    );
  }
}
