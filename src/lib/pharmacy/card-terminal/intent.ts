import 'server-only';

import { createHash } from 'node:crypto';

import { containsPanLikeValue } from './cardholder-data';
import type { TerminalOperationKind, TerminalResponse } from './contract';

/**
 * DEV-743 — terminal operation intent and its pure state machine.
 *
 * Every terminal operation (SALE, VOID, REFUND) is an intent written BEFORE the
 * provider is called (write-ahead). The intent, not the provider call, is the unit
 * of idempotency, so a reload, a double click or a crashed request can never send a
 * second charge for the same attempt.
 *
 *   CREATED ──dispatch──▶ SENT ──▶ PENDING ──▶ APPROVED ──ledger──▶ SETTLED
 *      │                   │  │                  │
 *      │                   │  └─▶ DECLINED       └─ amount mismatch ─▶ MANUAL_REVIEW
 *      │                   └─▶ UNKNOWN ──status query──▶ APPROVED | DECLINED | FAILED
 *      └─abandon─▶ FAILED          └── attempts exhausted ──▶ MANUAL_REVIEW ──operator──▶ APPROVED | FAILED
 *
 * FAILED means "positively not charged". UNKNOWN means "we do not know", and it is
 * never retried as a new charge: only a status query or an operator with evidence
 * can resolve it.
 */

export type TerminalIntentState =
  | 'CREATED'
  | 'SENT'
  | 'PENDING'
  | 'APPROVED'
  | 'DECLINED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'MANUAL_REVIEW'
  | 'SETTLED';

export type TerminalIntentHistoryEntry = {
  from: TerminalIntentState;
  to: TerminalIntentState;
  at: string;
  cause: string;
  actorId?: string;
};

export type TerminalIntent = {
  intentRef: string;
  organizationId: string;
  branchId: string;
  saleId: string;
  kind: TerminalOperationKind;
  attemptKey: string;
  payloadHash: string;
  terminalId: string;
  providerName: string;
  amountMinor: number;
  currency: string;
  /** For VOID/REFUND: the SALE intent being reversed. */
  reversesIntentRef?: string;
  state: TerminalIntentState;
  version: number;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  createdBy: string;
  recoveryAttempts: number;
  providerRef?: string;
  approvalCode?: string;
  cardBrand?: string;
  last4?: string;
  declineCode?: string;
  failureCode?: string;
  reviewReason?: string;
  /** The settlement row this intent was recorded as: tender id (SALE) or refund id. */
  ledgerRef?: string;
  history: TerminalIntentHistoryEntry[];
};

export const TERMINAL_FINAL_STATES: ReadonlySet<TerminalIntentState> = new Set([
  'DECLINED',
  'FAILED',
  'SETTLED',
]);

/** States whose money outcome is not yet known. They block any new operation on the sale. */
export const TERMINAL_UNRESOLVED_STATES: ReadonlySet<TerminalIntentState> = new Set([
  'CREATED',
  'SENT',
  'PENDING',
  'UNKNOWN',
  'MANUAL_REVIEW',
]);

export class TerminalIntentError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_TRANSITION'
      | 'INVALID_INPUT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'ACTIVE_OPERATION_EXISTS'
      | 'APPROVED_NOT_SETTLED'
      | 'INTENT_NOT_FOUND'
      | 'CONCURRENT_UPDATE'
      | 'PROVIDER_NOT_ADMITTED'
      | 'CAPABILITY_UNSUPPORTED'
      | 'REVERSAL_BLOCKED',
    message: string = reason
  ) {
    super(message);
    this.name = 'TerminalIntentError';
  }
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PROVIDER_REF = /^[A-Za-z0-9._:/-]{1,128}$/;
const APPROVAL_CODE = /^[A-Za-z0-9]{1,12}$/;
const DECLINE_CODE = /^[A-Z0-9_]{1,40}$/;
const CARD_BRAND = /^[A-Z][A-Z0-9_]{1,23}$/;
const LAST4 = /^\d{4}$/;
const CURRENCY = /^[A-Z]{3}$/;

export function assertSafeId(value: string, field: string) {
  if (typeof value !== 'string' || !SAFE_ID.test(value))
    throw new TerminalIntentError('INVALID_INPUT', `${field} is not a safe identifier.`);
}

