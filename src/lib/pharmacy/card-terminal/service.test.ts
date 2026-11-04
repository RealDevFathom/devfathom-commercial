import { describe, expect, it } from 'vitest';

import { terminalAdmissionRefusal, PRODUCTION_TERMINAL_ADMISSION } from './contract';
import { refundIdempotencyKeyFor, tenderIdempotencyKeyFor, TerminalIntentError } from './intent';
import { createCardTerminalService } from './service';
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

function setup(script: Parameters<typeof createScriptedTerminal>[0] = {}, clockStart = 0) {
  const terminal = createScriptedTerminal({ claimCertified: true, ...script });
  const store = createInMemoryTerminalIntentStore();
  let clock = Date.parse('2026-11-04T10:00:00.000Z') + clockStart;
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

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as TerminalIntentError).reason;
  }
};

describe('card-terminal admission (DEV-743)', () => {
  it('admits no provider in production by default, whatever it claims', () => {
    const { provider } = createScriptedTerminal({ claimCertified: true });
    expect(PRODUCTION_TERMINAL_ADMISSION.admittedProviders).toHaveLength(0);
    expect(Object.isFrozen(PRODUCTION_TERMINAL_ADMISSION.admittedProviders)).toBe(true);
    expect(terminalAdmissionRefusal(provider, undefined, 'production')).toBe(
      'SIMULATED_PROVIDER_IN_PRODUCTION'
    );
    expect(
      terminalAdmissionRefusal({ ...provider, simulated: undefined }, undefined, 'production')
    ).toBe('NOT_ADMITTED');
    expect(terminalAdmissionRefusal(provider, TEST_ONLY_ADMISSION, 'production')).toBe(
      'SIMULATED_PROVIDER_IN_PRODUCTION'
    );
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
      recovery: { maxAttempts: 3, notFoundGraceMs: 1 },
    });
    expect(service.providerAdmitted).toBe(false);
    expect(await reasonOf(service.startSale(scope, sale))).toBe('PROVIDER_NOT_ADMITTED');
    expect(terminal.calls).toHaveLength(0);
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
    await service.recordSettlement(scope.organizationId, first.intentRef, 'tender-a');
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

  it('treats a thrown provider error as UNKNOWN, not as a decline', async () => {
    const { service } = setup({ sale: ['THROW'] });
    expect((await service.startSale(scope, sale)).state).toBe('UNKNOWN');
  });

  it('recovers an unknown outcome by status query', async () => {
    const { service, terminal } = setup({
      sale: ['HANG'],
      status: [{ kind: 'PENDING' }, approved()],
    });
    const unknown = await service.startSale(scope, sale);
    expect((await service.recover(scope.organizationId, unknown.intentRef)).state).toBe('PENDING');
    const recovered = await service.recover(scope.organizationId, unknown.intentRef);
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
    expect((await service.recover(scope.organizationId, unknown.intentRef)).state).toBe('UNKNOWN');
    advance(60_000);
    expect((await service.recover(scope.organizationId, unknown.intentRef)).state).toBe('FAILED');
  });

  it('escalates to manual review, then accepts an operator decision with evidence', async () => {
    const { service } = setup({ sale: ['HANG'], status: ['HANG', 'THROW', { kind: 'PENDING' }] });
    const unknown = await service.startSale(scope, sale);
    await service.recover(scope.organizationId, unknown.intentRef);
    await service.recover(scope.organizationId, unknown.intentRef);
    const review = await service.recover(scope.organizationId, unknown.intentRef);
    expect(review).toMatchObject({ state: 'MANUAL_REVIEW', recoveryAttempts: 3 });
    expect(await service.unresolved(scope.organizationId, scope.branchId)).toHaveLength(1);
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
    expect((await service.recover('org-1', 'pti_sale_crashed')).state).toBe('FAILED');
    expect(terminal.calls).toHaveLength(0);
  });

  it('keeps tenants apart', async () => {
    const { service } = setup({ sale: [approved()] });
    const intent = await service.startSale(scope, sale);
    expect(await reasonOf(service.recover('org-2', intent.intentRef))).toBe('INTENT_NOT_FOUND');
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
  });
});

