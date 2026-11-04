import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PRODUCTION_TERMINAL_ADMISSION,
  RESERVED_PROVIDER_NAMES,
  terminalAdmissionRefusal,
  type CardTerminalProvider,
  type TerminalResponse,
} from './contract';
import {
  hashTerminalPayload,
  refundIdempotencyKeyFor,
  terminalIntentRef,
  tenderIdempotencyKeyFor,
  TerminalIntentError,
  type TerminalIntent,
} from './intent';
import { createCardTerminalService, type CardTerminalService } from './service';
import { createInMemoryTerminalIntentStore } from './store';
import {
  createScriptedTerminal,
  TEST_ONLY_ADMISSION,
  type ScriptStep,
} from './testing/scripted-terminal';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
const sale = {
  saleId: 'sale-1',
  terminalId: 'term-1',
  amountMinor: 1_000,
  currency: 'PKR',
  attemptKey: 'attempt-1',
};
const approved = (amountMinor = 1_000, providerRef = 'prov-sale-1'): ScriptStep => ({
  kind: 'APPROVED',
  providerRef,
  amountMinor,
  approvalCode: 'A1B2C3',
  cardBrand: 'VISA',
  last4: '1111',
});
const noLedgerRefunds = { ledgerRefundedMinor: 0 };

function setup(script: Parameters<typeof createScriptedTerminal>[0] = {}) {
  const terminal = createScriptedTerminal({ claimCertified: true, ...script });
  const store = createInMemoryTerminalIntentStore();
  let clock = Date.parse('2026-11-04T10:00:00.000Z');
  const logs: unknown[] = [];
  const service = createCardTerminalService({
    store,
    provider: terminal.provider,
    admission: TEST_ONLY_ADMISSION,
    environment: 'test',
    now: () => new Date(clock),
    timeoutMs: 20,
    recovery: { maxAttempts: 3, notFoundGraceMs: 60_000 },
    logger: (entry) => logs.push(entry),
  });
  return {
    terminal,
    store,
    service,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Settle an approved intent the way settlement-handoff.ts does: claim, then record. */
async function settle(service: CardTerminalService, intent: TerminalIntent, ledgerRef: string) {
  const adapter = service.settlementAdapter(scope, intent.intentRef);
  const result = await adapter.execute(
    intent.kind === 'SALE'
      ? {
          capability: 'SALE',
          amountMinor: intent.amountMinor,
          operationRef: tenderIdempotencyKeyFor(intent),
        }
      : {
          capability: 'REFUND',
          amountMinor: intent.amountMinor,
          operationRef: refundIdempotencyKeyFor(intent),
          priorRef: (await service.getIntent(scope, intent.reversesIntentRef!)).providerRef,
        }
  );
  expect(result.approved).toBe(true);
  return service.recordSettlement(scope, intent.intentRef, ledgerRef, adapter.claimToken);
}

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as TerminalIntentError).reason;
  }
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('card-terminal admission (DEV-743)', () => {
  it('admits no provider in production by default, whatever it claims', () => {
    const { provider } = createScriptedTerminal({ claimCertified: true });
    expect(PRODUCTION_TERMINAL_ADMISSION.admittedProviders).toHaveLength(0);
    expect(Object.isFrozen(PRODUCTION_TERMINAL_ADMISSION.admittedProviders)).toBe(true);
    expect(Object.isFrozen(RESERVED_PROVIDER_NAMES)).toBe(true);
    expect(terminalAdmissionRefusal(provider, undefined, 'production')).toBe(
      'SIMULATED_PROVIDER_IN_PRODUCTION'
    );
    expect(
      terminalAdmissionRefusal({ ...provider, simulated: undefined }, undefined, 'production')
    ).toBe('NOT_ADMITTED');
  });

  it('ignores injected admission and environment in a production process', () => {
    const real = {
      ...createScriptedTerminal({ claimCertified: true }).provider,
      simulated: undefined,
    };
    expect(terminalAdmissionRefusal(real, TEST_ONLY_ADMISSION, 'test')).toBeNull();
    vi.stubEnv('NODE_ENV', 'production');
    expect(terminalAdmissionRefusal(real, TEST_ONLY_ADMISSION, 'test')).toBe('NOT_ADMITTED');
    const service = createCardTerminalService({
      store: createInMemoryTerminalIntentStore(),
      provider: real as CardTerminalProvider,
      admission: TEST_ONLY_ADMISSION,
      environment: 'test',
      timeoutMs: 20,
      recovery: { maxAttempts: 1, notFoundGraceMs: 1_000 },
    });
    expect(service.providerAdmitted).toBe(false);
    expect(service.settlementAdapter(scope, 'pti_sale_x').certified).toBe(false);
  });

  it('never trusts a self-declared certification and refuses reserved names', () => {
    const uncertified = createScriptedTerminal({}).provider;
    expect(terminalAdmissionRefusal(uncertified, TEST_ONLY_ADMISSION, 'test')).toBe(
      'NO_CERTIFICATION_CLAIM'
    );
    for (const name of ['MOCK', 'MANUAL_TERMINAL', 'MANUAL_MERCHANT', 'LOCAL_TOKEN_SANDBOX'])
      expect(
        terminalAdmissionRefusal(
          createScriptedTerminal({ name, claimCertified: true }).provider,
          { admittedProviders: [name] },
          'test'
        )
      ).toBe('RESERVED_PROVIDER_NAME');
  });

  it('refuses to dispatch through an unadmitted provider and calls nothing', async () => {
    const terminal = createScriptedTerminal({ claimCertified: true, sale: [approved()] });
    const service = createCardTerminalService({
      store: createInMemoryTerminalIntentStore(),
      provider: terminal.provider,
      environment: 'test',
      timeoutMs: 20,
      recovery: { maxAttempts: 3, notFoundGraceMs: 1_000 },
    });
    expect(service.providerAdmitted).toBe(false);
    expect(await reasonOf(service.startSale(scope, sale))).toBe('PROVIDER_NOT_ADMITTED');
    expect(terminal.calls).toHaveLength(0);
  });

  it('refuses a NOT_FOUND grace shorter than two timeouts', () => {
    expect(() =>
      createCardTerminalService({
        store: createInMemoryTerminalIntentStore(),
        provider: createScriptedTerminal({}).provider,
        timeoutMs: 1_000,
        recovery: { maxAttempts: 1, notFoundGraceMs: 1_500 },
      })
    ).toThrow(TerminalIntentError);
  });
});

