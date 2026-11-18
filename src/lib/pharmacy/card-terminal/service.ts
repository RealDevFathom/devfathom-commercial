import 'server-only';

import { PharmacySettlementError } from '../settlement';
import type { LedgerScope } from '../stock-ledger';
import { assertNoCardholderData, CardholderDataError, redactForLog } from './cardholder-data';
import {
  PRODUCTION_TERMINAL_ADMISSION,
  terminalAdmissionRefusal,
  type CardTerminalAdapter,
  type TerminalAdmission,
  type TerminalResponse,
} from './contract';
import {
  CardTerminalError,
  PHARMACY_TERMINAL_CURRENCY,
  type CardTerminalAttempt,
  type CardTerminalAttemptPatch,
  type CardTerminalAttemptStore,
  type CardTerminalAuditDetail,
} from './store';
import { CARD_TERMINAL_TIMEOUT_MS } from './timing';

/**
 * DEV-743: drive an integrated card terminal around one durable payment-attempt record.
 *
 *   begin     the real tender guards pass, then a CREATED attempt is committed.
 *   dispatch  exactly one caller claims CREATED -> SENT, then (and only then) the terminal is
 *             asked to charge. Approved -> APPROVED -> one tender (SETTLED). Declined ->
 *             DECLINED. Timeout, error or pending -> UNKNOWN, never retried as a new charge.
 *   recover   UNKNOWN and stale SENT attempts are resolved by a status query on the same
 *             operation reference; APPROVED attempts are settled; stale CREATED attempts are
 *             closed and never sent late. Recovery that keeps failing ends in MANUAL_REVIEW.
 *   review    a manager or owner resolves MANUAL_REVIEW from the terminal slip: DECLINED
 *             (nothing was charged) or REVERSED (money was taken; it is refunded through the
 *             provider's own process). Never calls the terminal.
 *
 * Manual "received externally" Card and Wallet tenders (DEV-713) do not pass through here.
 */

export type CardTerminalDeps = {
  store: CardTerminalAttemptStore;
  adapter: CardTerminalAdapter;
  /** Tests only: a production process always uses the built-in, empty list. */
  admission?: TerminalAdmission;
  now?: () => Date;
  /** How long one terminal call may take before its outcome counts as UNKNOWN. */
  timeoutMs?: number;
  /** How long after sending a NOT_FOUND status still means "maybe". At least 2x timeout. */
  notFoundGraceMs?: number;
  /** Status queries that may stay inconclusive before a person must review the attempt. */
  maxStatusChecks?: number;
  log?: (event: string, detail: unknown) => void;
};

export type BeginCardTerminalChargeInput = {
  saleId: string;
  deviceId: string;
  terminalId: string;
  attemptKey: string;
  amountMinor: number;
  currency: string;
  businessDate: Date;
};

const DEFAULT_TIMEOUT_MS = CARD_TERMINAL_TIMEOUT_MS;
const DEFAULT_MAX_STATUS_CHECKS = 10;
const ATTEMPT_KEY = /^[A-Za-z0-9:_-]{8,128}$/;
const TERMINAL_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const PROVIDER_REF = /^[A-Za-z0-9._:/-]{1,64}$/;
const APPROVAL_CODE = /^[A-Za-z0-9]{1,16}$/;
const CODE = /^[A-Za-z0-9_.:-]{1,48}$/;
/** Settlement refusals that will not change by retrying: a person must reverse the charge. */
const PERMANENT_SETTLEMENT_REFUSALS = new Set([
  'SALE_NOT_OPEN',
  'OVER_TENDER',
  'DAY_CLOSED',
  'IDEMPOTENCY_CONFLICT',
  'UNCERTIFIED_PROVIDER',
]);

function settings(deps: CardTerminalDeps) {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new CardTerminalError('INVALID_INPUT');
  return {
    now: deps.now ?? (() => new Date()),
    timeoutMs,
    notFoundGraceMs: Math.max(deps.notFoundGraceMs ?? 2 * timeoutMs, 2 * timeoutMs),
    maxStatusChecks: Math.max(1, deps.maxStatusChecks ?? DEFAULT_MAX_STATUS_CHECKS),
    log: (event: string, detail: unknown) => deps.log?.(event, redactForLog(detail)),
  };
}

function requireAdmitted(deps: CardTerminalDeps, provider?: string) {
  if (
    terminalAdmissionRefusal(deps.adapter, deps.admission ?? PRODUCTION_TERMINAL_ADMISSION) ||
    (provider !== undefined && provider !== deps.adapter.name)
  )
    throw new CardTerminalError('UNCERTIFIED_PROVIDER');
}

