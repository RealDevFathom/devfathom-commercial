'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { AP_INVOICE_MAX_MINOR } from '@/lib/pharmacy/accounts/ap-invoices-schema';
import { parseMajorToMinor } from '@/lib/pharmacy/khata-payment-slip';
import { workspaceInstantFromInput } from '@/lib/timezone';
import { pharmacyApInvoicesRouter } from '@/server/routers/pharmacy-ap-invoices';
import { createTRPCContext } from '@/server/trpc';

/**
 * DEV-103: the owner records a supplier expense invoice, or a payment against
 * one, from the aging page. These actions only carry the form to the AP router,
 * which re-authorizes the owner, branch and licence and enforces every money,
 * date, period and idempotency rule inside one audited transaction.
 */
export type ApEntryFormState = { status: 'idle' | 'saved' | 'error'; message: string };

const AGING_PATH = '/pharmacy/accounts/ap-aging';

const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

function amountMinor(raw: string): number | null {
  const value = parseMajorToMinor(raw);
  return value > 0 && value <= AP_INVOICE_MAX_MINOR ? value : null;
}

const AMOUNT_HELP = 'Enter an amount above 0 and at most 9,999,999.99, with up to two decimals.';

const SHARED_REASONS: Record<string, string> = {
  PERIOD_CLOSED: 'That date falls in a closed accounting period. Nothing was saved.',
  IDEMPOTENCY_CONFLICT:
    'This form was already saved with different details. Reload the page and enter it again.',
};

const RECORD_REASONS: Record<string, string> = {
  ...SHARED_REASONS,
  DUPLICATE_REFERENCE: 'Another invoice already uses this reference. Choose a new reference.',
  DUPLICATE_INVOICE: "This payee's invoice number is already recorded and not reversed.",
  INVALID_DATE:
    'Use an invoice date no later than today and a due date on or after it, at most 10 years later.',
  INVALID_AMOUNT: AMOUNT_HELP,
  MISSING_REASON: 'Describe what the invoice was for and where its evidence is kept.',
};

const PAY_REASONS: Record<string, string> = {
  ...SHARED_REASONS,
  DUPLICATE_REFERENCE: 'Another payment already uses this reference. Choose a new reference.',
  OVERPAYMENT: 'The payment is more than the invoice still owed at that time. Nothing was saved.',
  INVALID_DATE:
    'The payment time must be on or after the invoice date and no later than now. Nothing was saved.',
  INVALID_AMOUNT: AMOUNT_HELP,
  NOT_FOUND: 'That invoice is not open for payment on this branch.',
  INVALID_STATE: 'That invoice is not open for payment on this branch.',
};

function failure(error: unknown, reasons: Record<string, string>, fallback: string) {
  unstable_rethrow(error);
  if (
    error instanceof TRPCError &&
    error.code === 'FORBIDDEN' &&
    (error.message === 'Someone else must pay an invoice you recorded.' ||
      error.message === 'Enter the approving administrator’s PIN or authenticator code.')
  )
    return { status: 'error' as const, message: error.message };
  if (error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)) {
    return {
      status: 'error' as const,
      message:
        'Only an owner with Pharmacy Finance access to this branch can record supplier expense invoices and payments.',
    };
  }
  const reason = error instanceof TRPCError ? reasons[error.message] : undefined;
  return { status: 'error' as const, message: reason ?? fallback };
}

export async function recordApInvoiceFromForm(
  _previous: ApEntryFormState,
  form: FormData
): Promise<ApEntryFormState> {
  const amount = amountMinor(field(form, 'amount'));
  if (amount === null) return { status: 'error', message: AMOUNT_HELP };
  const currency = field(form, 'currency') || 'PKR';
  if (currency !== 'PKR' && currency !== 'USD') {
    return { status: 'error', message: 'Choose PKR or USD.' };
  }
  try {
    const caller = pharmacyApInvoicesRouter.createCaller(await createTRPCContext());
    const invoice = await caller.record({
      branchId: field(form, 'branchId'),
      createKey: field(form, 'createKey'),
      reference: field(form, 'reference'),
      payeeName: field(form, 'payeeName'),
      supplierInvoiceRef: field(form, 'supplierInvoiceRef'),
      invoiceDate: field(form, 'invoiceDate'),
      dueDate: field(form, 'dueDate'),
      amountMinor: amount,
      currency,
      description: field(form, 'description'),
      evidenceReference: field(form, 'evidenceReference'),
    });
    revalidatePath(AGING_PATH);
    return {
      status: 'saved',
      message: `Invoice ${invoice.reference} recorded and posted to accounts payable.`,
    };
  } catch (error) {
    return failure(
      error,
      RECORD_REASONS,
      'The invoice was not saved. Fill in every field: references up to 80 characters, payee up to 160, description up to 500 and evidence up to 160.'
    );
  }
}