describe('card-terminal duplicate-charge protection (DEV-743)', () => {
  it('replays the same attempt without a second charge', async () => {
    const { service, terminal } = setup({ sale: [approved()] });
    const first = await service.startSale(scope, sale);
    const replay = await service.startSale(scope, sale);
    expect(first).toMatchObject({ state: 'APPROVED', providerRef: 'prov-sale-1' });
    expect(replay.intentRef).toBe(first.intentRef);
    expect(terminal.count('startSale')).toBe(1);
    // The provider receives the intent ref as its idempotency key.
    expect(terminal.calls[0]!.request.operationRef).toBe(first.intentRef);
  });

  it('refuses the same attempt key with a different amount or terminal', async () => {
    const { service } = setup({ sale: [approved()] });
    await service.startSale(scope, sale);
    expect(await reasonOf(service.startSale(scope, { ...sale, amountMinor: 900 }))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
    expect(await reasonOf(service.startSale(scope, { ...sale, terminalId: 'term-2' }))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
  });

  it('blocks a second attempt while the first is approved but not yet a tender', async () => {
    const { service, terminal } = setup({ sale: [approved()] });
    await service.startSale(scope, sale);
    expect(await reasonOf(service.startSale(scope, { ...sale, attemptKey: 'attempt-2' }))).toBe(
      'APPROVED_NOT_SETTLED'
    );
    expect(terminal.count('startSale')).toBe(1);
  });

  it('allows a split second card tender once the first is settled', async () => {
    const { service, terminal } = setup({
      sale: [approved(600, 'prov-a'), approved(400, 'prov-b')],
    });
    const first = await service.startSale(scope, { ...sale, amountMinor: 600 });
    await settle(service, first, 'tender-a');
    const second = await service.startSale(scope, {
      ...sale,
      amountMinor: 400,
      attemptKey: 'attempt-2',
    });
    expect(second.state).toBe('APPROVED');
    expect(terminal.count('startSale')).toBe(2);
  });

  it('lets exactly one of two concurrent identical requests reach the terminal', async () => {
    const { service, terminal } = setup({ sale: [approved(), approved()] });
    const [a, b] = await Promise.all([
      service.startSale(scope, sale),
      service.startSale(scope, sale),
    ]);
    expect(terminal.count('startSale')).toBe(1);
    expect(a.intentRef).toBe(b.intentRef);
  });

  it('refuses a concurrent different attempt on the same sale', async () => {
    const { service, terminal } = setup({ sale: ['HANG', approved()] });
    const first = service.startSale(scope, sale);
    expect(await reasonOf(service.startSale(scope, { ...sale, attemptKey: 'attempt-2' }))).toBe(
      'ACTIVE_OPERATION_EXISTS'
    );
    await first;
    expect(terminal.count('startSale')).toBe(1);
  });

  it('closes a stale CREATED row on replay instead of charging late', async () => {
    const { service, store, terminal, advance } = setup({ sale: [approved()] });
    // A crash right after the intent row was written, before SENT.
    await store.createOrGet({
      intentRef: terminalIntentRef({
        organizationId: 'org-1',
        branchId: 'branch-1',
        saleId: 'sale-1',
        kind: 'SALE',
        attemptKey: 'attempt-1',
      }),
      organizationId: 'org-1',
      branchId: 'branch-1',
      saleId: 'sale-1',
      kind: 'SALE',
      attemptKey: 'attempt-1',
      payloadHash: hashTerminalPayload({
        organizationId: 'org-1',
        branchId: 'branch-1',
        saleId: 'sale-1',
        kind: 'SALE',
        attemptKey: 'attempt-1',
        terminalId: 'term-1',
        amountMinor: 1_000,
        currency: 'PKR',
        provider: 'SCRIPTED_TERMINAL',
        reversesIntentRef: null,
      }),
      terminalId: 'term-1',
      providerName: 'SCRIPTED_TERMINAL',
      amountMinor: 1_000,
      currency: 'PKR',
      state: 'CREATED',
      version: 1,
      createdAt: '2026-11-04T10:00:00.000Z',
      updatedAt: '2026-11-04T10:00:00.000Z',
      createdBy: 'cashier-1',
      recoveryAttempts: 0,
      history: [],
    });
    advance(60_000);
    const replay = await service.startSale(scope, sale);
    expect(replay).toMatchObject({ state: 'FAILED', failureCode: 'NEVER_DISPATCHED' });
    expect(terminal.count('startSale')).toBe(0);
  });
});

describe('card-terminal timeout and recovery (DEV-743)', () => {
  it('records a timeout as UNKNOWN and never re-sends the charge on replay', async () => {
    const { service, terminal } = setup({ sale: ['HANG'] });
    const timedOut = await service.startSale(scope, sale);
    expect(timedOut).toMatchObject({ state: 'UNKNOWN', failureCode: 'PROVIDER_TIMEOUT' });
    const replay = await service.startSale(scope, sale);
    expect(replay.state).toBe('UNKNOWN');
    expect(terminal.count('startSale')).toBe(1);
    expect(await reasonOf(service.startSale(scope, { ...sale, attemptKey: 'attempt-2' }))).toBe(
      'ACTIVE_OPERATION_EXISTS'
    );
  });

  it('treats a thrown provider error, sync or async, as UNKNOWN', async () => {
    expect((await setup({ sale: ['THROW'] }).service.startSale(scope, sale)).state).toBe('UNKNOWN');
    const terminal = createScriptedTerminal({ claimCertified: true });
    const syncThrower: CardTerminalProvider = {
      ...terminal.provider,
      startSale: () => {
        throw new Error('card 4111111111111111 exploded');
      },
    };
    const logs: unknown[] = [];
    const service = createCardTerminalService({
      store: createInMemoryTerminalIntentStore(),
      provider: syncThrower,
      admission: TEST_ONLY_ADMISSION,
      environment: 'test',
      timeoutMs: 20,
      recovery: { maxAttempts: 1, notFoundGraceMs: 1_000 },
      logger: (entry) => logs.push(entry),
    });
    expect((await service.startSale(scope, sale)).state).toBe('UNKNOWN');
    expect(JSON.stringify(logs)).not.toContain('4111111111111111');
  });

  it('recovers an unknown outcome by status query', async () => {
    const { service, terminal } = setup({
      sale: ['HANG'],
      status: [{ kind: 'PENDING' }, approved()],
    });
    const unknown = await service.startSale(scope, sale);
    expect((await service.recover(scope, unknown.intentRef)).state).toBe('PENDING');
    const recovered = await service.recover(scope, unknown.intentRef);
    expect(recovered).toMatchObject({ state: 'APPROVED', providerRef: 'prov-sale-1' });
    expect(terminal.count('startSale')).toBe(1);
    expect(terminal.calls.at(-1)!.request).toMatchObject({ operationRef: unknown.intentRef });
  });

  it('only accepts NOT_FOUND as "not charged" after the grace window', async () => {
    const { service, advance } = setup({
      sale: ['HANG'],
      status: [{ kind: 'NOT_FOUND' }, { kind: 'NOT_FOUND' }],
    });
    const unknown = await service.startSale(scope, sale);
    expect((await service.recover(scope, unknown.intentRef)).state).toBe('UNKNOWN');
    advance(60_000);
    expect((await service.recover(scope, unknown.intentRef)).state).toBe('FAILED');
  });

  it('reopens a closed intent when the dispatch approval arrives late', async () => {
    let clock = Date.parse('2026-11-04T10:00:00.000Z');
    let answer: (value: TerminalResponse) => void = () => {};
    const terminal = createScriptedTerminal({
      claimCertified: true,
      status: [{ kind: 'NOT_FOUND' }],
    });
    const provider: CardTerminalProvider = {
      ...terminal.provider,
      startSale: () => new Promise<TerminalResponse>((resolve) => (answer = resolve)),
    };
    const service = createCardTerminalService({
      store: createInMemoryTerminalIntentStore(),
      provider,
      admission: TEST_ONLY_ADMISSION,
      environment: 'test',
      now: () => new Date(clock),
      timeoutMs: 5_000,
      recovery: { maxAttempts: 3, notFoundGraceMs: 10_000 },
    });
    const dispatching = service.startSale(scope, sale);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ref = (await service.unresolved(scope))[0]!.intentRef;
    clock += 20_000;
    expect((await service.recover(scope, ref)).state).toBe('FAILED');
    answer({ kind: 'APPROVED', providerRef: 'prov-late', amountMinor: 1_000 });
    const late = await dispatching;
    expect(late).toMatchObject({
      state: 'MANUAL_REVIEW',
      providerRef: 'prov-late',
      chargeEvidence: true,
    });
    // The sale is blocked again, and nobody can close the charge as "not charged".
    expect(await reasonOf(service.startSale(scope, { ...sale, attemptKey: 'attempt-2' }))).toBe(
      'ACTIVE_OPERATION_EXISTS'
    );
    expect(
      await reasonOf(
        service.resolveManually(scope, ref, { outcome: 'NOT_CHARGED' }, 'looks unpaid')
      )
    ).toBe('INVALID_INPUT');
  });

  it('escalates to manual review, then accepts an operator decision with evidence', async () => {
    const { service } = setup({ sale: ['HANG'], status: ['HANG', 'THROW', { kind: 'PENDING' }] });
    const unknown = await service.startSale(scope, sale);
    await service.recover(scope, unknown.intentRef);
    await service.recover(scope, unknown.intentRef);
    const review = await service.recover(scope, unknown.intentRef);
    expect(review).toMatchObject({ state: 'MANUAL_REVIEW', recoveryAttempts: 3 });
    expect(await service.unresolved(scope)).toHaveLength(1);
    expect(
      await reasonOf(
        service.resolveManually(
          { ...scope, actorId: 'owner-1' },
          review.intentRef,
          { outcome: 'NOT_CHARGED' },
          'card 4111 1111 1111 1111 declined'
        )
      )
    ).toBe('INVALID_INPUT');
    const resolved = await service.resolveManually(
      { ...scope, actorId: 'owner-1' },
      review.intentRef,
      { outcome: 'APPROVED', providerRef: 'portal-ref-9', amountMinor: 1_000 },
      'Checked provider portal'
    );
    expect(resolved).toMatchObject({ state: 'APPROVED', providerRef: 'portal-ref-9' });
    expect(resolved.history.at(-1)).toMatchObject({ actorId: 'owner-1' });
  });

  it('sends a partial approval to review and only allows an external reversal', async () => {
    const { service } = setup({ sale: [approved(400, 'prov-partial')] });
    const review = await service.startSale(scope, sale);
    expect(review).toMatchObject({ state: 'MANUAL_REVIEW', chargeEvidence: true });
    expect(
      await reasonOf(
        service.resolveManually(scope, review.intentRef, { outcome: 'NOT_CHARGED' }, 'unpaid')
      )
    ).toBe('INVALID_INPUT');
    const closed = await service.resolveManually(
      scope,
      review.intentRef,
      { outcome: 'REVERSED_EXTERNALLY' },
      'Voided 400 in provider portal'
    );
    expect(closed).toMatchObject({
      state: 'FAILED',
      failureCode: 'CHARGED_AND_REVERSED_EXTERNALLY',
    });
  });

  it('never stores a PAN-shaped provider code and never jams', async () => {
    const { service } = setup({
      sale: [{ kind: 'DECLINED', declineCode: '4111111111111111' }],
    });
    const declined = await service.startSale(scope, sale);
    expect(declined).toMatchObject({ state: 'DECLINED', declineCode: 'UNSPECIFIED' });
  });

  it('never dispatches a stale CREATED intent during recovery', async () => {
    const { service, store, terminal } = setup({});
    // Simulate a crash between intent creation and the SENT write.
    const created = await store.createOrGet({
      intentRef: 'pti_sale_crashed',
      organizationId: 'org-1',
      branchId: 'branch-1',
      saleId: 'sale-9',
      kind: 'SALE',
      attemptKey: 'a',
      payloadHash: 'h',
      terminalId: 'term-1',
      providerName: 'SCRIPTED_TERMINAL',
      amountMinor: 100,
      currency: 'PKR',
      state: 'CREATED',
      version: 1,
      createdAt: '2026-11-04T09:00:00.000Z',
      updatedAt: '2026-11-04T09:00:00.000Z',
      createdBy: 'cashier-1',
      recoveryAttempts: 0,
      history: [],
    });
    expect(created.status).toBe('CREATED');
    expect((await service.recover(scope, 'pti_sale_crashed')).state).toBe('FAILED');
    expect(terminal.calls).toHaveLength(0);
  });

  it('keeps tenants and branches apart', async () => {
    const { service } = setup({ sale: [approved()] });
    const intent = await service.startSale(scope, sale);
    expect(
      await reasonOf(
        service.recover({ organizationId: 'org-2', branchId: 'branch-1' }, intent.intentRef)
      )
    ).toBe('INTENT_NOT_FOUND');
    expect(
      await reasonOf(
        service.recover({ organizationId: 'org-1', branchId: 'branch-2' }, intent.intentRef)
      )
    ).toBe('INTENT_NOT_FOUND');
    expect(
      await reasonOf(
        service.resolveManually(
          { ...scope, branchId: 'branch-2' },
          intent.intentRef,
          { outcome: 'NOT_CHARGED' },
          'wrong branch'
        )
      )
    ).toBe('INTENT_NOT_FOUND');
    const foreign = service.settlementAdapter(
      { organizationId: 'org-1', branchId: 'branch-2' },
      intent.intentRef
    );
    expect(
      await foreign.execute({
        capability: 'SALE',
        amountMinor: 1_000,
        operationRef: tenderIdempotencyKeyFor(intent),
      })
    ).toMatchObject({ approved: false });
  });
});

describe('card-terminal settlement hand-off (DEV-743)', () => {
  it('replays an approved outcome once, for the bound tender key only', async () => {
    const { service, terminal } = setup({ sale: [approved()] });
    const intent = await service.startSale(scope, sale);
    const adapter = service.settlementAdapter(scope, intent.intentRef);
    expect(adapter).toMatchObject({ name: 'SCRIPTED_TERMINAL', certified: true });
    const request = {
      capability: 'SALE' as const,
      amountMinor: 1_000,
      operationRef: tenderIdempotencyKeyFor(intent),
    };
    expect(await adapter.execute({ ...request, amountMinor: 999 })).toMatchObject({
      approved: false,
    });
    expect(await adapter.execute({ ...request, operationRef: 'other' })).toMatchObject({
      approved: false,
    });
    expect(await adapter.execute({ ...request, capability: 'REFUND' })).toMatchObject({
      approved: false,
    });
    expect(await adapter.execute(request)).toEqual({ approved: true, providerRef: 'prov-sale-1' });
    // A second hand-off (another device, another sale) cannot claim the same approval.
    const secondDevice = service.settlementAdapter(scope, intent.intentRef);
    expect(await secondDevice.execute(request)).toMatchObject({ approved: false });
    // Only the claim holder may record the ledger row.
    expect(
      await reasonOf(
        service.recordSettlement(scope, intent.intentRef, 'tender-x', secondDevice.claimToken)
      )
    ).toBe('INVALID_TRANSITION');
    await service.recordSettlement(scope, intent.intentRef, 'tender-1', adapter.claimToken);
    // The hand-off never calls the terminal again.
    expect(terminal.count('startSale')).toBe(1);
  });

  it('lets a failed settlement give its claim back', async () => {
    const { service } = setup({ sale: [approved()] });
    const intent = await service.startSale(scope, sale);
    const request = {
      capability: 'SALE' as const,
      amountMinor: 1_000,
      operationRef: tenderIdempotencyKeyFor(intent),
    };
    const first = service.settlementAdapter(scope, intent.intentRef);
    expect((await first.execute(request)).approved).toBe(true);
    const other = service.settlementAdapter(scope, intent.intentRef);
    await service.releaseHandoff(scope, intent.intentRef, other.claimToken); // not the owner
    expect((await other.execute(request)).approved).toBe(false);
    await service.releaseHandoff(scope, intent.intentRef, first.claimToken);
    expect((await other.execute(request)).approved).toBe(true);
  });

  it('refuses a hand-off for an intent that is not approved', async () => {
    const { service } = setup({ sale: ['HANG'] });
    const intent = await service.startSale(scope, sale);
    const result = await service.settlementAdapter(scope, intent.intentRef).execute({
      capability: 'SALE',
      amountMinor: 1_000,
      operationRef: tenderIdempotencyKeyFor(intent),
    });
    expect(result.approved).toBe(false);
  });

  it('reports the provider as uncertified when it is not admitted', () => {
    const terminal = createScriptedTerminal({ claimCertified: true });
    const service = createCardTerminalService({
      store: createInMemoryTerminalIntentStore(),
      provider: terminal.provider,
      environment: 'production',
      timeoutMs: 20,
      recovery: { maxAttempts: 1, notFoundGraceMs: 1_000 },
    });
    expect(service.providerAdmitted).toBe(false);
  });
});

describe('card-terminal void and refund contract (DEV-743)', () => {
  async function settledSale(script: Parameters<typeof createScriptedTerminal>[0]) {
    const ctx = setup({ sale: [approved()], ...script });
    const intent = await ctx.service.startSale(scope, sale);
    await settle(ctx.service, intent, 'tender-1');
    return { ...ctx, saleIntent: intent };
  }

  it('voids a full same-batch reversal and refunds a partial one', async () => {
    const { service, saleIntent } = await settledSale({});
    const plan = (amountMinor: number, batchOpen: boolean, ledgerRefundedMinor = 0) =>
      service.planReversal(scope, saleIntent.intentRef, {
        amountMinor,
        batchOpen,
        ledgerRefundedMinor,
      });
    expect(await plan(1_000, true)).toMatchObject({ kind: 'VOID' });
    expect(await plan(1_000, false)).toMatchObject({ kind: 'REFUND' });
    expect(await plan(400, true)).toMatchObject({ kind: 'REFUND', remainingAfterMinor: 600 });
    expect(await plan(1_001, true)).toEqual({ kind: 'BLOCKED', reason: 'EXCEEDS_REMAINING' });
    // A refund settlement already recorded by another route (manual cash fallback) counts.
    expect(await plan(1_000, false, 1_000)).toEqual({
      kind: 'BLOCKED',
      reason: 'EXCEEDS_REMAINING',
    });
    expect(await plan(300, false, 700)).toMatchObject({ kind: 'REFUND', remainingAfterMinor: 0 });
  });

  it('refunds against the original provider reference, once per attempt', async () => {
    const { service, terminal, saleIntent } = await settledSale({
      refundSale: [approved(400, 'prov-refund-1')],
    });
    const input = {
      saleIntentRef: saleIntent.intentRef,
      amountMinor: 400,
      attemptKey: 'r-1',
      batchOpen: false,
      ...noLedgerRefunds,
    };
    const refund = await service.startReversal(scope, input);
    const replay = await service.startReversal(scope, input);
    expect(refund).toMatchObject({
      kind: 'REFUND',
      state: 'APPROVED',
      providerRef: 'prov-refund-1',
    });
    expect(replay.intentRef).toBe(refund.intentRef);
    expect(terminal.count('refundSale')).toBe(1);
    expect(terminal.calls.find((c) => c.method === 'refundSale')!.request).toMatchObject({
      priorProviderRef: 'prov-sale-1',
      amountMinor: 400,
    });
    const adapter = service.settlementAdapter(scope, refund.intentRef);
    const request = {
      capability: 'REFUND' as const,
      amountMinor: 400,
      operationRef: refundIdempotencyKeyFor(refund),
    };
    expect(await adapter.execute({ ...request, priorRef: 'someone-elses-sale' })).toMatchObject({
      approved: false,
    });
    expect(await adapter.execute({ ...request, priorRef: 'prov-sale-1' })).toEqual({
      approved: true,
      providerRef: 'prov-refund-1',
    });
  });

  it('refuses a reversal attempt key reused against a different sale tender', async () => {
    const { service } = setup({
      sale: [approved(600, 'prov-a'), approved(400, 'prov-b')],
      refundSale: [approved(100, 'prov-r')],
    });
    const a = await service.startSale(scope, { ...sale, amountMinor: 600 });
    await settle(service, a, 'tender-a');
    const b = await service.startSale(scope, { ...sale, amountMinor: 400, attemptKey: 'k2' });
    await settle(service, b, 'tender-b');
    const reversal = { amountMinor: 100, attemptKey: 'r-1', batchOpen: false, ...noLedgerRefunds };
    const refund = await service.startReversal(scope, { ...reversal, saleIntentRef: a.intentRef });
    await settle(service, refund, 'refund-1');
    expect(
      await reasonOf(service.startReversal(scope, { ...reversal, saleIntentRef: b.intentRef }))
    ).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('blocks a second reversal while the first outcome is unknown', async () => {
    const { service, terminal, saleIntent } = await settledSale({ refundSale: ['HANG'] });
    const first = await service.startReversal(scope, {
      saleIntentRef: saleIntent.intentRef,
      amountMinor: 400,
      attemptKey: 'r-1',
      batchOpen: false,
      ...noLedgerRefunds,
    });
    expect(first.state).toBe('UNKNOWN');
    expect(
      await reasonOf(
        service.startReversal(scope, {
          saleIntentRef: saleIntent.intentRef,
          amountMinor: 400,
          attemptKey: 'r-2',
          batchOpen: false,
          ...noLedgerRefunds,
        })
      )
    ).toBe('REVERSAL_BLOCKED');
    expect(terminal.count('refundSale')).toBe(1);
  });

  it('blocks reversal of an approved charge that is not yet a tender', async () => {
    const { service } = setup({ sale: [approved()] });
    const intent = await service.startSale(scope, sale);
    expect(
      await service.planReversal(scope, intent.intentRef, {
        amountMinor: 1_000,
        batchOpen: true,
        ...noLedgerRefunds,
      })
    ).toEqual({ kind: 'BLOCKED', reason: 'SALE_NOT_SETTLED' });
  });

  it('blocks when the provider supports neither void nor refund', async () => {
    const { service, saleIntent } = await settledSale({ capabilities: ['SALE', 'STATUS'] });
    expect(
      await service.planReversal(scope, saleIntent.intentRef, {
        amountMinor: 1_000,
        batchOpen: true,
        ...noLedgerRefunds,
      })
    ).toEqual({ kind: 'BLOCKED', reason: 'REVERSAL_UNSUPPORTED' });
  });
});

describe('card-terminal logging (DEV-743)', () => {
  it('logs structured, redacted entries only', async () => {
    const { service, logs } = setup({ sale: [approved()] });
    await service.startSale(scope, sale);
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs);
    expect(text).not.toMatch(/\d{13,19}/);
    for (const entry of logs) expect(entry).toHaveProperty('event');
  });
});