export function assertMinor(value: number, field = 'amountMinor') {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TerminalIntentError('INVALID_INPUT', `${field} must be a positive integer.`);
}

export function assertCurrency(value: string) {
  if (!CURRENCY.test(value))
    throw new TerminalIntentError('INVALID_INPUT', 'currency must be an ISO 4217 code.');
}

/** Deterministic intent reference: same scope, sale, kind and attempt key → same ref. */
/**
 * SHA-256 rendered with the letters a–p instead of hex digits. Stored hashes then can
 * never contain a long digit run, so the PAN value scan cannot false-positive on them.
 */
export function letterDigest(value: unknown, length = 64) {
  const hex = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let out = '';
  for (let index = 0; index < length && index < hex.length; index += 1)
    out += String.fromCharCode(97 + parseInt(hex[index]!, 16));
  return out;
}

export function terminalIntentRef(input: {
  organizationId: string;
  branchId: string;
  saleId: string;
  kind: TerminalOperationKind;
  attemptKey: string;
}) {
  const digest = letterDigest(
    [
      'pharmacy-terminal-v1',
      input.organizationId,
      input.branchId,
      input.saleId,
      input.kind,
      input.attemptKey,
    ],
    32
  );
  return `pti_${input.kind.toLowerCase()}_${digest}`;
}

export function hashTerminalPayload(value: unknown) {
  return letterDigest(value);
}

/** The idempotency key the settlement tender for an approved SALE intent must use. */
export function tenderIdempotencyKeyFor(intent: Pick<TerminalIntent, 'intentRef'>) {
  return `${intent.intentRef}:tender`;
}

/** The idempotency key the settlement refund for an approved reversal intent must use. */
export function refundIdempotencyKeyFor(intent: Pick<TerminalIntent, 'intentRef'>) {
  return `${intent.intentRef}:refund`;
}

