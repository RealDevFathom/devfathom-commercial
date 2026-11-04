import { describe, expect, it } from 'vitest';

import {
  applyTerminalResponse,
  countRecoveryAttempt,
  markDispatched,
  markOutcomeUnknown,
  markSettled,
  normalizeTerminalResponse,
  resolveManually,
  terminalIntentRef,
  TerminalIntentError,
  type TerminalIntent,
} from './intent';

const T0 = '2026-11-04T10:00:00.000Z';
const NOW = Date.parse(T0);

function intent(patch: Partial<TerminalIntent> = {}): TerminalIntent {
  return {
    intentRef: 'pti_sale_test',
    organizationId: 'org-1',
    branchId: 'branch-1',
    saleId: 'sale-1',
    kind: 'SALE',
    attemptKey: 'attempt-1',
    payloadHash: 'hash',
    terminalId: 'term-1',
    providerName: 'SCRIPTED_TERMINAL',
    amountMinor: 1_000,
    currency: 'PKR',
    state: 'CREATED',
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    createdBy: 'actor-1',
    recoveryAttempts: 0,
    history: [],
    ...patch,
  };
}

const opts = (source: 'DISPATCH' | 'STATUS', nowMs = NOW) => ({
  source,
  notFoundGraceMs: 60_000,
  nowMs,
});