async function requireAttempt(
  deps: Pick<CardTerminalDeps, 'store'>,
  scope: LedgerScope,
  attemptKey: string
) {
  const attempt = await deps.store.get(scope, attemptKey);
  if (!attempt) throw new CardTerminalError('ATTEMPT_NOT_FOUND');
  return attempt;
}

/** Commit the durable attempt. Nothing is sent to a terminal here. */
export async function beginCardTerminalCharge(
  deps: CardTerminalDeps,
  scope: LedgerScope,
  input: BeginCardTerminalChargeInput
) {
  requireAdmitted(deps);
  if (
    !ATTEMPT_KEY.test(input.attemptKey) ||
    !TERMINAL_ID.test(input.terminalId) ||
    // Settlement posts in the pharmacy currency only; see PHARMACY_TERMINAL_CURRENCY.
    input.currency !== PHARMACY_TERMINAL_CURRENCY ||
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor <= 0 ||
    !input.saleId ||
    !input.deviceId ||
    Number.isNaN(input.businessDate.getTime())
  )
    throw new CardTerminalError('INVALID_INPUT');
  try {
    assertNoCardholderData(input.terminalId);
  } catch {
    throw new CardTerminalError('INVALID_INPUT');
  }
  return deps.store.create(scope, { ...input, provider: deps.adapter.name });
}

type Timed<T> =
  { kind: 'RESULT'; value: T } | { kind: 'TIMEOUT' } | { kind: 'THREW'; error: unknown };

async function callTerminal<T>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>
): Promise<Timed<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'TIMEOUT' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      call(controller.signal).then(
        (value): Timed<T> => ({ kind: 'RESULT', value }),
        (error): Timed<T> => ({ kind: 'THREW', error })
      ),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cleanCode(code: string, fallback: string) {
  return CODE.test(code) ? code : fallback;
}

/** The next state for an attempt after a terminal answer. Exported for tests. */
export function nextAttemptPatch(
  attempt: CardTerminalAttempt,
  outcome: Timed<TerminalResponse>,
  phase: 'DISPATCH' | 'QUERY',
  context: { now: Date; notFoundGraceMs: number; maxStatusChecks: number }
): CardTerminalAttemptPatch {
  const uncertain = (): CardTerminalAttemptPatch => {
    const statusChecks = phase === 'QUERY' ? attempt.statusChecks + 1 : attempt.statusChecks;
    return statusChecks >= context.maxStatusChecks
      ? {
          status: 'MANUAL_REVIEW',
          statusChecks,
          reviewReason: `Terminal outcome still unknown after ${statusChecks} status checks`,
        }
      : { status: 'UNKNOWN', statusChecks };
  };
  if (outcome.kind !== 'RESULT') return uncertain();
  const response = outcome.value;
  switch (response.kind) {
    case 'APPROVED': {
      try {
        assertNoCardholderData(response);
      } catch (error) {
        if (!(error instanceof CardholderDataError)) throw error;
        // Nothing from this answer is stored. The charge may be real, so a person checks it.
        return {
          status: 'MANUAL_REVIEW',
          reviewReason: 'Terminal approval carried card data and was discarded',
        };
      }
      if (!PROVIDER_REF.test(response.providerRef))
        return {
          status: 'MANUAL_REVIEW',
          reviewReason: 'Terminal approval reference could not be stored',
        };
      const brand = response.cardBrand
        ?.trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_');
      const evidence = {
        providerRef: response.providerRef,
        approvalCode:
          response.approvalCode && APPROVAL_CODE.test(response.approvalCode)
            ? response.approvalCode
            : null,
        cardBrand: brand && /^[A-Z][A-Z_]{1,23}$/.test(brand) ? brand : null,
        cardLast4:
          response.cardLast4 && /^\d{4}$/.test(response.cardLast4) ? response.cardLast4 : null,
      };
      if (response.amountMinor !== attempt.amountMinor)
        return {
          status: 'MANUAL_REVIEW',
          ...evidence,
          reviewReason: 'Terminal approved a different amount',
        };
      return { status: 'APPROVED', ...evidence };
    }
    case 'DECLINED':
      return {
        status: 'DECLINED',
        declineCode: cleanCode(response.declineCode, 'DECLINED'),
        resolvedAt: context.now,
      };
    case 'ERROR':
      // Only a charge request positively refused before any card prompt is "not charged".
      if (phase === 'DISPATCH' && response.reachedTerminal === false)
        return {
          status: 'DECLINED',
          declineCode: cleanCode(`ERROR:${response.code}`, 'ERROR'),
          resolvedAt: context.now,
        };
      return uncertain();
    case 'NOT_FOUND':
      if (
        phase === 'QUERY' &&
        attempt.sentAt &&
        context.now.getTime() - attempt.sentAt.getTime() >= context.notFoundGraceMs
      )
        return { status: 'DECLINED', declineCode: 'NOT_FOUND', resolvedAt: context.now };
      return uncertain();
    case 'PENDING':
      return uncertain();
  }
}

