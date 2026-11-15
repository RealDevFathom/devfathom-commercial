import { z } from '@/lib/zod-csp';
import type { inferRouterInputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import {
  isManualTender,
  MANUAL_CARD_APPROVAL_CODE,
  MANUAL_CARD_REFERENCE,
  manualCardCaptureSchema,
  manualTenderCaptureSchema,
} from '@/lib/pharmacy/manual-payments';

export type TenderAttemptInput = inferRouterInputs<AppRouter>['pharmacySales']['tenderOutcome'];
export type TenderAttemptScope = { organizationId: string; accountId: string; branchId: string };
export type TenderDraft = { amount: string; cashReceived: string };
export type TenderAttempt = {
  version: 1;
  scope: TenderAttemptScope;
  input: TenderAttemptInput;
  draft: TenderDraft;
};

const id = z.string().trim().min(1).max(128);
const scopeSchema = z.object({ organizationId: id, accountId: id, branchId: id }).strict();
const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amountText = z
  .string()
  .max(32)
  .regex(/^\s*(?:\d{1,12}(?:\.\d{1,2})?)?\s*$/);
const storedSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    input: z
      .object({
        branchId: id,
        saleId: id,
        deviceId: id,
        businessDate: z.string().datetime({ offset: false }),
        type: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET', 'CREDIT', 'KHATA', 'RAAST', 'JAZZCASH', 'EASYPAISA']),
        amountMinor: minor.positive(),
        cashReceivedMinor: minor.optional(),
        idempotencyKey: z.string().trim().min(1).max(160),
        familyAccountId: id.optional(),
        ownerOverride: z.boolean().optional(),
        providerRef: z.string().regex(MANUAL_CARD_REFERENCE).optional(),
        payerName: z.string().trim().min(1).max(100).optional(),
        referenceSkipped: z.boolean().optional(),
        approvalCode: z.string().regex(MANUAL_CARD_APPROVAL_CODE).optional(),
        buyerName: z.string().trim().min(1).max(100).optional(),
      })
      .strict(),
    draft: z.object({ amount: amountText, cashReceived: amountText }).strict(),
  })
  .strict();

export const TENDER_STORAGE_MESSAGE =
  'Payment recovery storage is unavailable or unreadable. No new payment can be sent. Keep this browser data and ask a supervisor for help; do not clear it to retry payment.';

// The existing counter device uses localStorage. The offline terminal document
// is device-bound, has no account scope, and permits replay/discard: it cannot
// hold an online uncertain tender. This record has no queue, expiry or replay.
export function tenderAttemptStorageKey(scope: TenderAttemptScope): string {
  const parsed = scopeSchema.parse(scope);
  return `devfathom.pharmacy.counter.attempt:${JSON.stringify([
    parsed.organizationId,
    parsed.accountId,
    parsed.branchId,
  ])}`;
}

function sameScope(a: TenderAttemptScope, b: TenderAttemptScope): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.accountId === b.accountId &&
    a.branchId === b.branchId
  );
}

function textMinor(value: string): number | null {
  if (!value.trim()) return null;
  const [major, fraction = ''] = value.trim().split('.');
  return Number(major) * 100 + Number(fraction.padEnd(2, '0'));
}

function decode(raw: string, scope: TenderAttemptScope): TenderAttempt {
  if (raw.length > 4096) throw new Error(TENDER_STORAGE_MESSAGE);
  const stored = storedSchema.parse(JSON.parse(raw));
  const input = stored.input;
  const date = new Date(input.businessDate);
  if (isManualTender(input.type)) {
    if (input.approvalCode !== undefined) throw new Error(TENDER_STORAGE_MESSAGE);
    manualTenderCaptureSchema.parse({ type: input.type, providerRef: input.providerRef,
      payerName: input.payerName, referenceSkipped: input.referenceSkipped });
  } else if (input.type === 'CARD' && input.approvalCode !== undefined) {
    if (input.payerName !== undefined || input.referenceSkipped !== undefined)
      throw new Error(TENDER_STORAGE_MESSAGE);
    manualCardCaptureSchema.parse({ providerRef: input.providerRef, approvalCode: input.approvalCode });
  } else if (input.approvalCode !== undefined || input.providerRef !== undefined || input.payerName !== undefined || input.referenceSkipped !== undefined) {
    throw new Error(TENDER_STORAGE_MESSAGE);
  }
  if (
    (input.type === 'KHATA' && !input.familyAccountId) ||
    ((input.familyAccountId !== undefined || input.ownerOverride !== undefined) &&
      !['KHATA', 'CREDIT'].includes(input.type)) ||
    !sameScope(stored.scope, scope) ||
    input.branchId !== scope.branchId ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== input.businessDate ||
    (stored.draft.amount.trim() && textMinor(stored.draft.amount) !== input.amountMinor) ||
    (input.type === 'CASH' &&
      textMinor(stored.draft.cashReceived) !== (input.cashReceivedMinor ?? null)) ||
    (input.type !== 'CASH' &&
      (input.cashReceivedMinor !== undefined || stored.draft.cashReceived !== '')) ||
    (input.cashReceivedMinor !== undefined && input.cashReceivedMinor < input.amountMinor)
  ) {
    throw new Error(TENDER_STORAGE_MESSAGE);
  }
  return { ...stored, input: { ...input, businessDate: date } };
}

export type TenderAttemptRead =
  { status: 'empty' } | { status: 'pending'; attempt: TenderAttempt } | { status: 'blocked' };

export function readTenderAttempt(scope: TenderAttemptScope): TenderAttemptRead {
  try {
    // Read exactly the authenticated scope's key; never enumerate other accounts.
    const raw = window.localStorage.getItem(tenderAttemptStorageKey(scope));
    return raw === null ? { status: 'empty' } : { status: 'pending', attempt: decode(raw, scope) };
  } catch {
    return { status: 'blocked' };
  }
}

export function persistTenderAttempt(attempt: TenderAttempt): void {
  const raw = JSON.stringify(attempt);
  decode(raw, attempt.scope); // Strict allowlist rejects extra/private fields before writing.
  const key = tenderAttemptStorageKey(attempt.scope);
  if (window.localStorage.getItem(key) !== null) throw new Error(TENDER_STORAGE_MESSAGE);
  window.localStorage.setItem(key, raw);
  if (window.localStorage.getItem(key) !== raw) throw new Error(TENDER_STORAGE_MESSAGE);
}

/** Only call after server acceptance or a proven transactional rejection. */
export function clearTenderAttempt(attempt: TenderAttempt): void {
  const key = tenderAttemptStorageKey(attempt.scope);
  const raw = window.localStorage.getItem(key);
  if (raw !== null && JSON.stringify(decode(raw, attempt.scope)) !== JSON.stringify(attempt)) {
    throw new Error(TENDER_STORAGE_MESSAGE);
  }
  window.localStorage.removeItem(key);
  if (window.localStorage.getItem(key) !== null) throw new Error(TENDER_STORAGE_MESSAGE);
}