export async function payApInvoiceFromForm(
  _previous: ApEntryFormState,
  form: FormData
): Promise<ApEntryFormState> {
  const amount = amountMinor(field(form, 'amount'));
  if (amount === null) return { status: 'error', message: AMOUNT_HELP };
  const fundingAccount = field(form, 'fundingAccount');
  if (fundingAccount !== 'CASH' && fundingAccount !== 'BANK') {
    return { status: 'error', message: 'Choose whether the payment came from cash or bank.' };
  }
  const paidAtInput = field(form, 'paidAt');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(paidAtInput)) {
    return { status: 'error', message: 'Enter the date and time the payment was made.' };
  }
  const bankReference = field(form, 'bankReference');
  try {
    const ctx = await createTRPCContext();
    const caller = pharmacyApInvoicesRouter.createCaller(ctx);
    // The picker reads the workspace clock; the server receives an instant with its zone.
    const paidAt = workspaceInstantFromInput(paidAtInput, ctx.organization?.timezone);
    const pin = field(form, 'pin');
    await caller.pay({
      ...(pin ? { pin } : {}),
      branchId: field(form, 'branchId'),
      invoiceId: field(form, 'invoiceId'),
      commandKey: field(form, 'commandKey'),
      reference: field(form, 'reference'),
      amountMinor: amount,
      paidAt,
      fundingAccount,
      ...(bankReference ? { bankReference } : {}),
    });
    revalidatePath(AGING_PATH);
    return {
      status: 'saved',
      message: `Payment ${field(form, 'reference')} recorded against the invoice and posted from ${fundingAccount === 'CASH' ? 'cash' : 'bank'}.`,
    };
  } catch (error) {
    return failure(
      error,
      PAY_REASONS,
      'The payment was not saved. Choose an open invoice and enter a reference up to 80 characters and a bank reference up to 160.'
    );
  }
}

const SET_OFF_REASONS: Record<string, string> = {
  ...SHARED_REASONS,
  INVALID_AMOUNT: AMOUNT_HELP,
  SET_OFF_EXCEEDS_CREDIT:
    'That is more than is left on the credit note, counting requests already waiting. Nothing was saved.',
  SET_OFF_EXCEEDS_BILL:
    'That is more than the bill still owes, counting requests already waiting. Nothing was saved.',
  SUPPLIER_MISMATCH: "The credit note's supplier is not this bill's payee. Choose a matching bill.",
  INVALID_STATE: 'Only an open PKR bill on this branch can take a credit note.',
  NOT_FOUND: 'That bill or credit note is not on this branch.',
  ALREADY_DECIDED: 'This set-off was already approved or rejected. Reload the page.',
  INVALID_DATE: 'The bill is dated later than today, so it cannot be set off yet.',
  ALREADY_REVERSED: 'This set-off was already reversed. Reload the page.',
  PERIOD_CLOSED: 'Today falls in a closed accounting period. Nothing was changed.',
};

/**
 * DEV-694: staff choose the bill a supplier credit note is set off against.
 * This only records the request; the router re-checks every money rule.
 */
export async function requestCreditSetOffFromForm(
  _previous: ApEntryFormState,
  form: FormData
): Promise<ApEntryFormState> {
  const amount = amountMinor(field(form, 'amount'));
  if (amount === null) return { status: 'error', message: AMOUNT_HELP };
  const note = field(form, 'note');
  try {
    const caller = pharmacyApInvoicesRouter.createCaller(await createTRPCContext());
    await caller.requestCreditSetOff({
      branchId: field(form, 'branchId'),
      invoiceId: field(form, 'invoiceId'),
      supplierCreditId: field(form, 'supplierCreditId'),
      requestKey: field(form, 'requestKey'),
      amountMinor: amount,
      ...(note ? { note } : {}),
    });
    revalidatePath(AGING_PATH);
    return {
      status: 'saved',
      message: 'Set-off requested. The bill is unchanged until a manager approves it.',
    };
  } catch (error) {
    return failure(
      error,
      SET_OFF_REASONS,
      'The set-off was not requested. Choose a bill and a credit note, and keep the note under 500 characters.'
    );
  }
}

/** DEV-694: a manager or owner approves with their own PIN; only then does the payable fall. */
export async function approveCreditSetOffFromForm(
  _previous: ApEntryFormState,
  form: FormData
): Promise<ApEntryFormState> {
  // The PIN is passed through once and never stored or echoed back.
  const pin = String(form.get('pin') ?? '');
  if (!/^\d{4,8}$/.test(pin)) {
    return { status: 'error', message: 'Enter your 4 to 8 digit manager or owner PIN.' };
  }
  try {
    const caller = pharmacyApInvoicesRouter.createCaller(await createTRPCContext());
    await caller.approveCreditSetOff({
      branchId: field(form, 'branchId'),
      setOffId: field(form, 'setOffId'),
      decisionKey: field(form, 'decisionKey'),
      pin,
    });
    revalidatePath(AGING_PATH);
    return { status: 'saved', message: 'Set-off approved. The bill now owes that much less.' };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') {
      return { status: 'error', message: error.message };
    }
    return failure(error, SET_OFF_REASONS, 'The set-off was not approved. Reload and try again.');
  }
}