async function record(
  deps: CardTerminalDeps,
  scope: LedgerScope,
  attempt: CardTerminalAttempt,
  patch: CardTerminalAttemptPatch
) {
  const next = await deps.store.transition(scope, attempt, patch);
  // Lost the race (for example to a recovery run): the winner's state stands.
  return next ?? requireAttempt(deps, scope, attempt.attemptKey);
}

async function settleApproved(
  deps: CardTerminalDeps,
  scope: LedgerScope,
  attempt: CardTerminalAttempt
) {
  const { log } = settings(deps);
  try {
    await deps.store.settle(scope, attempt.id);
  } catch (error) {
    log('card_terminal.settle_failed', { attemptId: attempt.id, error });
    if (error instanceof PharmacySettlementError && PERMANENT_SETTLEMENT_REFUSALS.has(error.reason))
      return record(deps, scope, attempt, {
        status: 'MANUAL_REVIEW',
        reviewReason: `Approved charge could not be recorded: ${error.reason}`,
      });
    // Anything else may pass on retry: the attempt stays APPROVED and recovery settles it.
  }
  return requireAttempt(deps, scope, attempt.attemptKey);
}

/** Send the charge for a committed attempt. Never sends the same attempt twice. */
export async function dispatchCardTerminalCharge(
  deps: CardTerminalDeps,
  scope: LedgerScope,
  attemptKey: string
) {
  const config = settings(deps);
  const attempt = await requireAttempt(deps, scope, attemptKey);
  requireAdmitted(deps, attempt.provider);
  if (attempt.status !== 'CREATED') return attempt;
  const now = config.now();
  // A crash between commit and dispatch: the cashier has moved on, so never charge late.
  if (now.getTime() - attempt.createdAt.getTime() > config.timeoutMs)
    return record(deps, scope, attempt, { status: 'ABANDONED', resolvedAt: now });
  const sent = await deps.store.transition(scope, attempt, { status: 'SENT', sentAt: now });
  if (!sent) return requireAttempt(deps, scope, attemptKey);
  const outcome = await callTerminal(config.timeoutMs, (signal) =>
    deps.adapter.startCharge(
      {
        operationRef: sent.id,
        terminalId: sent.terminalId,
        amountMinor: sent.amountMinor,
        currency: sent.currency,
      },
      signal
    )
  );
  if (outcome.kind !== 'RESULT')
    config.log('card_terminal.charge_uncertain', { attemptId: sent.id, outcome });
  const next = await record(
    deps,
    scope,
    sent,
    nextAttemptPatch(sent, outcome, 'DISPATCH', { ...config, now: config.now() })
  );
  return next.status === 'APPROVED' ? settleApproved(deps, scope, next) : next;
}

/** Commit the attempt, then send it. A replay of the same key never charges twice. */
export async function chargeCardTerminal(
  deps: CardTerminalDeps,
  scope: LedgerScope,
  input: BeginCardTerminalChargeInput
) {
  await beginCardTerminalCharge(deps, scope, input);
  return dispatchCardTerminalCharge(deps, scope, input.attemptKey);
}

/** Resolve an attempt left SENT, UNKNOWN, APPROVED or CREATED by a timeout or crash. */
export async function recoverCardTerminalAttempt(
  deps: CardTerminalDeps,
  scope: LedgerScope,
  attemptKey: string
) {
  const config = settings(deps);
  const attempt = await requireAttempt(deps, scope, attemptKey);
  requireAdmitted(deps, attempt.provider);
  const now = config.now();
  switch (attempt.status) {
    case 'CREATED':
      return now.getTime() - attempt.createdAt.getTime() > config.timeoutMs
        ? record(deps, scope, attempt, { status: 'ABANDONED', resolvedAt: now })
        : attempt;
    case 'APPROVED':
      return settleApproved(deps, scope, attempt);
    case 'SENT':
      // The dispatcher may still be waiting for the terminal.
      if (attempt.sentAt && now.getTime() - attempt.sentAt.getTime() < config.timeoutMs)
        return attempt;
      break;
    case 'UNKNOWN':
      break;
    default:
      return attempt;
  }
  const outcome = await callTerminal(config.timeoutMs, (signal) =>
    deps.adapter.queryStatus({ operationRef: attempt.id, terminalId: attempt.terminalId }, signal)
  );
  const next = await record(
    deps,
    scope,
    attempt,
    nextAttemptPatch(attempt, outcome, 'QUERY', { ...config, now: config.now() })
  );
  return next.status === 'APPROVED' ? settleApproved(deps, scope, next) : next;
}

