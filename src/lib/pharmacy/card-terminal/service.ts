import 'server-only';

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
  applyTerminalResponse,
  assertCurrency,
  assertMinor,
  assertSafeId,
  countRecoveryAttempt,
  hashTerminalPayload,
  markAbandoned,
  markDispatched,
  markOutcomeUnknown,
  markSettled,
  normalizeTerminalResponse,
  refundIdempotencyKeyFor,
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
 * fed by `settlementAdapter`, which replays an already-approved outcome instead of
 * charging again.
 *
 * Duplicate-charge rules:
 *  1. Same attempt key → same intent. A replay never re-dispatches once SENT.
 *  2. One open operation per sale. A second attempt is refused while another is
 *     unresolved or approved-but-not-settled.
 *  3. A timeout is UNKNOWN, not FAILED. UNKNOWN is resolved by status query or an
 *     operator with evidence, never by charging again.
 *  4. SENT is persisted before the provider is called (write-ahead), and only one
 *     writer wins the CREATED → SENT compare-and-set.
 */

export type TerminalScope = { organizationId: string; branchId: string; actorId: string };

export type TerminalLogEntry = {
  event: string;
  intentRef?: string;
  state?: string;
  [field: string]: unknown;
};

export type CardTerminalServiceOptions = {
  store: TerminalIntentStore;
  provider: CardTerminalProvider;
  /** Defaults to the production list, which is empty. */
  admission?: TerminalAdmission;
  environment?: string;
  now?: () => Date;
  /** Upper bound for one provider call. Past it the outcome is UNKNOWN. */
  timeoutMs: number;
  recovery: {
    /** Status checks before the intent escalates to MANUAL_REVIEW. */
    maxAttempts: number;
    /** A NOT_FOUND status only proves "not charged" after this long since dispatch. */
    notFoundGraceMs: number;
  };
  /** Receives redacted, structured entries only. */
  logger?: (entry: TerminalLogEntry) => void;
};

type CallResult =
  | { ok: true; response: NormalizedResponse }
  | { ok: false; code: 'PROVIDER_TIMEOUT' | 'PROVIDER_THREW' };