describe('terminal intent state machine (DEV-743)', () => {
  it('derives a stable intent reference per scope, sale, kind and attempt key', () => {
    const base = {
      organizationId: 'org-1',
      branchId: 'branch-1',
      saleId: 'sale-1',
      kind: 'SALE' as const,
      attemptKey: 'k1',
    };
    expect(terminalIntentRef(base)).toBe(terminalIntentRef({ ...base }));
    expect(terminalIntentRef(base)).not.toBe(terminalIntentRef({ ...base, attemptKey: 'k2' }));
    expect(terminalIntentRef(base)).not.toBe(
      terminalIntentRef({ ...base, organizationId: 'org-2' })
    );
    expect(terminalIntentRef(base)).toMatch(/^pti_sale_[a-p]{32}$/);
  });

  it('only dispatches from CREATED and records the send time first', () => {
    const sent = markDispatched(intent(), T0);
    expect(sent).toMatchObject({ state: 'SENT', sentAt: T0, version: 2 });
    expect(() => markDispatched(sent, T0)).toThrow(TerminalIntentError);
  });

  it('settles an exact approval and sends any amount mismatch to manual review', () => {
    const sent = markDispatched(intent(), T0);
    const approved = applyTerminalResponse(
      sent,
      { kind: 'APPROVED', providerRef: 'p-1', amountMinor: 1_000, last4: '1111' },
      T0,
      opts('DISPATCH')
    );
    expect(approved).toMatchObject({ state: 'APPROVED', providerRef: 'p-1', last4: '1111' });
    const partial = applyTerminalResponse(
      sent,
      { kind: 'APPROVED', providerRef: 'p-2', amountMinor: 600 },
      T0,
      opts('DISPATCH')
    );
    expect(partial.state).toBe('MANUAL_REVIEW');
  });

  it('treats only a dispatch-time "never reached terminal" as not charged', () => {
    const sent = markDispatched(intent(), T0);
    expect(
      applyTerminalResponse(sent, { kind: 'NOT_SENT', code: 'OFFLINE' }, T0, opts('DISPATCH')).state
    ).toBe('FAILED');
    const unknown = markOutcomeUnknown(sent, T0, 'PROVIDER_TIMEOUT');
    expect(
      applyTerminalResponse(unknown, { kind: 'NOT_SENT', code: 'OFFLINE' }, T0, opts('STATUS'))
        .state
    ).toBe('UNKNOWN');
  });

  it('resolves NOT_FOUND to FAILED only from a status query after the grace window', () => {
    const unknown = markOutcomeUnknown(markDispatched(intent(), T0), T0, 'PROVIDER_TIMEOUT');
    expect(
      applyTerminalResponse(unknown, { kind: 'NOT_FOUND' }, T0, opts('STATUS', NOW + 1_000)).state
    ).toBe('UNKNOWN');
    expect(
      applyTerminalResponse(unknown, { kind: 'NOT_FOUND' }, T0, opts('STATUS', NOW + 60_000)).state
    ).toBe('FAILED');
    expect(
      applyTerminalResponse(unknown, { kind: 'NOT_FOUND' }, T0, opts('DISPATCH', NOW + 60_000))
        .state
    ).toBe('UNKNOWN');
  });

  it('escalates to manual review when recovery attempts run out', () => {
    let current = markOutcomeUnknown(markDispatched(intent(), T0), T0, 'PROVIDER_TIMEOUT');
    current = countRecoveryAttempt(current, T0, 2);
    expect(current.state).toBe('UNKNOWN');
    current = countRecoveryAttempt(current, T0, 2);
    expect(current).toMatchObject({ state: 'MANUAL_REVIEW', recoveryAttempts: 2 });
  });

  it('requires evidence that matches the intent for a manual approval', () => {
    const review = intent({ state: 'MANUAL_REVIEW' });
    expect(() =>
      resolveManually(
        review,
        { outcome: 'APPROVED', providerRef: 'p-1', amountMinor: 999 },
        T0,
        'actor-2',
        'checked portal'
      )
    ).toThrow(TerminalIntentError);
    expect(() =>
      resolveManually(
        review,
        { outcome: 'APPROVED', providerRef: '4111111111111111', amountMinor: 1_000 },
        T0,
        'actor-2',
        'checked portal'
      )
    ).toThrow(TerminalIntentError);
    const done = resolveManually(review, { outcome: 'NOT_CHARGED' }, T0, 'actor-2', 'void slip');
    expect(done).toMatchObject({ state: 'FAILED' });
    expect(done.history.at(-1)).toMatchObject({ actorId: 'actor-2' });
  });

  it('settles only an approved intent, and only for the hand-off claim holder', () => {
    const claim = { claimId: 'claim-1', at: T0 };
    expect(() =>
      markSettled(intent({ state: 'UNKNOWN', handoffClaim: claim }), T0, 'tender-1', 'claim-1')
    ).toThrow(TerminalIntentError);
    expect(() => markSettled(intent({ state: 'APPROVED' }), T0, 'tender-1', 'claim-1')).toThrow(
      TerminalIntentError
    );
    expect(() =>
      markSettled(intent({ state: 'APPROVED', handoffClaim: claim }), T0, 'tender-1', 'other')
    ).toThrow(TerminalIntentError);
    expect(
      markSettled(intent({ state: 'APPROVED', handoffClaim: claim }), T0, 'tender-1', 'claim-1')
    ).toMatchObject({ state: 'SETTLED', ledgerRef: 'tender-1' });
  });

  it('never lets a charged intent be closed as "not charged"', () => {
    const charged = intent({ state: 'MANUAL_REVIEW', chargeEvidence: true });
    expect(() =>
      resolveManually(charged, { outcome: 'NOT_CHARGED' }, T0, 'actor-2', 'looks unpaid')
    ).toThrow(TerminalIntentError);
    expect(
      resolveManually(charged, { outcome: 'REVERSED_EXTERNALLY' }, T0, 'actor-2', 'voided')
    ).toMatchObject({ state: 'FAILED', failureCode: 'CHARGED_AND_REVERSED_EXTERNALLY' });
  });

  it('turns malformed provider responses into uncertainty, never approval', () => {
    expect(normalizeTerminalResponse(null).kind).toBe('UNKNOWN');
    expect(
      normalizeTerminalResponse({ kind: 'APPROVED', providerRef: 'p', amountMinor: 1.5 }).kind
    ).toBe('UNKNOWN');
    expect(
      normalizeTerminalResponse({
        kind: 'APPROVED',
        providerRef: 'p',
        amountMinor: 10,
        last4: '12345',
      }).kind
    ).toBe('UNKNOWN');
    expect(
      normalizeTerminalResponse({
        kind: 'APPROVED',
        providerRef: '4111111111111111',
        amountMinor: 10,
      }).kind
    ).toBe('UNKNOWN');
    expect(normalizeTerminalResponse({ kind: 'ERROR', code: 'X' }).kind).toBe('UNKNOWN');
    expect(
      normalizeTerminalResponse({ kind: 'ERROR', code: 'X', reachedTerminal: false }).kind
    ).toBe('NOT_SENT');
    expect(normalizeTerminalResponse({ kind: 'SURPRISE' }).kind).toBe('UNKNOWN');
  });
});
