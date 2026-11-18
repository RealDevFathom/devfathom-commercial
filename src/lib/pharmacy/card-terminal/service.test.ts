import { describe, expect, it, vi } from 'vitest';

import { PharmacySettlementError } from '../settlement';
import {
  beginCardTerminalCharge,
  chargeCardTerminal,
  dispatchCardTerminalCharge,
  recoverCardTerminalAttempt,
  recoverOpenCardTerminalAttempts,
  resolveCardTerminalReview,
  type CardTerminalDeps,
} from './service';
import { createFakeTerminal } from './testing/fake-terminal';
import { createInMemoryAttemptStore, type InMemoryAttemptStore } from './testing/in-memory-store';
import type { CardTerminalAttemptStore } from './store';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
const input = {
  saleId: 'sale-1',
  deviceId: 'device-1',
  terminalId: 'counter-1',
  attemptKey: 'sale-1:card:0001',
  amountMinor: 1500,
  currency: 'PKR',
  businessDate: new Date('2026-11-18T00:00:00.000Z'),
};
const approved = {
  kind: 'APPROVED' as const,
  providerRef: 'RRN-000111222',
  amountMinor: 1500,
  approvalCode: 'A1B2C3',
  cardBrand: 'visa',
  cardLast4: '4242',
};

function setup(
  options: Parameters<typeof createInMemoryAttemptStore>[0] & { timeoutMs?: number } = {}
) {
  let clock = new Date('2026-11-18T10:00:00.000Z').getTime();
  const now = () => new Date(clock);
  const store = createInMemoryAttemptStore({ now, ...options });
  const terminal = createFakeTerminal();
  const log = vi.fn();
  const deps: CardTerminalDeps = {
    store,
    adapter: terminal,
    admission: { admittedProviders: ['FAKE_TERMINAL'] },
    now,
    timeoutMs: options.timeoutMs ?? 30,
    maxStatusChecks: 3,
    log,
  };
  return {
    store,
    terminal,
    deps,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const only = (store: InMemoryAttemptStore) => {
  const rows = store.all();
  expect(rows).toHaveLength(1);
  return rows[0];
};

describe('DEV-743 card terminal around one durable attempt (mocked end to end)', () => {
  it('commits the attempt before the terminal is asked to charge, then settles one tender', async () => {
    const { store, terminal, deps } = setup();
    let stateWhenCharged: string | undefined;
    terminal.startCharge = vi.fn(async () => {
      stateWhenCharged = only(store).status;
      return approved;
    });
    const result = await chargeCardTerminal(deps, scope, input);
    expect(stateWhenCharged).toBe('SENT');
    expect(result).toMatchObject({
      status: 'SETTLED',
      providerRef: 'RRN-000111222',
      approvalCode: 'A1B2C3',
      cardBrand: 'VISA',
      cardLast4: '4242',
      tenderId: 'tender-1',
    });
    expect(store.tenders).toEqual([
      {
        tenderId: 'tender-1',
        attemptId: result.id,
        providerRef: 'RRN-000111222',
        amountMinor: 1500,
      },
    ]);
  });

  it('uses the attempt id as the provider idempotency key and never charges a replay twice', async () => {
    const { store, terminal, deps } = setup();
    terminal.scriptCharge(approved);
    const first = await chargeCardTerminal(deps, scope, input);
    const replay = await chargeCardTerminal(deps, scope, input);
    expect(replay).toEqual(first);
    expect(terminal.charges).toEqual([
      { operationRef: first.id, terminalId: 'counter-1', amountMinor: 1500, currency: 'PKR' },
    ]);
    expect(store.tenders).toHaveLength(1);
  });

  it('lets exactly one of two racing dispatchers send the charge', async () => {
    const { store, terminal, deps } = setup();
    terminal.scriptCharge(approved, approved);
    await beginCardTerminalCharge(deps, scope, input);
    await Promise.all([
      dispatchCardTerminalCharge(deps, scope, input.attemptKey),
      dispatchCardTerminalCharge(deps, scope, input.attemptKey),
    ]);
    expect(terminal.charges).toHaveLength(1);
    expect(store.tenders).toHaveLength(1);
  });

  it('refuses a different payload under the same key and a second charge on the same sale', async () => {
    const { terminal, deps } = setup();
    terminal.scriptCharge({ kind: 'PENDING' });
    await chargeCardTerminal(deps, scope, input);
    await expect(
      beginCardTerminalCharge(deps, scope, { ...input, amountMinor: 1499 })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      beginCardTerminalCharge(deps, scope, { ...input, attemptKey: 'sale-1:card:0002' })
    ).rejects.toMatchObject({ reason: 'ATTEMPT_IN_PROGRESS' });
    expect(terminal.charges).toHaveLength(1);
  });

  it('fails closed with no record and no charge when the provider is not admitted', async () => {
    const { store, terminal, deps } = setup();
    for (const admission of [undefined, { admittedProviders: ['OTHER_TERMINAL'] }])
      await expect(chargeCardTerminal({ ...deps, admission }, scope, input)).rejects.toMatchObject({
        reason: 'UNCERTIFIED_PROVIDER',
      });
    expect(store.all()).toEqual([]);
    expect(terminal.charges).toEqual([]);
  });

  it('refuses an attempt that a different adapter would dispatch or recover', async () => {
    const { terminal, deps } = setup();
    terminal.scriptCharge({ kind: 'PENDING' });
    await chargeCardTerminal(deps, scope, input);
    const other = createFakeTerminal('OTHER_TERMINAL');
    const otherDeps = {
      ...deps,
      adapter: other,
      admission: { admittedProviders: ['OTHER_TERMINAL'] },
    };
    await expect(
      recoverCardTerminalAttempt(otherDeps, scope, input.attemptKey)
    ).rejects.toMatchObject({ reason: 'UNCERTIFIED_PROVIDER' });
    expect(other.queries).toEqual([]);
  });

  it.each([
    [{ kind: 'DECLINED' as const, declineCode: '05' }, 'DECLINED', '05'],
    [
      { kind: 'ERROR' as const, code: 'OFFLINE', reachedTerminal: false as const },
      'DECLINED',
      'ERROR:OFFLINE',
    ],
    [{ kind: 'ERROR' as const, code: 'IO', reachedTerminal: 'UNKNOWN' as const }, 'UNKNOWN', null],
    [{ kind: 'PENDING' as const }, 'UNKNOWN', null],
    [{ kind: 'THROW' as const, message: 'socket reset' }, 'UNKNOWN', null],
    [{ kind: 'HANG' as const }, 'UNKNOWN', null],
  ])('records %j as %s and never as a tender', async (answer, status, declineCode) => {
    const { store, terminal, deps } = setup();
    terminal.scriptCharge(answer);
    const result = await chargeCardTerminal(deps, scope, input);
    expect(result).toMatchObject({ status, declineCode, providerRef: null });
    expect(store.tenders).toEqual([]);
  });

  it('recovers a timed-out charge by status query and settles it without charging again', async () => {
    const { store, terminal, deps, advance } = setup();
    terminal.scriptCharge({ kind: 'HANG' });
    const unknown = await chargeCardTerminal(deps, scope, input);
    expect(unknown.status).toBe('UNKNOWN');
    terminal.scriptQuery(approved);
    advance(31);
    const recovered = await recoverCardTerminalAttempt(deps, scope, input.attemptKey);
    expect(recovered).toMatchObject({ status: 'SETTLED', providerRef: 'RRN-000111222' });
    expect(terminal.charges).toHaveLength(1);
    expect(terminal.queries).toEqual([{ operationRef: unknown.id, terminalId: 'counter-1' }]);
    expect(store.tenders).toHaveLength(1);
    // Recovering a settled attempt is a no-op.
    await recoverCardTerminalAttempt(deps, scope, input.attemptKey);
    expect(terminal.queries).toHaveLength(1);
  });

  it('treats NOT_FOUND as "not charged" only after the grace period', async () => {
    const { terminal, deps, advance } = setup();
    terminal.scriptCharge({ kind: 'PENDING' });
    await chargeCardTerminal(deps, scope, input);
    terminal.scriptQuery({ kind: 'NOT_FOUND' }, { kind: 'NOT_FOUND' });
    advance(31);
    expect(await recoverCardTerminalAttempt(deps, scope, input.attemptKey)).toMatchObject({
      status: 'UNKNOWN',
      statusChecks: 1,
    });
    advance(30);
    expect(await recoverCardTerminalAttempt(deps, scope, input.attemptKey)).toMatchObject({
      status: 'DECLINED',
      declineCode: 'NOT_FOUND',
    });
  });

  it('hands an attempt to a person after repeated inconclusive status checks', async () => {
    const { terminal, deps } = setup();
    terminal.scriptCharge({ kind: 'PENDING' });
    await chargeCardTerminal(deps, scope, input);
    terminal.scriptQuery({ kind: 'PENDING' }, { kind: 'THROW', message: 'x' }, { kind: 'HANG' });
    await recoverCardTerminalAttempt(deps, scope, input.attemptKey);
    await recoverCardTerminalAttempt(deps, scope, input.attemptKey);
    const last = await recoverCardTerminalAttempt(deps, scope, input.attemptKey);
    expect(last).toMatchObject({
      status: 'MANUAL_REVIEW',
      statusChecks: 3,
      reviewReason: 'Terminal outcome still unknown after 3 status checks',
    });
    // Still holds the sale: no new charge may start.
    await expect(
      beginCardTerminalCharge(deps, scope, { ...input, attemptKey: 'sale-1:card:0002' })
    ).rejects.toMatchObject({ reason: 'ATTEMPT_IN_PROGRESS' });
  });

  it('does not query a SENT attempt whose dispatcher may still be waiting', async () => {
    const { store, terminal, deps } = setup();
    terminal.startCharge = vi.fn(async () => {
      expect(await recoverCardTerminalAttempt(deps, scope, input.attemptKey)).toMatchObject({
        status: 'SENT',
      });
      return approved;
    });
    await chargeCardTerminal(deps, scope, input);
    expect(terminal.queries).toEqual([]);
    expect(store.tenders).toHaveLength(1);
  });

  it('closes a crash-stale CREATED attempt and never dispatches it late', async () => {
    const { terminal, deps, advance } = setup();
    await beginCardTerminalCharge(deps, scope, input);
    advance(31);
    expect(await dispatchCardTerminalCharge(deps, scope, input.attemptKey)).toMatchObject({
      status: 'ABANDONED',
    });
    expect(terminal.charges).toEqual([]);
  });

  it('discards an approval that carries card data and sends it for review', async () => {
    const { store, terminal, deps, log } = setup();
    terminal.scriptCharge({ ...approved, providerRef: '4111111111111111' });
    const result = await chargeCardTerminal(deps, scope, input);
    expect(result).toMatchObject({
      status: 'MANUAL_REVIEW',
      providerRef: null,
      cardLast4: null,
      reviewReason: 'Terminal approval carried card data and was discarded',
    });
    expect(JSON.stringify(store.all())).not.toContain('4111111111111111');
    expect(JSON.stringify(log.mock.calls)).not.toContain('4111111111111111');
    expect(store.tenders).toEqual([]);
  });

  it('keeps evidence but sends a different approved amount for review', async () => {
    const { store, terminal, deps } = setup();
    terminal.scriptCharge({ ...approved, amountMinor: 1600, cardLast4: '12345' });
    const result = await chargeCardTerminal(deps, scope, input);
    expect(result).toMatchObject({
      status: 'MANUAL_REVIEW',
      providerRef: 'RRN-000111222',
      cardLast4: null,
      reviewReason: 'Terminal approved a different amount',
    });
    expect(store.tenders).toEqual([]);
  });

  it('sends an approval that settlement permanently refuses for review', async () => {
    const { store, terminal, deps } = setup({
      beforeSettle: () => {
        throw new PharmacySettlementError('OVER_TENDER');
      },
    });
    terminal.scriptCharge(approved);
    expect(await chargeCardTerminal(deps, scope, input)).toMatchObject({
      status: 'MANUAL_REVIEW',
      providerRef: 'RRN-000111222',
      reviewReason: 'Approved charge could not be recorded: OVER_TENDER',
    });
    expect(store.tenders).toEqual([]);
  });

  it('keeps an approval after a transient settlement failure and settles it on recovery', async () => {
    let fail = true;
    const { store, terminal, deps } = setup({
      beforeSettle: () => {
        if (fail) throw new Error('connection lost');
      },
    });
    terminal.scriptCharge(approved);
    expect(await chargeCardTerminal(deps, scope, input)).toMatchObject({ status: 'APPROVED' });
    fail = false;
    const settled = await recoverOpenCardTerminalAttempts(deps, scope);
    expect(settled).toMatchObject([{ status: 'SETTLED' }]);
    expect(terminal.charges).toHaveLength(1);
    expect(terminal.queries).toEqual([]);
    expect(store.tenders).toHaveLength(1);
  });

  it('keeps recovering the rest of the branch when one attempt fails', async () => {
    const { deps } = setup();
    const store: CardTerminalAttemptStore = {
      ...deps.store,
      listOpen: async () => [
        { attemptKey: 'missing-attempt-1', status: 'UNKNOWN', id: 'x' } as never,
      ],
    };
    const result = await recoverOpenCardTerminalAttempts({ ...deps, store }, scope);
    expect(result).toHaveLength(1);
    expect(deps.log).toHaveBeenCalledWith(
      'card_terminal.recover_failed',
      expect.objectContaining({ attemptId: 'x' })
    );
  });

  it.each([
    { attemptKey: 'short' },
    { amountMinor: 0 },
    { amountMinor: 1.5 },
    { currency: 'pkr' },
    { currency: 'USD' },
    { terminalId: '4111111111111111' },
  ])('refuses invalid input %j before writing anything', async (patch) => {
    const { store, deps } = setup();
    await expect(
      beginCardTerminalCharge(deps, scope, { ...input, ...patch })
    ).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
    expect(store.all()).toEqual([]);
  });

  describe('resolution of a manual review by a manager or owner', () => {
    const approval = { policy: 'PHARMACY_CARD_TERMINAL_REVIEW_MANAGER_PIN', pinVerified: true };
    const manager = { ...scope, actorId: 'manager-1' };

    async function reviewAfterUnknown() {
      const context = setup();
      context.terminal.scriptCharge({ kind: 'PENDING' });
      await chargeCardTerminal(context.deps, scope, input);
      context.terminal.scriptQuery({ kind: 'PENDING' }, { kind: 'PENDING' }, { kind: 'PENDING' });
      for (let check = 0; check < 3; check += 1)
        await recoverCardTerminalAttempt(context.deps, scope, input.attemptKey);
      expect(only(context.store).status).toBe('MANUAL_REVIEW');
      return context;
    }

    it('records "nothing was charged", frees the sale and never calls the terminal', async () => {
      const { store, terminal, deps } = await reviewAfterUnknown();
      const charges = terminal.charges.length;
      const queries = terminal.queries.length;
      const resolved = await resolveCardTerminalReview(
        deps,
        manager,
        {
          attemptKey: input.attemptKey,
          outcome: 'DECLINED',
          reason: 'Slip shows declined',
          slipRef: 'SLIP-77',
        },
        approval
      );
      expect(resolved).toMatchObject({
        status: 'DECLINED',
        providerRef: null,
        resolvedById: 'manager-1',
        resolutionReason: 'Slip shows declined',
        resolutionRef: 'SLIP-77',
      });
      expect(terminal.charges).toHaveLength(charges);
      expect(terminal.queries).toHaveLength(queries);
      expect(store.audits.at(-1)).toEqual({
        attemptId: resolved.id,
        from: 'MANUAL_REVIEW',
        to: 'DECLINED',
        detail: approval,
      });
      // The sale may take another tender now.
      await expect(
        beginCardTerminalCharge(deps, scope, { ...input, attemptKey: 'sale-1:card:0002' })
      ).resolves.toMatchObject({ created: true });
    });

    it('records money taken against the slip reference for a refund through the provider', async () => {
      const { deps } = await reviewAfterUnknown();
      await expect(
        resolveCardTerminalReview(
          deps,
          manager,
          {
            attemptKey: input.attemptKey,
            outcome: 'REVERSED',
            reason: 'Customer was charged',
            slipRef: 'RRN-9',
          },
          approval
        )
      ).resolves.toMatchObject({
        status: 'REVERSED',
        providerRef: 'RRN-9',
        resolutionRef: 'RRN-9',
      });
    });

    it('never records "not charged" for an attempt with the terminal’s charge reference', async () => {
      const { store, terminal, deps } = setup();
      terminal.scriptCharge({ ...approved, amountMinor: 1600 });
      await chargeCardTerminal(deps, scope, input);
      const review = {
        attemptKey: input.attemptKey,
        reason: 'Checked slip',
        slipRef: 'RRN-000111222',
      };
      await expect(
        resolveCardTerminalReview(deps, manager, { ...review, outcome: 'DECLINED' }, approval)
      ).rejects.toMatchObject({ reason: 'CHARGE_EVIDENCE_RECORDED' });
      await expect(
        resolveCardTerminalReview(
          deps,
          manager,
          { ...review, outcome: 'REVERSED', slipRef: 'RRN-OTHER' },
          approval
        )
      ).rejects.toMatchObject({ reason: 'SLIP_REFERENCE_MISMATCH' });
      expect(only(store).status).toBe('MANUAL_REVIEW');
      await expect(
        resolveCardTerminalReview(deps, manager, { ...review, outcome: 'REVERSED' }, approval)
      ).resolves.toMatchObject({ status: 'REVERSED', providerRef: 'RRN-000111222' });
    });

    it('never lets the person who took the charge resolve it, unless they are the sole approver', async () => {
      const { store, deps } = await reviewAfterUnknown();
      const own = {
        attemptKey: input.attemptKey,
        outcome: 'DECLINED' as const,
        reason: 'Slip shows declined',
        slipRef: 'SLIP-1',
      };
      // `scope` is the cashier who started this charge.
      await expect(resolveCardTerminalReview(deps, scope, own, approval)).rejects.toMatchObject({
        reason: 'OWN_CHARGE_NEEDS_ANOTHER_APPROVER',
      });
      await expect(
        resolveCardTerminalReview(deps, scope, own, approval, async () => false)
      ).rejects.toMatchObject({ reason: 'OWN_CHARGE_NEEDS_ANOTHER_APPROVER' });
      expect(only(store).status).toBe('MANUAL_REVIEW');
      await expect(
        resolveCardTerminalReview(deps, scope, own, approval, async () => true)
      ).resolves.toMatchObject({ status: 'DECLINED', resolvedById: 'cashier-1' });
    });

    it('lets exactly one of two racing resolutions win', async () => {
      const { store, deps } = await reviewAfterUnknown();
      const resolve = (outcome: 'DECLINED' | 'REVERSED') =>
        resolveCardTerminalReview(
          deps,
          manager,
          { attemptKey: input.attemptKey, outcome, reason: 'Checked the slip', slipRef: 'RRN-55' },
          approval
        );
      const outcomes = await Promise.allSettled([resolve('DECLINED'), resolve('REVERSED')]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const [refused] = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect((refused as PromiseRejectedResult).reason).toMatchObject({
        reason: 'REVIEW_NOT_OPEN',
      });
      expect(store.audits.filter((entry) => entry.from === 'MANUAL_REVIEW')).toHaveLength(1);
    });

    it.each([
      { reason: 'no' },
      { reason: 'x'.repeat(201) },
      { slipRef: '' },
      { slipRef: 'has space' },
      { slipRef: '4111111111111111' },
      { reason: 'card 4111111111111111' },
    ])('refuses %j before changing anything', async (patch) => {
      const { store, deps } = await reviewAfterUnknown();
      await expect(
        resolveCardTerminalReview(
          deps,
          manager,
          {
            attemptKey: input.attemptKey,
            outcome: 'DECLINED',
            reason: 'Slip checked',
            slipRef: 'S-1',
            ...patch,
          },
          approval
        )
      ).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
      expect(only(store).status).toBe('MANUAL_REVIEW');
    });

    it('refuses an attempt that is not waiting for review', async () => {
      const { terminal, deps } = setup();
      terminal.scriptCharge(approved);
      await chargeCardTerminal(deps, scope, input);
      await expect(
        resolveCardTerminalReview(
          deps,
          manager,
          {
            attemptKey: input.attemptKey,
            outcome: 'REVERSED',
            reason: 'Checked',
            slipRef: 'RRN-000111222',
          },
          approval
        )
      ).rejects.toMatchObject({ reason: 'REVIEW_NOT_OPEN' });
    });
  });

  it('leaves one audit entry for every committed outcome', async () => {
    const { store, terminal, deps } = setup();
    terminal.scriptCharge({ kind: 'PENDING' });
    await chargeCardTerminal(deps, scope, input);
    terminal.scriptQuery(approved);
    await recoverCardTerminalAttempt(deps, scope, input.attemptKey);
    expect(store.audits.map((entry) => `${entry.from}>${entry.to}`)).toEqual([
      'null>CREATED',
      'CREATED>SENT',
      'SENT>UNKNOWN',
      'UNKNOWN>APPROVED',
      'APPROVED>SETTLED',
    ]);
  });
});
