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
    await caller.pay({
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
