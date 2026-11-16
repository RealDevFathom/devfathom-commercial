/**
 * DEV-90 — what the counter does with a scanned shelf sticker.
 *
 * The server resolves the sticker to one lot of this branch (`labelLot` on the
 * search row). Selling that lot when FEFO would draw it first needs nothing
 * more. Selling it out of FEFO order is the existing batch override, so the
 * counter stages the override with that lot and waits for the reason and the
 * pharmacist's approval the server already requires. A lot that cannot be sold
 * is reported, never staged.
 */

import type { CounterSearchRow } from './counter';

export type CounterLabelScanDecision =
  | { kind: 'NONE' }
  | { kind: 'FEFO' }
  | { kind: 'OVERRIDE'; inventoryLotId: string; message: string }
  | { kind: 'BLOCKED'; message: string };

const BLOCKED_LABEL: Record<string, string> = {
  EXPIRED: 'it has expired',
  RECALLED: 'it is recalled',
  QUARANTINED: 'it is quarantined',
  DAMAGED: 'it is recorded as damaged',
  DESTROYED: 'it is recorded as destroyed',
  IN_TRANSIT: 'it is in transit',
  RETURNED_TO_SUPPLIER: 'it is held for return to the supplier',
  UNRECEIVED: 'it has not been received',
  EMPTY: 'none of it is on hand',
};

export function counterLabelScanDecision(
  row: Pick<CounterSearchRow, 'labelLot' | 'recommendedLotId'>
): CounterLabelScanDecision {
  const lot = row.labelLot;
  if (!lot) return { kind: 'NONE' };
  if (lot.blockedBy !== null || lot.sellableUnits <= 0) {
    return {
      kind: 'BLOCKED',
      message: `Batch ${lot.batchNumber} on this shelf label cannot be sold: ${BLOCKED_LABEL[lot.blockedBy ?? 'EMPTY'] ?? 'it is not sellable'}. Remove the sticker and check the shelf.`,
    };
  }
  if (lot.inventoryLotId === row.recommendedLotId) return { kind: 'FEFO' };
  return {
    kind: 'OVERRIDE',
    inventoryLotId: lot.inventoryLotId,
    message: `Shelf label batch ${lot.batchNumber} is not the batch FEFO sells first. Enter a reason to sell it, or choose the FEFO batch.`,
  };
}
