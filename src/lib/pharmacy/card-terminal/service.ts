import 'server-only';

import { randomUUID } from 'node:crypto';

import type { PharmacyPaymentAdapter } from '../settlement';
import { assertNoCardholderData, CardholderDataError, redactForLog } from './cardholder-data';
import {
  PRODUCTION_TERMINAL_ADMISSION,
  providerSupports,
  terminalAdmissionRefusal,
  type CardTerminalProvider,
  type TerminalAdmission,
  type TerminalOperationKind,
} from './contract';
import {
  adoptLedgerRow,
  applyTerminalResponse,
  assertCurrency,
  assertMinor,
  assertSafeId,
  claimHandoff,
  countRecoveryAttempt,
  escalateLateApproval,
  hashTerminalPayload,
  markAbandoned,
  markDispatched,
  markOutcomeUnknown,
  markSettled,
  normalizeTerminalResponse,
  refundIdempotencyKeyFor,
  releaseHandoff,
  reopenForSettlement,
  resolveManually,
  tenderIdempotencyKeyFor,
  terminalIntentRef,
  TerminalIntentError,
  TERMINAL_UNRESOLVED_STATES,
  type ManualResolution,
  type NormalizedResponse,
  type TerminalIntent,
} from './intent';
import { planTerminalReversal, type ReversalPlan } from './reversal';
import type { TerminalIntentStore } from './store';

/**
 * DEV-743 — the card-terminal orchestration service.
 *
 * Owns dispatch, timeout, recovery, manual review and the hand-off to settlement.
 * It never moves money by itself: it calls an injected `CardTerminalProvider`, and
 * no real provider is admitted (see contract.ts). It never writes tenders or
 * refunds: settlement (`applyPharmacyTender` / `refundPharmacyTender`) does that,
 * through settlement-handoff.ts, fed by `settlementAdapter`, which replays an
 * already-approved outcome once instead of charging again.
 *
 * Duplicate-charge rules:
 *  1. Same attempt key → same intent. A replay never re-dispatches once SENT, and a
 *     CREATED row left by a crash is closed instead of dispatched late.
 *  2. One open operation per sale. A second attempt is refused while another is
 *     unresolved or approved-but-not-settled.
 *  3. A timeout is UNKNOWN, not FAILED. UNKNOWN is resolved by status query or an
 *     operator with evidence, never by charging again.
 *  4. SENT is persisted before the provider is called (write-ahead), and only one
 *     writer wins the CREATED → SENT compare-and-set.
 *  5. An approval that arrives after the intent was closed reopens it for review.
 *  6. One approval becomes at most one tender or refund (single hand-off claim).
 */

export type TerminalLocation = { organizationId: string; branchId: string };
export type TerminalScope = TerminalLocation & { actorId: string };

export type TerminalLogEntry = {
  event: string;
  intentRef?: string;
  state?: string;
  [field: string]: unknown;
};

export type CardTerminalServiceOptions = {
  store: TerminalIntentStore;
  provider: CardTerminalProvider;
  /** Tests only. Ignored in a production process (see `terminalAdmissionRefusal`). */
  admission?: TerminalAdmission;
  /** Tests only. Ignored in a production process. */
  environment?: string;
  now?: () => Date;
  /** Upper bound for one provider call. Past it the outcome is UNKNOWN. */
  timeoutMs: number;
  recovery: {
    /** Status checks before the intent escalates to MANUAL_REVIEW. */
    maxAttempts: number;
    /**
     * A NOT_FOUND status only proves "not charged" after this long since dispatch.
     * Must be at least twice `timeoutMs`, so the dispatch call has surely ended.
     */
    notFoundGraceMs: number;
  };
  /**
   * How long a settlement hand-off claim is held before another settlement may take it
   * over. Must exceed the longest money transaction. Default 10 minutes.
   */
  handoffLeaseMs?: number;
  /** Receives redacted, structured entries only. */
  logger?: (entry: TerminalLogEntry) => void;
};

