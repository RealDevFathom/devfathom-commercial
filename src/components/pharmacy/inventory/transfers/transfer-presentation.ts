/** WHA-1603 — INV-07 transfers console: status vocabulary and operator messages. */
import type { inferRouterOutputs } from '@trpc/server';

import type { pharmacyInventoryRouter } from '@/server/routers/pharmacy-inventory';

import type { PackingSlip } from './packing-slip';

export type TransferBoardRow = inferRouterOutputs<
  typeof pharmacyInventoryRouter
>['transferBoard'][number];

export type TransferTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** Statuses a destination may still receive against. */
export const RECEIVABLE_STATUSES: ReadonlySet<string> = new Set([
  'DISPATCHED',
  'PARTIALLY_RECEIVED',
  'EXCEPTION',
]);

/** A slip describes goods that have been approved to leave; nothing earlier. */
export const SLIP_STATUSES: ReadonlySet<string> = new Set([
  'APPROVED',
  'DISPATCHED',
  'PARTIALLY_RECEIVED',
  'EXCEPTION',
  'RECEIVED',
]);

export function transferVarianceUnits(transfer: Pick<TransferBoardRow, 'lines'>): number {
  return transfer.lines.reduce((sum, line) => sum + line.varianceUnits, 0);
}

export function transferStatusLabel(transfer: Pick<TransferBoardRow, 'status' | 'lines'>): string {
  if (transfer.status === 'RECEIVED' && transferVarianceUnits(transfer) > 0)
    return 'Received with variance';
  return (
    {
      DRAFT: 'Draft',
      ALLOCATED: 'Awaiting approval',
      APPROVED: 'Ready to dispatch',
      DISPATCHED: 'In transit',
      PARTIALLY_RECEIVED: 'Partly received',
      RECEIVED: 'Received',
      EXCEPTION: 'Short receipt open',
    }[transfer.status] ?? transfer.status
  );
}

export function transferStatusTone(
  transfer: Pick<TransferBoardRow, 'status' | 'lines'>
): TransferTone {
  if (transfer.status === 'RECEIVED')
    return transferVarianceUnits(transfer) > 0 ? 'warning' : 'success';
  if (transfer.status === 'EXCEPTION') return 'danger';
  if (transfer.status === 'DISPATCHED' || transfer.status === 'PARTIALLY_RECEIVED') return 'info';
  if (transfer.status === 'ALLOCATED' || transfer.status === 'APPROVED') return 'warning';
  return 'neutral';
}

/** Short, stable, human-readable handle for a transfer on screen and on paper. */
export function transferReference(id: string): string {
  return `TR-${id.slice(-8).toUpperCase()}`;
}

const branchLabel = (branch: TransferBoardRow['fromBranch']) =>
  [branch.name ?? 'Unknown branch', branch.city].filter(Boolean).join(' · ');

/** The allowlisted, serializable slip model handed to the client print button. */
export function packingSlipFor(transfer: TransferBoardRow): PackingSlip {
  return {
    reference: transferReference(transfer.id),
    status: transfer.status,
    fromBranch: branchLabel(transfer.fromBranch),
    toBranch: branchLabel(transfer.toBranch),
    allocatedBy: transfer.allocatedByName,
    approvedBy: transfer.approvedByName,
    dispatchedBy: transfer.dispatchedByName,
    dispatchedAt: transfer.dispatchedAt ? new Date(transfer.dispatchedAt).toISOString() : null,
    lines: transfer.lines.map((line) => ({
      medicineName: line.medicineName,
      batchNumber: line.batchNumber,
      expiresAt: new Date(line.expiresAt).toISOString(),
      sourceLocation: line.sourceLocation?.name ?? 'Unknown location',
      destinationLocation: line.destinationLocation?.name ?? 'Unknown location',
      quantityUnits: line.quantityUnits,
      sealedPacks: line.sealedPacks,
      looseUnits: line.looseUnits,
      unitsPerPack: line.unitsPerPack,
    })),
  };
}

export type TransferAction = 'submitDraft' | 'allocate' | 'approve' | 'dispatch' | 'receive';

/**
 * Domain reasons arrive as bare codes from the router. The operator gets the
 * consequence and the next step instead; an unknown message is passed through
 * rather than swallowed.
 */
export function transferErrorMessage(action: TransferAction, error: unknown): string {
  const reason = error instanceof Error ? error.message : '';
  switch (reason) {
    case 'TRANSFER_SURPLUS_CHANGED':
      return 'The source no longer has the approved surplus. Refresh and review this draft.';
    case 'TRANSFER_STOCK_CHANGED':
      return 'Source stock or destination storage changed. Refresh and review this draft.';
    case 'TRANSFER_FORBIDDEN':
      return 'Pharmacy inventory permission is required to submit this draft.';
    case 'BRANCH_NOT_AVAILABLE':
      return 'This draft requires active source and destination branches.';
    case 'COAUTH_REQUIRED':
      return action === 'approve'
        ? 'Approval needs a colleague other than the person who allocated this transfer.'
        : 'A short receipt needs a reason, an evidence reference and a different active colleague as witness.';
    case 'INSUFFICIENT_STOCK':
      return action === 'receive'
        ? 'The in-transit balance no longer covers this transfer. Refresh and review the ledger before receiving.'
        : 'Not enough available stock at the source location for this quantity.';
    case 'BLOCKED_STOCK':
      return 'This stock is recalled, quarantined or expired and cannot be dispatched.';
    case 'INVALID_UNITS':
      return 'Enter whole units for every line, no more than what is still outstanding.';
    case 'INVALID_ARRANGEMENT':
      return 'These units do not split into the sealed packs and loose units that were dispatched. Adjust the quantity.';
    case 'INVALID_STATE':
      return 'This transfer moved on since the page loaded. Refresh and try again.';
    case 'CROSS_BRANCH_REFERENCE':
    case 'CROSS_TENANT_REFERENCE':
    case 'NOT_FOUND':
      return 'That transfer, stock or location does not belong to the branch you are working in.';
    default:
      return reason || 'The transfer action could not be completed.';
  }
}