async function callProvider(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<unknown>
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
      call(controller.signal).then(
        (response): CallResult => ({ ok: true, response: normalizeTerminalResponse(response) }),
        (): CallResult => ({ ok: false, code: 'PROVIDER_THREW' })
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

  /** Persist a transition. Card data is refused before anything is written. */
  async function save(previous: TerminalIntent, next: TerminalIntent) {
    assertNoCardholderData(next);
    const ok = await store.compareAndSet(previous.version, next);
    if (!ok) throw new TerminalIntentError('CONCURRENT_UPDATE');
    log({ event: 'terminal.transition', intentRef: next.intentRef, state: next.state });
    return next;
  }

  async function load(organizationId: string, intentRef: string) {
    const intent = await store.get(organizationId, intentRef);
    if (!intent || intent.organizationId !== organizationId)
      throw new TerminalIntentError('INTENT_NOT_FOUND');
    return intent;
  }

  async function dispatch(intent: TerminalIntent, priorProviderRef?: string) {
    const at = now().toISOString();
    const sent = markDispatched(intent, at);
    assertNoCardholderData(sent);
    // Only the writer that wins CREATED → SENT may call the provider.
    if (!(await store.compareAndSet(intent.version, sent))) {
      log({ event: 'terminal.dispatch_lost_race', intentRef: intent.intentRef });
      return load(intent.organizationId, intent.intentRef);
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
      // A recovery sweep recorded an outcome first. Its answer stands; the next
      // status check reconciles anything this response would have added.
      if (error instanceof TerminalIntentError && error.reason === 'CONCURRENT_UPDATE') {
        log({ event: 'terminal.dispatch_result_superseded', intentRef: sent.intentRef });
        return load(sent.organizationId, sent.intentRef);
      }
      throw error;
    }
  }

  async function planReversal(
    organizationId: string,
    saleIntentRef: string,
    input: { amountMinor: number; batchOpen: boolean }
  ): Promise<ReversalPlan> {
    const saleIntent = await load(organizationId, saleIntentRef);
    const related = await store.listForSale(organizationId, saleIntent.saleId);
    return planTerminalReversal({
      saleIntent,
      reversals: related.filter((row) => row.reversesIntentRef === saleIntent.intentRef),
      requestedMinor: input.amountMinor,
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

  function validateScope(scope: TerminalScope) {
    assertSafeId(scope.organizationId, 'organizationId');
    assertSafeId(scope.branchId, 'branchId');
    assertSafeId(scope.actorId, 'actorId');
  }

  return {
    /** True only when this provider may move real money. Always false today. */
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
      const created = await createIntent(scope, { ...input, kind: 'SALE' });
      if (created.status === 'EXISTING' && created.intent.state !== 'CREATED') {
        log({ event: 'terminal.replay', intentRef: created.intent.intentRef });
        return created.intent;
      }
      return dispatch(created.intent);
    },

    /**
     * Resolve an in-flight intent by asking the provider. Safe to call repeatedly
     * (from the counter after a reload, or from a background sweep).
     */
    async recover(organizationId: string, intentRef: string): Promise<TerminalIntent> {
      const intent = await load(organizationId, intentRef);
      if (intent.state === 'CREATED') {
        // SENT is written before any provider call, so CREATED was never dispatched.
        return save(intent, markAbandoned(intent, now().toISOString(), 'RECOVERY_NEVER_SENT'));
      }
      if (!['SENT', 'PENDING', 'UNKNOWN'].includes(intent.state)) return intent;
      // A SENT intent younger than one provider timeout may still be in flight.
      if (
        intent.state === 'SENT' &&
        intent.sentAt &&
        now().getTime() - Date.parse(intent.sentAt) < timeoutMs
      )
        return intent;
      if (!providerSupports(provider, 'STATUS')) {
        return save(intent, countRecoveryAttempt(intent, now().toISOString(), 1));
      }
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
    async unresolved(organizationId: string, branchId: string) {
      return store.listUnresolved(organizationId, branchId);
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
      const intent = await load(scope.organizationId, intentRef);
      if (intent.branchId !== scope.branchId) throw new TerminalIntentError('INTENT_NOT_FOUND');
      return save(
        intent,
        resolveManually(intent, resolution, now().toISOString(), scope.actorId, note)
      );
    },

    /** Mark an APPROVED intent as recorded in settlement (tender id or refund id). */
    async recordSettlement(organizationId: string, intentRef: string, ledgerRef: string) {
      const intent = await load(organizationId, intentRef);
      if (intent.state === 'SETTLED' && intent.ledgerRef === ledgerRef) return intent;
      return save(intent, markSettled(intent, now().toISOString(), ledgerRef));
    },

    /** Decide VOID vs REFUND vs blocked for a settled SALE intent, without dispatching. */
    planReversal,

    /** Start (or replay) a VOID or REFUND of a settled SALE intent, per `planReversal`. */
    async startReversal(
      scope: TerminalScope,
      input: { saleIntentRef: string; amountMinor: number; attemptKey: string; batchOpen: boolean }
    ): Promise<TerminalIntent> {
      validateScope(scope);
      assertSafeId(input.attemptKey, 'attemptKey');
      assertMinor(input.amountMinor);
      requireAdmitted();
      const saleIntent = await load(scope.organizationId, input.saleIntentRef);
      if (saleIntent.branchId !== scope.branchId) throw new TerminalIntentError('INTENT_NOT_FOUND');
      // A replay of an already-created reversal returns it before re-planning.
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
          if (existing.amountMinor !== input.amountMinor)
            throw new TerminalIntentError('IDEMPOTENCY_CONFLICT');
          return existing;
        }
      }
      const plan = await planReversal(scope.organizationId, input.saleIntentRef, input);
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
      if (created.status === 'EXISTING' && created.intent.state !== 'CREATED')
        return created.intent;
      return dispatch(created.intent, saleIntent.providerRef);
    },

    /**
     * A `PharmacyPaymentAdapter` that hands an APPROVED intent to settlement without
     * calling the provider again. Settlement still runs `requireReleaseSafeAdapter`,
     * so with no admitted provider it refuses with UNCERTIFIED_PROVIDER before any
     * tender or refund is written.
     */
    settlementAdapter(intent: TerminalIntent): PharmacyPaymentAdapter {
      const snapshot = structuredClone(intent);
      return {
        name: provider.name,
        certified: admitted(),
        async execute(request) {
          const expectedCapability = snapshot.kind === 'SALE' ? 'SALE' : 'REFUND';
          const expectedKey =
            snapshot.kind === 'SALE'
              ? tenderIdempotencyKeyFor(snapshot)
              : refundIdempotencyKeyFor(snapshot);
          const current = await load(snapshot.organizationId, snapshot.intentRef);
          const priorOk =
            snapshot.kind === 'SALE' ||
            (request.priorRef !== undefined &&
              request.priorRef ===
                (await load(snapshot.organizationId, snapshot.reversesIntentRef!)).providerRef);
          const matches =
            current.state === 'APPROVED' &&
            current.providerRef !== undefined &&
            request.capability === expectedCapability &&
            request.amountMinor === current.amountMinor &&
            request.operationRef === expectedKey &&
            priorOk;
          log({
            event: 'terminal.settlement_handoff',
            intentRef: snapshot.intentRef,
            accepted: matches,
          });
          // `approved: false` makes settlement refuse; it never triggers a new charge.
          return matches
            ? { approved: true, providerRef: current.providerRef! }
            : { approved: false, providerRef: '' };
        },
      };
    },
  };
}

export type CardTerminalService = ReturnType<typeof createCardTerminalService>;

export { TERMINAL_UNRESOLVED_STATES };