/** Recover every open attempt of the branch, oldest first. One failure never stops the rest. */
export async function recoverOpenCardTerminalAttempts(deps: CardTerminalDeps, scope: LedgerScope) {
  const { log } = settings(deps);
  const results: CardTerminalAttempt[] = [];
  for (const attempt of await deps.store.listOpen(scope)) {
    if (attempt.status === 'MANUAL_REVIEW') {
      results.push(attempt);
      continue;
    }
    try {
      results.push(await recoverCardTerminalAttempt(deps, scope, attempt.attemptKey));
    } catch (error) {
      log('card_terminal.recover_failed', { attemptId: attempt.id, error });
      results.push(attempt);
    }
  }
  return results;
}

export type ResolveCardTerminalReviewInput = {
  attemptKey: string;
  /** DECLINED: nothing was charged. REVERSED: the terminal took the money; refund it through the provider. */
  outcome: 'DECLINED' | 'REVERSED';
  /** Why, in the resolver's own words. */
  reason: string;
  /** The provider reference printed on the terminal slip. */
  slipRef: string;
};

/**
 * Resolve an attempt waiting for review. The caller has already checked that the signed-in
 * person is a manager or owner and re-authenticated them with a fresh PIN (`approval` is that
 * evidence, kept on the audit entry). Exactly one resolution wins: a second one, even at the
 * same moment, finds the review already resolved. Once resolved the attempt no longer holds the
 * sale or its business day. Never calls the terminal, so it needs no admitted provider.
 *
 * Second person: the resolver may not resolve a charge they took themselves (the attempt's
 * `actorId`), unless `soleApprover` says no other active member could (the solo-pharmacy rule).
 */
export async function resolveCardTerminalReview(
  deps: Pick<CardTerminalDeps, 'store' | 'now'>,
  scope: LedgerScope,
  input: ResolveCardTerminalReviewInput,
  approval: CardTerminalAuditDetail,
  soleApprover: () => Promise<boolean> = async () => false
) {
  const reason = input.reason.trim();
  const slipRef = input.slipRef.trim();
  if (
    !ATTEMPT_KEY.test(input.attemptKey) ||
    (input.outcome !== 'DECLINED' && input.outcome !== 'REVERSED') ||
    reason.length < 3 ||
    reason.length > 200 ||
    !PROVIDER_REF.test(slipRef)
  )
    throw new CardTerminalError('INVALID_INPUT');
  try {
    assertNoCardholderData([reason, slipRef]);
  } catch {
    throw new CardTerminalError('INVALID_INPUT');
  }
  const attempt = await requireAttempt(deps, scope, input.attemptKey);
  if (attempt.status !== 'MANUAL_REVIEW') throw new CardTerminalError('REVIEW_NOT_OPEN');
  if (attempt.actorId === scope.actorId && !(await soleApprover()))
    throw new CardTerminalError('OWN_CHARGE_NEEDS_ANOTHER_APPROVER');
  // The terminal reported a charge reference: it cannot be recorded as "nothing was charged".
  if (input.outcome === 'DECLINED' && attempt.providerRef)
    throw new CardTerminalError('CHARGE_EVIDENCE_RECORDED');
  if (input.outcome === 'REVERSED' && attempt.providerRef && attempt.providerRef !== slipRef)
    throw new CardTerminalError('SLIP_REFERENCE_MISMATCH');
  const next = await deps.store.transition(
    scope,
    attempt,
    {
      status: input.outcome,
      resolvedById: scope.actorId,
      resolutionReason: reason,
      resolutionRef: slipRef,
      resolvedAt: (deps.now ?? (() => new Date()))(),
      // A reversal records the charge it reverses; an unknown outcome learns it from the slip.
      ...(input.outcome === 'REVERSED' && !attempt.providerRef ? { providerRef: slipRef } : {}),
    },
    approval
  );
  // Another manager resolved it first: theirs stands.
  if (!next) throw new CardTerminalError('REVIEW_NOT_OPEN');
  return next;
}
