import { TRPCError } from '@trpc/server';

const ACTION_FAILURE_MESSAGES = {
  inventory: 'The inventory action could not be completed. Review the fields and try again.',
  finance: 'The finance action could not be completed. Review the fields and try again.',
} as const;

/** Fixed copy shown when an inventory action is refused because the actor lacks inventory access. */
export const PHARMACY_INVENTORY_ACCESS_DENIED_MESSAGE =
  'You don’t have inventory access — ask an owner.';

export const PHARMACY_FINANCE_ACCESS_DENIED_MESSAGE =
  'Ask your workspace owner for finance access to view these pharmacy accounts.';

export const PHARMACY_FINANCE_MANAGE_DENIED_MESSAGE =
  'Ask your workspace owner for permission to manage pharmacy account transactions.';

type SupplierPaymentRefusalReason = 'RECORDED_BY_PAYER' | 'APPROVAL_REQUIRED';

function paymentNotice(reason: SupplierPaymentRefusalReason) {
  return reason === 'RECORDED_BY_PAYER'
    ? 'Someone else must pay an invoice you recorded.'
    : 'Enter the approving administrator’s PIN or authenticator code.';
}

export class SupplierPaymentRefusal extends TRPCError {
  constructor(readonly reason: SupplierPaymentRefusalReason) {
    super({ code: 'FORBIDDEN', message: paymentNotice(reason) });
  }
}

/** Only a refusal raised by the supplier approval policy has a public payment notice. */
export function supplierPaymentRefusalNotice(error: unknown) {
  return error instanceof SupplierPaymentRefusal ? paymentNotice(error.reason) : null;
}

/** Return user-safe copy without exposing details from an unexpected server failure. */
export function pharmacyActionErrorMessage(surface: keyof typeof ACTION_FAILURE_MESSAGES): string {
  return ACTION_FAILURE_MESSAGES[surface];
}

/**
 * True only for a tRPC FORBIDDEN rejection. Reads nothing but the error class and its
 * code, so no message, cause, or other server detail can leak through this check.
 */
export function isPharmacyActionForbidden(error: unknown): boolean {
  return error instanceof TRPCError && error.code === 'FORBIDDEN';
}