describe('card-terminal settlement hand-off (DEV-743)', () => {
  it('replays an approved outcome for the bound tender key only', async () => {
    const { service, terminal } = setup({ sale: [approved()] });
    const intent = await service.startSale(scope, sale);
    const adapter = service.settlementAdapter(intent);
    expect(adapter).toMatchObject({ name: 'SCRIPTED_TERMINAL', certified: true });
    const request = {
      capability: 'SALE' as const,
      amountMinor: 1_000,
      operationRef: tenderIdempotencyKeyFor(intent),
    };
    expect(await adapter.execute(request)).toEqual({ approved: true, providerRef: 'prov-sale-1' });
    expect(await adapter.execute({ ...request, amountMinor: 999 })).toMatchObject({
      approved: false,
    });
    expect(await adapter.execute({ ...request, operationRef: 'other' })).toMatchObject({
      approved: false,
    });
    expect(await adapter.execute({ ...request, capability: 'REFUND' })).toMatchObject({
      approved: false,
    });
    // The hand-off never calls the terminal again.
    expect(terminal.count('startSale')).toBe(1);
  });

  it('refuses a hand-off for an intent that is not approved', async () => {
    const { service } = setup({ sale: ['HANG'] });
    const intent = await service.startSale(scope, sale);
    const result = await service
      .settlementAdapter(intent)
      .execute({
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
      recovery: { maxAttempts: 1, notFoundGraceMs: 1 },
    });
    expect(service.providerAdmitted).toBe(false);
  });
});

describe('card-terminal void and refund contract (DEV-743)', () => {
  async function settledSale(script: Parameters<typeof createScriptedTerminal>[0]) {
    const ctx = setup({ sale: [approved()], ...script });
    const intent = await ctx.service.startSale(scope, sale);
    await ctx.service.recordSettlement(scope.organizationId, intent.intentRef, 'tender-1');
    return { ...ctx, saleIntent: intent };
  }

  it('voids a full same-batch reversal and refunds a partial one', async () => {
    const { service, saleIntent } = await settledSale({});
    expect(
      await service.planReversal(scope.organizationId, saleIntent.intentRef, {
        amountMinor: 1_000,
        batchOpen: true,
      })
    ).toMatchObject({ kind: 'VOID' });
    expect(
      await service.planReversal(scope.organizationId, saleIntent.intentRef, {
        amountMinor: 1_000,
        batchOpen: false,
      })
    ).toMatchObject({ kind: 'REFUND' });
    expect(
      await service.planReversal(scope.organizationId, saleIntent.intentRef, {
        amountMinor: 400,
        batchOpen: true,
      })
    ).toMatchObject({ kind: 'REFUND', remainingAfterMinor: 600 });
    expect(
      await service.planReversal(scope.organizationId, saleIntent.intentRef, {
        amountMinor: 1_001,
        batchOpen: true,
      })
    ).toEqual({ kind: 'BLOCKED', reason: 'EXCEEDS_REMAINING' });
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
    const adapter = service.settlementAdapter(refund);
    expect(
      await adapter.execute({
        capability: 'REFUND',
        amountMinor: 400,
        operationRef: refundIdempotencyKeyFor(refund),
        priorRef: 'prov-sale-1',
      })
    ).toEqual({ approved: true, providerRef: 'prov-refund-1' });
    expect(
      await adapter.execute({
        capability: 'REFUND',
        amountMinor: 400,
        operationRef: refundIdempotencyKeyFor(refund),
        priorRef: 'someone-elses-sale',
      })
    ).toMatchObject({ approved: false });
  });

  it('blocks a second reversal while the first outcome is unknown', async () => {
    const { service, terminal, saleIntent } = await settledSale({ refundSale: ['HANG'] });
    const first = await service.startReversal(scope, {
      saleIntentRef: saleIntent.intentRef,
      amountMinor: 400,
      attemptKey: 'r-1',
      batchOpen: false,
    });
    expect(first.state).toBe('UNKNOWN');
    expect(
      await reasonOf(
        service.startReversal(scope, {
          saleIntentRef: saleIntent.intentRef,
          amountMinor: 400,
          attemptKey: 'r-2',
          batchOpen: false,
        })
      )
    ).toBe('REVERSAL_BLOCKED');
    expect(terminal.count('refundSale')).toBe(1);
  });

  it('blocks reversal of an approved charge that is not yet a tender', async () => {
    const { service } = setup({ sale: [approved()] });
    const intent = await service.startSale(scope, sale);
    expect(
      await service.planReversal(scope.organizationId, intent.intentRef, {
        amountMinor: 1_000,
        batchOpen: true,
      })
    ).toEqual({ kind: 'BLOCKED', reason: 'SALE_NOT_SETTLED' });
  });

  it('blocks when the provider supports neither void nor refund', async () => {
    const { service, saleIntent } = await settledSale({ capabilities: ['SALE', 'STATUS'] });
    expect(
      await service.planReversal(scope.organizationId, saleIntent.intentRef, {
        amountMinor: 1_000,
        batchOpen: true,
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
