'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';

import {
  destination,
  field,
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
          leadTimeDays: option.effectiveLeadTimeDays,
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
        message: `Transfer request for ${units} units recorded as a draft. Nothing has been allocated or moved. Allocation and approval of this request are not available yet.`,
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