export async function rejectCreditSetOffFromForm(
  _previous: ApEntryFormState,
  form: FormData
): Promise<ApEntryFormState> {
  const reason = field(form, 'reason');
  if (!reason) return { status: 'error', message: 'Say why the set-off is rejected.' };
  try {
    const caller = pharmacyApInvoicesRouter.createCaller(await createTRPCContext());
    await caller.rejectCreditSetOff({
      branchId: field(form, 'branchId'),
      setOffId: field(form, 'setOffId'),
      decisionKey: field(form, 'decisionKey'),
      reason,
    });
    revalidatePath(AGING_PATH);
    return { status: 'saved', message: 'Set-off rejected. No money moved.' };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') {
      return { status: 'error', message: error.message };
    }
    return failure(error, SET_OFF_REASONS, 'The set-off was not rejected. Reload and try again.');
  }
}

/**
 * DEV-694: a manager or owner undoes an approved set-off with their own PIN and
 * a reason. The router posts the mirror entry; the bill owes the amount again.
 */
export async function reverseCreditSetOffFromForm(
  _previous: ApEntryFormState,
  form: FormData
): Promise<ApEntryFormState> {
  // The PIN is passed through once and never stored or echoed back.
  const pin = String(form.get('pin') ?? '');
  if (!/^\d{4,8}$/.test(pin)) {
    return { status: 'error', message: 'Enter your 4 to 8 digit manager or owner PIN.' };
  }
  const reason = field(form, 'reason');
  if (!reason) return { status: 'error', message: 'Say why the set-off is reversed.' };
  try {
    const caller = pharmacyApInvoicesRouter.createCaller(await createTRPCContext());
    await caller.reverseCreditSetOff({
      branchId: field(form, 'branchId'),
      setOffId: field(form, 'setOffId'),
      commandKey: field(form, 'commandKey'),
      reason,
      pin,
    });
    revalidatePath(AGING_PATH);
    return {
      status: 'saved',
      message: 'Set-off reversed. The bill owes that amount again and the credit note has it back.',
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') {
      return { status: 'error', message: error.message };
    }
    return failure(error, SET_OFF_REASONS, 'The set-off was not reversed. Reload and try again.');
  }
}

const REVERSAL_REASONS: Record<string, string> = {
  ...SHARED_REASONS,
  PERIOD_CLOSED: 'Today falls in a closed accounting period. Nothing was reversed.',
  ALREADY_REVERSED: 'This was already reversed. Reload the page.',
  ACTIVE_SETTLEMENTS:
    'Reverse every payment and approved credit set-off against this invoice first. Nothing was reversed.',
  INVALID_DATE:
    'A reversal cannot be dated before the entry it reverses or its payments. Nothing was reversed.',
  NOT_FOUND: 'That entry is not on this branch. Reload the page.',
  INVALID_STATE: 'That entry cannot be reversed here. Reload the page.',
  MISSING_REASON: 'Say why it is being reversed.',
};

/**
 * DEV-103: a manager or owner reverses a supplier expense invoice, or a payment against one,
 * with their own PIN and a reason. The router checks the PIN, who recorded it and every money
 * rule, posts the mirror entry and keeps the original; the server dates the reversal now.
 */
async function reverseFromForm(
  form: FormData,
  kind: 'invoice' | 'payment'
): Promise<ApEntryFormState> {
  // The PIN is passed through once and never stored or echoed back.
  const pin = String(form.get('pin') ?? '');
  if (!/^\d{4,8}$/.test(pin)) {
    return { status: 'error', message: 'Enter your 4 to 8 digit manager or owner PIN.' };
  }
  const reason = field(form, 'reason');
  if (!reason) return { status: 'error', message: REVERSAL_REASONS.MISSING_REASON! };
  const common = {
    branchId: field(form, 'branchId'),
    commandKey: field(form, 'commandKey'),
    reason,
    pin,
  };
  try {
    const caller = pharmacyApInvoicesRouter.createCaller(await createTRPCContext());
    if (kind === 'invoice') {
      const invoice = await caller.reverseInvoice({
        ...common,
        invoiceId: field(form, 'invoiceId'),
      });
      revalidatePath(AGING_PATH);
      return {
        status: 'saved',
        message: `Invoice ${invoice.reference} reversed. The original stays on record with a mirror entry, and it no longer counts as owed.`,
      };
    }
    await caller.reverseSettlement({ ...common, settlementId: field(form, 'settlementId') });
    revalidatePath(AGING_PATH);
    return {
      status: 'saved',
      message:
        'Payment reversed. The original stays on record with a mirror entry, and the invoice owes that amount again.',
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') {
      return { status: 'error', message: error.message };
    }
    return failure(
      error,
      REVERSAL_REASONS,
      `The ${kind} was not reversed. Keep the reason under 500 characters, reload and try again.`
    );
  }
}

export async function reverseApInvoiceFromForm(
  _previous: ApEntryFormState,
  form: FormData
): Promise<ApEntryFormState> {
  return reverseFromForm(form, 'invoice');
}

export async function reverseApSettlementFromForm(
  _previous: ApEntryFormState,
  form: FormData
): Promise<ApEntryFormState> {
  return reverseFromForm(form, 'payment');
}