/** A provider response, validated and narrowed. Anything malformed becomes UNKNOWN. */
export type NormalizedResponse =
  | {
      kind: 'APPROVED';
      providerRef: string;
      amountMinor: number;
      approvalCode?: string;
      cardBrand?: string;
      last4?: string;
    }
  | { kind: 'DECLINED'; declineCode: string }
  | { kind: 'PENDING' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_SENT'; code: string }
  | { kind: 'UNKNOWN'; code: string };

/**
 * Validate a provider response. A response that does not match the contract exactly
 * is uncertainty, never approval and never proof of "not charged".
 */
export function normalizeTerminalResponse(response: unknown): NormalizedResponse {
  if (!response || typeof response !== 'object')
    return { kind: 'UNKNOWN', code: 'MALFORMED_RESPONSE' };
  const r = response as Partial<TerminalResponse> & Record<string, unknown>;
  switch (r.kind) {
    case 'APPROVED': {
      const ok =
        typeof r.providerRef === 'string' &&
        PROVIDER_REF.test(r.providerRef) &&
        // A reference shaped like a card number is refused, not stored (PCI DSS 3.3).
        !containsPanLikeValue(r.providerRef) &&
        Number.isSafeInteger(r.amountMinor) &&
        (r.amountMinor as number) > 0 &&
        (r.approvalCode === undefined ||
          (typeof r.approvalCode === 'string' && APPROVAL_CODE.test(r.approvalCode))) &&
        (r.cardBrand === undefined ||
          (typeof r.cardBrand === 'string' && CARD_BRAND.test(r.cardBrand))) &&
        (r.last4 === undefined || (typeof r.last4 === 'string' && LAST4.test(r.last4)));
      if (!ok) return { kind: 'UNKNOWN', code: 'MALFORMED_APPROVAL' };
      return {
        kind: 'APPROVED',
        providerRef: r.providerRef as string,
        amountMinor: r.amountMinor as number,
        ...(r.approvalCode ? { approvalCode: r.approvalCode as string } : {}),
        ...(r.cardBrand ? { cardBrand: r.cardBrand as string } : {}),
        ...(r.last4 ? { last4: r.last4 as string } : {}),
      };
    }
    case 'DECLINED':
      return {
        kind: 'DECLINED',
        declineCode:
          typeof r.declineCode === 'string' && DECLINE_CODE.test(r.declineCode)
            ? r.declineCode
            : 'UNSPECIFIED',
      };
    case 'PENDING':
      return { kind: 'PENDING' };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'ERROR': {
      const code =
        typeof r.code === 'string' && DECLINE_CODE.test(r.code) ? r.code : 'PROVIDER_ERROR';
      return r.reachedTerminal === false ? { kind: 'NOT_SENT', code } : { kind: 'UNKNOWN', code };
    }
    default:
      return { kind: 'UNKNOWN', code: 'MALFORMED_RESPONSE' };
  }
}

function transition(
  intent: TerminalIntent,
  to: TerminalIntentState,
  at: string,
  cause: string,
  patch: Partial<TerminalIntent> = {},
  actorId?: string
): TerminalIntent {
  return {
    ...intent,
    ...patch,
    state: to,
    version: intent.version + 1,
    updatedAt: at,
    history: [
      ...intent.history,
      { from: intent.state, to, at, cause, ...(actorId ? { actorId } : {}) },
    ],
  };
}

function invalid(intent: TerminalIntent, event: string): never {
  throw new TerminalIntentError(
    'INVALID_TRANSITION',
    `Cannot apply ${event} to a ${intent.kind} intent in state ${intent.state}.`
  );
}

/** CREATED → SENT. Persisted before the provider is called. */
export function markDispatched(intent: TerminalIntent, at: string): TerminalIntent {
  if (intent.state !== 'CREATED') invalid(intent, 'dispatch');
  return transition(intent, 'SENT', at, 'DISPATCH', { sentAt: at });
}

/** CREATED → FAILED. Safe only because SENT is written before any provider call. */
export function markAbandoned(intent: TerminalIntent, at: string, cause: string): TerminalIntent {
  if (intent.state !== 'CREATED') invalid(intent, 'abandon');
  return transition(intent, 'FAILED', at, cause, { failureCode: 'NEVER_DISPATCHED' });
}

export type ApplyResponseOptions = {
  /** How the response was obtained. NOT_FOUND only counts from a status query. */
  source: 'DISPATCH' | 'STATUS';
  /** NOT_FOUND resolves to FAILED only once this long has passed since dispatch. */
  notFoundGraceMs: number;
  nowMs: number;
};

/** Apply a provider response to an in-flight intent. */
export function applyTerminalResponse(
  intent: TerminalIntent,
  response: NormalizedResponse,
  at: string,
  options: ApplyResponseOptions
): TerminalIntent {
  if (!['SENT', 'PENDING', 'UNKNOWN'].includes(intent.state)) invalid(intent, response.kind);
  switch (response.kind) {
    case 'APPROVED':
      // A partial or over approval is never settled automatically.
      if (response.amountMinor !== intent.amountMinor)
        return transition(intent, 'MANUAL_REVIEW', at, 'AMOUNT_MISMATCH', {
          providerRef: response.providerRef,
          reviewReason: `Provider approved ${response.amountMinor} for an intent of ${intent.amountMinor}.`,
        });
      return transition(intent, 'APPROVED', at, `${options.source}_APPROVED`, {
        providerRef: response.providerRef,
        approvalCode: response.approvalCode,
        cardBrand: response.cardBrand,
        last4: response.last4,
      });
    case 'DECLINED':
      return transition(intent, 'DECLINED', at, `${options.source}_DECLINED`, {
        declineCode: response.declineCode,
      });
    case 'PENDING':
      return intent.state === 'PENDING'
        ? transition(intent, 'PENDING', at, `${options.source}_STILL_PENDING`)
        : transition(intent, 'PENDING', at, `${options.source}_PENDING`);
    case 'NOT_SENT':
      // Only a dispatch can positively say the request never reached the terminal.
      if (options.source === 'DISPATCH' && intent.state === 'SENT')
        return transition(intent, 'FAILED', at, 'DISPATCH_NOT_SENT', {
          failureCode: response.code,
        });
      return transition(intent, 'UNKNOWN', at, `${options.source}_ERROR`, {
        failureCode: response.code,
      });
    case 'NOT_FOUND': {
      const sentMs = intent.sentAt ? Date.parse(intent.sentAt) : Number.NaN;
      const graceElapsed =
        Number.isFinite(sentMs) && options.nowMs - sentMs >= options.notFoundGraceMs;
      if (options.source === 'STATUS' && graceElapsed)
        return transition(intent, 'FAILED', at, 'STATUS_NOT_FOUND', {
          failureCode: 'PROVIDER_HAS_NO_RECORD',
        });
      return transition(intent, 'UNKNOWN', at, `${options.source}_NOT_FOUND_IN_GRACE`);
    }
    case 'UNKNOWN':
      return transition(intent, 'UNKNOWN', at, `${options.source}_UNKNOWN`, {
        failureCode: response.code,
      });
  }
}

/** SENT/PENDING → UNKNOWN on a timeout, abort or thrown provider error. */
export function markOutcomeUnknown(
  intent: TerminalIntent,
  at: string,
  code: string
): TerminalIntent {
  if (!['SENT', 'PENDING', 'UNKNOWN'].includes(intent.state)) invalid(intent, 'unknown');
  return transition(intent, 'UNKNOWN', at, code, { failureCode: code });
}

/** Count one recovery attempt; escalate to MANUAL_REVIEW when the budget is spent. */
export function countRecoveryAttempt(
  intent: TerminalIntent,
  at: string,
  maxAttempts: number
): TerminalIntent {
  const attempts = intent.recoveryAttempts + 1;
  const next = {
    ...intent,
    recoveryAttempts: attempts,
    version: intent.version + 1,
    updatedAt: at,
  };
  if (TERMINAL_UNRESOLVED_STATES.has(intent.state) && attempts >= maxAttempts)
    return transition(next, 'MANUAL_REVIEW', at, 'RECOVERY_EXHAUSTED', {
      reviewReason: `Outcome still unknown after ${attempts} status checks.`,
    });
  return next;
}

export type ManualResolution =
  | { outcome: 'APPROVED'; providerRef: string; amountMinor: number; approvalCode?: string }
  | { outcome: 'NOT_CHARGED' };

/**
 * MANUAL_REVIEW → APPROVED | FAILED by an operator who checked the terminal or the
 * provider portal. The reason is a short note; it is checked for card data upstream.
 */
export function resolveManually(
  intent: TerminalIntent,
  resolution: ManualResolution,
  at: string,
  actorId: string,
  reason: string
): TerminalIntent {
  if (intent.state !== 'MANUAL_REVIEW') invalid(intent, 'manual resolution');
  if (resolution.outcome === 'APPROVED') {
    if (!PROVIDER_REF.test(resolution.providerRef) || containsPanLikeValue(resolution.providerRef))
      throw new TerminalIntentError('INVALID_INPUT', 'providerRef is not a valid reference.');
    if (resolution.amountMinor !== intent.amountMinor)
      throw new TerminalIntentError(
        'INVALID_INPUT',
        'A manual approval must match the intent amount; reverse and re-take a different amount.'
      );
    if (resolution.approvalCode !== undefined && !APPROVAL_CODE.test(resolution.approvalCode))
      throw new TerminalIntentError('INVALID_INPUT', 'approvalCode is not valid.');
    return transition(
      intent,
      'APPROVED',
      at,
      `MANUAL_APPROVED: ${reason}`,
      { providerRef: resolution.providerRef, approvalCode: resolution.approvalCode },
      actorId
    );
  }
  return transition(
    intent,
    'FAILED',
    at,
    `MANUAL_NOT_CHARGED: ${reason}`,
    { failureCode: 'OPERATOR_CONFIRMED_NOT_CHARGED' },
    actorId
  );
}

/** APPROVED → SETTLED once settlement recorded the tender (SALE) or refund (VOID/REFUND). */
export function markSettled(intent: TerminalIntent, at: string, ledgerRef: string): TerminalIntent {
  if (intent.state !== 'APPROVED') invalid(intent, 'settle');
  assertSafeId(ledgerRef, 'ledgerRef');
  return transition(
    intent,
    'SETTLED',
    at,
    intent.kind === 'SALE' ? 'TENDER_RECORDED' : 'REFUND_RECORDED',
    { ledgerRef }
  );
}