type CallResult =
  | { ok: true; response: NormalizedResponse }
  | { ok: false; code: 'PROVIDER_TIMEOUT' | 'PROVIDER_THREW' };

async function callProvider(
  timeoutMs: number,
  call: (signal: AbortSignal) => unknown
): Promise<CallResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CallResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, code: 'PROVIDER_TIMEOUT' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      // Promise.resolve().then also catches a provider that throws synchronously.
      Promise.resolve()
        .then(() => call(controller.signal))
        .then(
          (response): CallResult => ({ ok: true, response: normalizeTerminalResponse(response) }),
          (): CallResult => ({ ok: false, code: 'PROVIDER_THREW' })
        ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type ReversalInput = { amountMinor: number; batchOpen: boolean; ledgerRefundedMinor: number };

export function createCardTerminalService(options: CardTerminalServiceOptions) {
  const {
    store,
    provider,
    admission = PRODUCTION_TERMINAL_ADMISSION,
    environment = process.env.NODE_ENV,
    now = () => new Date(),
    timeoutMs,
    recovery,
  } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new TerminalIntentError('INVALID_INPUT', 'timeoutMs must be a positive integer.');
  if (!Number.isSafeInteger(recovery.maxAttempts) || recovery.maxAttempts <= 0)
    throw new TerminalIntentError('INVALID_INPUT', 'recovery.maxAttempts must be positive.');
  if (!Number.isSafeInteger(recovery.notFoundGraceMs) || recovery.notFoundGraceMs < 2 * timeoutMs)
    throw new TerminalIntentError(
      'INVALID_INPUT',
      'recovery.notFoundGraceMs must be at least twice timeoutMs.'
    );
  /** Past this age a SENT intent's dispatch call has certainly finished. */
  const inFlightMs = 2 * timeoutMs;
  const handoffLeaseMs = options.handoffLeaseMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(handoffLeaseMs) || handoffLeaseMs < 2 * timeoutMs)
    throw new TerminalIntentError(
      'INVALID_INPUT',
      'handoffLeaseMs must be at least twice timeoutMs.'
    );

  function log(entry: TerminalLogEntry) {
    if (!options.logger) return;
    try {
      options.logger(redactForLog(entry) as TerminalLogEntry);
    } catch {
      // Logging must never change a payment outcome.
    }
  }

  function admitted() {
    return terminalAdmissionRefusal(provider, admission, environment) === null;
  }

  function requireAdmitted() {
    const refusal = terminalAdmissionRefusal(provider, admission, environment);
    if (refusal)
      throw new TerminalIntentError(
        'PROVIDER_NOT_ADMITTED',
        `Card terminal provider ${provider.name} is not admitted (${refusal}).`
      );
  }

  function validateLocation(location: TerminalLocation) {
    assertSafeId(location.organizationId, 'organizationId');
    assertSafeId(location.branchId, 'branchId');
  }

  function validateScope(scope: TerminalScope) {
    validateLocation(scope);
    assertSafeId(scope.actorId, 'actorId');
  }

  /** Persist a transition. Card data is refused before anything is written. */
  async function save(previous: TerminalIntent, next: TerminalIntent) {
    assertNoCardholderData(next);
    const ok = await store.compareAndSet(previous.version, next);
    if (!ok) throw new TerminalIntentError('CONCURRENT_UPDATE');
    log({ event: 'terminal.transition', intentRef: next.intentRef, state: next.state });
    return next;
  }

  /** Load an intent, scoped to the caller's organization and branch. */
  async function load(location: TerminalLocation, intentRef: string) {
    const intent = await store.get(location.organizationId, intentRef);
    if (
      !intent ||
      intent.organizationId !== location.organizationId ||
      intent.branchId !== location.branchId
    )
      throw new TerminalIntentError('INTENT_NOT_FOUND');
    return intent;
  }

  /** Save, or return the stored row if another writer got there first. */
  async function saveOrReload(previous: TerminalIntent, next: TerminalIntent) {
    try {
      return await save(previous, next);
    } catch (error) {
      if (error instanceof TerminalIntentError && error.reason === 'CONCURRENT_UPDATE')
        return load(previous, previous.intentRef);
      throw error;
    }
  }

  /** A CREATED intent this old was left behind by a crash; it is never dispatched. */
  function staleCreated(intent: TerminalIntent) {
    return (
      intent.state === 'CREATED' && now().getTime() - Date.parse(intent.createdAt) >= timeoutMs
    );
  }

  async function dispatch(intent: TerminalIntent, priorProviderRef?: string) {
    const at = now().toISOString();
    const sent = markDispatched(intent, at);
    assertNoCardholderData(sent);
    // Only the writer that wins CREATED → SENT may call the provider.
    if (!(await store.compareAndSet(intent.version, sent))) {
      log({ event: 'terminal.dispatch_lost_race', intentRef: intent.intentRef });
      return load(intent, intent.intentRef);
    }
    log({ event: 'terminal.dispatch', intentRef: sent.intentRef, kind: sent.kind });
    const request = {
      operationRef: sent.intentRef,
      terminalId: sent.terminalId,
      amountMinor: sent.amountMinor,
      currency: sent.currency,
    };
    const result = await callProvider(timeoutMs, (signal) => {
      if (sent.kind === 'SALE') return provider.startSale(request, signal);
      const reversal = { ...request, priorProviderRef: priorProviderRef! };
      return sent.kind === 'VOID'
        ? provider.voidSale!(reversal, signal)
        : provider.refundSale!(reversal, signal);
    });
    const doneAt = now();
    const next = result.ok
      ? applyTerminalResponse(sent, result.response, doneAt.toISOString(), {
          source: 'DISPATCH',
          notFoundGraceMs: recovery.notFoundGraceMs,
          nowMs: doneAt.getTime(),
        })
      : markOutcomeUnknown(sent, doneAt.toISOString(), result.code);
    try {
      return await save(sent, next);
    } catch (error) {
      if (!(error instanceof TerminalIntentError && error.reason === 'CONCURRENT_UPDATE'))
        throw error;
    }
    // A recovery sweep recorded an outcome while this call was in flight.
    log({ event: 'terminal.dispatch_result_superseded', intentRef: sent.intentRef });
    const current = await load(sent, sent.intentRef);
    if (!result.ok) return current;
    const response = result.response;
    const lateCharge =
      response.kind === 'APPROVED' ||
      (response.kind === 'UNKNOWN' && response.code === 'MALFORMED_APPROVAL');
    if (!lateCharge) return current;
    const lateAt = now();
    // The provider approved an operation already closed as FAILED/DECLINED: never let
    // that charge disappear. Block the sale again and send it to a person.
    if (
      current.state === 'FAILED' ||
      current.state === 'DECLINED' ||
      current.state === 'MANUAL_REVIEW'
    )
      return saveOrReload(
        current,
        escalateLateApproval(
          current,
          lateAt.toISOString(),
          'LATE_DISPATCH_APPROVAL',
          response.kind === 'APPROVED' ? response.providerRef : undefined
        )
      );
    if (['SENT', 'PENDING', 'UNKNOWN'].includes(current.state))
      return saveOrReload(
        current,
        applyTerminalResponse(current, response, lateAt.toISOString(), {
          source: 'DISPATCH',
          notFoundGraceMs: recovery.notFoundGraceMs,
          nowMs: lateAt.getTime(),
        })
      );
    return current;
  }

  async function planReversal(
    location: TerminalLocation,
    saleIntentRef: string,
    input: ReversalInput,
    excludeIntentRef?: string
  ): Promise<ReversalPlan> {
    validateLocation(location);
    const saleIntent = await load(location, saleIntentRef);
    const related = await store.listForSale(location.organizationId, saleIntent.saleId);
    return planTerminalReversal({
      saleIntent,
      reversals: related.filter(
        (row) =>
          row.reversesIntentRef === saleIntent.intentRef && row.intentRef !== excludeIntentRef
      ),
      requestedMinor: input.amountMinor,
      ledgerRefundedMinor: input.ledgerRefundedMinor,
      batchOpen: input.batchOpen,
      supportsVoid: providerSupports(provider, 'VOID'),
      supportsRefund: providerSupports(provider, 'REFUND'),
    });
  }

  async function createIntent(
    scope: TerminalScope,
    input: {
      saleId: string;
      kind: TerminalOperationKind;
      attemptKey: string;
      terminalId: string;
      amountMinor: number;
      currency: string;
      reversesIntentRef?: string;
    }
  ) {
    const identity = {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: input.saleId,
      kind: input.kind,
      attemptKey: input.attemptKey,
    };
    const at = now().toISOString();
    const candidate: TerminalIntent = {
      intentRef: terminalIntentRef(identity),
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: input.saleId,
      kind: input.kind,
      attemptKey: input.attemptKey,
      payloadHash: hashTerminalPayload({
        ...identity,
        terminalId: input.terminalId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        provider: provider.name,
        reversesIntentRef: input.reversesIntentRef ?? null,
      }),
      terminalId: input.terminalId,
      providerName: provider.name,
      amountMinor: input.amountMinor,
      currency: input.currency,
      ...(input.reversesIntentRef ? { reversesIntentRef: input.reversesIntentRef } : {}),
      state: 'CREATED',
      version: 1,
      createdAt: at,
      updatedAt: at,
      createdBy: scope.actorId,
      recoveryAttempts: 0,
      history: [],
    };
    assertNoCardholderData(candidate);
    const created = await store.createOrGet(candidate);
    if (created.status === 'BLOCKED') {
      log({
        event: 'terminal.blocked',
        intentRef: candidate.intentRef,
        blockingIntentRef: created.blocking.intentRef,
        blockingState: created.blocking.state,
      });
      throw new TerminalIntentError(
        created.blocking.state === 'APPROVED' ? 'APPROVED_NOT_SETTLED' : 'ACTIVE_OPERATION_EXISTS',
        `Sale ${input.saleId} already has ${created.blocking.kind} ${created.blocking.intentRef} in state ${created.blocking.state}.`
      );
    }
    if (created.status === 'EXISTING' && created.intent.payloadHash !== candidate.payloadHash)
      throw new TerminalIntentError('IDEMPOTENCY_CONFLICT');
    return created;
  }

  /** Dispatch a freshly created intent, or close a CREATED one a crash left behind. */
  async function dispatchOrClose(
    created: Awaited<ReturnType<typeof createIntent>>,
    priorProviderRef?: string
  ) {
    if (created.status === 'EXISTING' && created.intent.state !== 'CREATED') {
      log({ event: 'terminal.replay', intentRef: created.intent.intentRef });
      return created.intent;
    }
    // A CREATED row left by a crash is closed, not charged late: the sale may have been
    // paid another way since. The cashier starts a new attempt.
    if (created.status === 'EXISTING' && staleCreated(created.intent))
      return saveOrReload(
        created.intent,
        markAbandoned(created.intent, now().toISOString(), 'STALE_CREATED_REPLAY')
      );
    return dispatch(created.intent, priorProviderRef);
  }

  return {
    /** True only when this provider may move real money. Always false in production today. */
    get providerAdmitted() {
      return admitted();
    },

    /**
     * Start (or replay) a terminal SALE. Returns the intent in its current state.
     * A replay of a dispatched attempt returns that attempt; it never charges twice.
     */
    async startSale(
      scope: TerminalScope,
      input: {
        saleId: string;
        terminalId: string;
        amountMinor: number;
        currency: string;
        attemptKey: string;
      }
    ): Promise<TerminalIntent> {
      validateScope(scope);
      assertSafeId(input.saleId, 'saleId');
      assertSafeId(input.terminalId, 'terminalId');
      assertSafeId(input.attemptKey, 'attemptKey');
      assertMinor(input.amountMinor);
      assertCurrency(input.currency);
      requireAdmitted();
      if (!providerSupports(provider, 'SALE'))
        throw new TerminalIntentError('CAPABILITY_UNSUPPORTED', 'Provider cannot take a sale.');
      return dispatchOrClose(await createIntent(scope, { ...input, kind: 'SALE' }));
    },

    /** Read one intent, scoped to organization and branch. */
    async getIntent(location: TerminalLocation, intentRef: string) {
      validateLocation(location);
      return load(location, intentRef);
    },

    /**
     * Resolve an in-flight intent by asking the provider. Safe to call repeatedly
     * (from the counter after a reload, or from a background sweep).
     */
    async recover(location: TerminalLocation, intentRef: string): Promise<TerminalIntent> {
      validateLocation(location);
      const intent = await load(location, intentRef);
      if (intent.state === 'CREATED') {
        // SENT is written before any provider call, so CREATED was never dispatched.
        // A fresh one may be about to dispatch; only a stale one is closed.
        if (!staleCreated(intent)) return intent;
        return saveOrReload(
          intent,
          markAbandoned(intent, now().toISOString(), 'RECOVERY_NEVER_SENT')
        );
      }
      if (!['SENT', 'PENDING', 'UNKNOWN'].includes(intent.state)) return intent;
      // A SENT intent may still be waiting on its dispatch call; leave it alone.
      if (
        intent.state === 'SENT' &&
        intent.sentAt &&
        now().getTime() - Date.parse(intent.sentAt) < inFlightMs
      )
        return intent;
      if (!providerSupports(provider, 'STATUS'))
        return save(intent, countRecoveryAttempt(intent, now().toISOString(), 1));
      const result = await callProvider(timeoutMs, (signal) =>
        provider.queryStatus(
          { operationRef: intent.intentRef, terminalId: intent.terminalId, kind: intent.kind },
          signal
        )
      );
      const doneAt = now();
      const answered = result.ok
        ? applyTerminalResponse(intent, result.response, doneAt.toISOString(), {
            source: 'STATUS',
            notFoundGraceMs: recovery.notFoundGraceMs,
            nowMs: doneAt.getTime(),
          })
        : markOutcomeUnknown(intent, doneAt.toISOString(), result.code);
      const counted = countRecoveryAttempt(answered, doneAt.toISOString(), recovery.maxAttempts);
      return save(intent, counted);
    },

    /** List intents a branch still has to resolve (for a sweep or the day-close gate). */
    async unresolved(location: TerminalLocation) {
      validateLocation(location);
      return store.listUnresolved(location.organizationId, location.branchId);
    },

    /** Operator decision for an intent in MANUAL_REVIEW. */
    async resolveManually(
      scope: TerminalScope,
      intentRef: string,
      resolution: ManualResolution,
      reason: string
    ): Promise<TerminalIntent> {
      validateScope(scope);
      const note = reason.trim();
      if (note.length < 3 || note.length > 200)
        throw new TerminalIntentError(
          'INVALID_INPUT',
          'A short reason (3–200 characters) is required.'
        );
      try {
        assertNoCardholderData({ note, resolution });
      } catch (error) {
        if (error instanceof CardholderDataError)
          throw new TerminalIntentError('INVALID_INPUT', 'Remove card numbers from the note.');
        throw error;
      }
      const intent = await load(scope, intentRef);
      return save(
        intent,
        resolveManually(intent, resolution, now().toISOString(), scope.actorId, note)
      );
    },

    /**
     * Mark an APPROVED intent as recorded in settlement. Only the hand-off that holds
     * the claim may do this (settlement-handoff.ts passes the ledger row it got back).
     */
    async recordSettlement(
      location: TerminalLocation,
      intentRef: string,
      ledgerRef: string,
      claimToken: string
    ) {
      validateLocation(location);
      const intent = await load(location, intentRef);
      if (intent.state === 'SETTLED' && intent.ledgerRef === ledgerRef) return intent;
      return save(intent, markSettled(intent, now().toISOString(), ledgerRef, claimToken));
    },

    /**
     * Ledger-proven repair, called by settlement-handoff.ts under the sale lock only:
     * `found` is the tender/refund row carrying this approval's provider reference, or
     * null when the ledger has none.
     *  - found, intent APPROVED → SETTLED on that row (a committed settlement whose
     *    intent update was lost, from any device);
     *  - none, intent SETTLED or holding a claim → APPROVED with no claim (a settlement
     *    marked the intent and then rolled back).
     */
    async reconcileWithLedger(
      location: TerminalLocation,
      intentRef: string,
      found: { id: string } | null
    ) {
      validateLocation(location);
      const intent = await load(location, intentRef);
      const at = now().toISOString();
      if (found) {
        if (intent.state === 'SETTLED' && intent.ledgerRef === found.id) return intent;
        if (intent.state === 'APPROVED')
          return saveOrReload(intent, adoptLedgerRow(intent, at, found.id));
        if (intent.state === 'SETTLED')
          throw new TerminalIntentError(
            'INVALID_TRANSITION',
            'Intent and ledger disagree; reconcile manually.'
          );
        return intent;
      }
      if (intent.state === 'SETTLED' || (intent.state === 'APPROVED' && intent.handoffClaim)) {
        log({ event: 'terminal.ledger_row_missing', intentRef, state: intent.state });
        return saveOrReload(intent, reopenForSettlement(intent, at));
      }
      return intent;
    },

    /** Give back a hand-off claim whose settlement command failed. Owner only. */
    async releaseHandoff(location: TerminalLocation, intentRef: string, claimToken: string) {
      validateLocation(location);
      const intent = await load(location, intentRef);
      if (intent.state !== 'APPROVED' || intent.handoffClaim?.claimId !== claimToken) return intent;
      return saveOrReload(intent, releaseHandoff(intent, now().toISOString(), claimToken));
    },

    /** Decide VOID vs REFUND vs blocked for a settled SALE intent, without dispatching. */
    planReversal(location: TerminalLocation, saleIntentRef: string, input: ReversalInput) {
      return planReversal(location, saleIntentRef, input);
    },

    /** Start (or replay) a VOID or REFUND of a settled SALE intent, per `planReversal`. */
    async startReversal(
      scope: TerminalScope,
      input: ReversalInput & { saleIntentRef: string; attemptKey: string }
    ): Promise<TerminalIntent> {
      validateScope(scope);
      assertSafeId(input.attemptKey, 'attemptKey');
      assertMinor(input.amountMinor);
      requireAdmitted();
      const saleIntent = await load(scope, input.saleIntentRef);
      // A replay of an already-dispatched reversal returns it before re-planning.
      for (const kind of ['VOID', 'REFUND'] as const) {
        const ref = terminalIntentRef({
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          saleId: saleIntent.saleId,
          kind,
          attemptKey: input.attemptKey,
        });
        const existing = await store.get(scope.organizationId, ref);
        if (existing && existing.state !== 'CREATED') {
          if (
            existing.amountMinor !== input.amountMinor ||
            existing.reversesIntentRef !== saleIntent.intentRef
          )
            throw new TerminalIntentError('IDEMPOTENCY_CONFLICT');
          return existing;
        }
      }
      const plan = await planReversal(scope, input.saleIntentRef, input);
      if (plan.kind === 'BLOCKED')
        throw new TerminalIntentError('REVERSAL_BLOCKED', `Reversal blocked: ${plan.reason}.`);
      const created = await createIntent(scope, {
        saleId: saleIntent.saleId,
        kind: plan.kind,
        attemptKey: input.attemptKey,
        terminalId: saleIntent.terminalId,
        amountMinor: input.amountMinor,
        currency: saleIntent.currency,
        reversesIntentRef: saleIntent.intentRef,
      });
      if (created.status === 'CREATED') {
        // Re-plan now that this intent holds the sale's single open slot: a reversal
        // that settled between the first plan and the create must not let the total
        // exceed the capture.
        const recheck = await planReversal(
          scope,
          input.saleIntentRef,
          input,
          created.intent.intentRef
        );
        if (recheck.kind !== plan.kind) {
          await saveOrReload(
            created.intent,
            markAbandoned(created.intent, now().toISOString(), 'REPLAN_CHANGED')
          );
          throw new TerminalIntentError(
            'REVERSAL_BLOCKED',
            `Reversal blocked: ${recheck.kind === 'BLOCKED' ? recheck.reason : 'plan changed'}.`
          );
        }
      }
      return dispatchOrClose(created, saleIntent.providerRef);
    },

    /**
     * A `PharmacyPaymentAdapter` that hands an APPROVED intent to settlement without
     * calling the provider again. Use it through settlement-handoff.ts, which takes the
     * sale and amount from the stored intent.
     *
     *  - `certified` is true only for an admitted provider, so with today's empty list
     *    settlement refuses with UNCERTIFIED_PROVIDER before any tender or refund.
     *  - `execute` checks scope, capability, amount, the bound idempotency key and the
     *    prior reference, then CLAIMS the hand-off once. A second claim (another device,
     *    another sale, a replay with a fresh key) is refused, so one charge can only
     *    ever become one tender. A database store must take this claim in the same
     *    transaction as the tender insert, so a rollback releases it.
     */
    settlementAdapter(
      location: TerminalLocation,
      intentRef: string
    ): PharmacyPaymentAdapter & { readonly claimToken: string } {
      validateLocation(location);
      const claimToken = randomUUID();
      const adapter: PharmacyPaymentAdapter = {
        name: provider.name,
        certified: admitted(),
        async execute(request) {
          const refuse = { approved: false, providerRef: '' };
          const current = await load(location, intentRef).catch(() => null);
          if (!current) return refuse;
          const expectedCapability = current.kind === 'SALE' ? 'SALE' : 'REFUND';
          const expectedKey =
            current.kind === 'SALE'
              ? tenderIdempotencyKeyFor(current)
              : refundIdempotencyKeyFor(current);
          let priorOk = current.kind === 'SALE';
          if (!priorOk && current.reversesIntentRef && request.priorRef !== undefined) {
            const sale = await load(location, current.reversesIntentRef).catch(() => null);
            priorOk = sale?.providerRef !== undefined && sale.providerRef === request.priorRef;
          }
          const matches =
            current.state === 'APPROVED' &&
            (!current.handoffClaim ||
              Date.parse(now().toISOString()) - Date.parse(current.handoffClaim.at) >=
                handoffLeaseMs) &&
            current.providerRef !== undefined &&
            request.capability === expectedCapability &&
            request.amountMinor === current.amountMinor &&
            request.operationRef === expectedKey &&
            priorOk;
          let claimed = false;
          if (matches) {
            const next = claimHandoff(current, now().toISOString(), claimToken, handoffLeaseMs);
            assertNoCardholderData(next);
            claimed = await store.compareAndSet(current.version, next);
          }
          log({ event: 'terminal.settlement_handoff', intentRef, accepted: claimed });
          // `approved: false` makes settlement refuse; it never triggers a new charge.
          return claimed ? { approved: true, providerRef: current.providerRef! } : refuse;
        },
      };
      // Non-enumerable: settlement hashes its input (adapter included) for idempotency,
      // and a per-call token must not turn a same-device retry into a conflict.
      Object.defineProperty(adapter, 'claimToken', { value: claimToken, enumerable: false });
      return adapter as PharmacyPaymentAdapter & { readonly claimToken: string };
    },
  };
}

export type CardTerminalService = ReturnType<typeof createCardTerminalService>;

export { TERMINAL_UNRESOLVED_STATES };
