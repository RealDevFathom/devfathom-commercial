/**
 * DEV-743: the card-terminal router, mocked end to end. The fake terminal and an in-memory
 * attempt store that enforces the migration's rules stand in for a device and PostgreSQL; the
 * service, the router and its access check order are the real ones. No provider, SDK or device.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const tenancy = vi.hoisted(() => ({
  withTenantDb: vi.fn(
    async (...args: [organizationId: string, work: (db: unknown) => unknown, options?: object]) =>
      args[1]({})
  ),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(),
  withTenantDb: tenancy.withTenantDb,
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));

const harness = vi.hoisted(() => ({
  requireCounterReceiptAccess: vi.fn(),
  failPharmacySale: vi.fn((error: unknown) => {
    throw error;
  }),
  resolve: vi.fn(),
  store: null as unknown,
  runners: [] as Array<(work: (db: unknown) => Promise<unknown>) => Promise<unknown>>,
}));
vi.mock('./pharmacy-sales', () => ({
  requireCounterReceiptAccess: harness.requireCounterReceiptAccess,
  failPharmacySale: harness.failPharmacySale,
}));
const refundAuth = vi.hoisted(() => ({
  actorMayRefund: vi.fn(async (): Promise<boolean> => false),
  authenticateRefundPin: vi.fn(async (): Promise<{ verified: true } | { blocked: string }> => ({
    verified: true,
  })),
}));
vi.mock('@/lib/pharmacy/refund-authorization', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/refund-authorization')>()),
  actorMayRefund: refundAuth.actorMayRefund,
  authenticateRefundPin: refundAuth.authenticateRefundPin,
}));
const approvers = vi.hoisted(() => ({
  // Who else could resolve a review at this branch. A staffed pharmacy unless a test says so.
  others: vi.fn(async (): Promise<{ id: string; name: string | null }[]> => [
    { id: 'manager-b', name: 'Ayesha Khan' },
  ]),
}));
vi.mock('@/lib/pharmacy/card-terminal/review-approvers', () => ({
  otherCardTerminalReviewers: approvers.others,
}));
vi.mock('@/lib/pharmacy/card-terminal/registry', () => ({
  resolvePharmacyCardTerminal: harness.resolve,
}));
vi.mock('@/lib/pharmacy/card-terminal/store', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/card-terminal/store')>()),
  // The router's store is the in-memory one, which enforces the migration's rules.
  prismaCardTerminalAttemptStore: (
    run: (work: (db: unknown) => Promise<unknown>) => Promise<unknown>
  ) => {
    harness.runners.push(run);
    return harness.store;
  },
}));

import { TRPCError } from '@trpc/server';

import {
  createInMemoryAttemptStore,
  type InMemoryAttemptStore,
} from '@/lib/pharmacy/card-terminal/testing/in-memory-store';
import {
  createFakeTerminal,
  type FakeTerminal,
} from '@/lib/pharmacy/card-terminal/testing/fake-terminal';
import { CARD_TERMINAL_TIMEOUT_MS } from '@/lib/pharmacy/card-terminal/timing';
import { annotateAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import {
  CARD_TERMINAL_REVIEW_FORBIDDEN,
  CARD_TERMINAL_REVIEW_OWN_CHARGE,
  CARD_TERMINAL_REVIEW_PIN_POLICY,
  COUNTER_TERMINAL_TIMEOUT_MS,
  pharmacyCardTerminalRouter,
} from './pharmacy-card-terminal';

const app = router({ pharmacyCardTerminal: pharmacyCardTerminalRouter });
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };
const businessDate = new Date('2026-11-18T00:00:00.000Z');

const managerMembership = async () => ({
  role: 'ADMIN',
  status: 'ACTIVE',
  organizationRole: {
    isSystem: false,
    key: 'review-manager',
    permissions: [
      { capability: 'admin:access', effect: 'ALLOW' },
      { capability: 'finance:manage', effect: 'ALLOW' },
    ],
  },
  permissionOverrides: [],
});
const requestDb = {
  user: {
    findUnique: vi.fn(managerMembership),
  },
  pharmacyTerminalRefundEvent: {
    findFirst: vi.fn(async () => ({ actorId: scope.actorId, attemptId: 'reviewed' })),
  },
  pharmacyCardTerminalAttempt: {
    findFirst: vi.fn(async () => ({
      id: 'reviewed',
      actorId: 'cashier',
      resolvedById: scope.actorId,
    })),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(requestDb)),
};

function caller(accountsManager = false) {
  const db = requestDb;
  const context = {
    db,
    entitlements: {
      organizationId: 'org-a',
      enabledModules: accountsManager
        ? ['pharmacy-counter', 'pharmacy-finance']
        : ['pharmacy-counter'],
      modules: [],
    },
    session: {
      expires: 'later',
      user: {
        id: 'user-a',
        role: accountsManager ? 'ADMIN' : 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return app.createCaller(context as unknown as TRPCContext).pharmacyCardTerminal;
}

let terminal: FakeTerminal;
let store: InMemoryAttemptStore;

const chargeInput = (attemptKey: string, amountMinor = 1500) => ({
  branchId: 'branch-a',
  saleId: 'sale-1',
  deviceId: 'counter-device-1',
  businessDate,
  amountMinor,
  attemptKey,
});

beforeEach(() => {
  vi.clearAllMocks();
  refundAuth.actorMayRefund.mockResolvedValue(false);
  refundAuth.authenticateRefundPin.mockResolvedValue({ verified: true });
  approvers.others.mockResolvedValue([{ id: 'manager-b', name: 'Ayesha Khan' }]);
  harness.runners = [];
  terminal = createFakeTerminal();
  store = createInMemoryAttemptStore({ saleRemaining: () => 1500 });
  harness.store = store;
  harness.requireCounterReceiptAccess.mockResolvedValue(scope);
  harness.resolve.mockResolvedValue({
    adapter: terminal,
    terminalId: 'paired-terminal-1',
    admission: { admittedProviders: ['FAKE_TERMINAL'] },
  });
});

describe('DEV-743 card-terminal router', () => {
  it('is unavailable, and charges nothing, while no terminal is bound (production today)', async () => {
    harness.resolve.mockResolvedValue(null);
    await expect(
      caller().availability({ branchId: 'branch-a', deviceId: 'counter-device-1' })
    ).resolves.toEqual({ available: false, currency: 'PKR', mayResolveReview: false });
    await expect(caller().charge(chargeInput('card-terminal:k-unbound'))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'UNCERTIFIED_PROVIDER',
    });
    expect(store.all()).toEqual([]);
  });

  it('is unavailable for a terminal outside its admission list', async () => {
    harness.resolve.mockResolvedValue({ adapter: terminal, terminalId: 'paired-terminal-1' });
    await expect(
      caller().availability({ branchId: 'branch-a', deviceId: 'counter-device-1' })
    ).resolves.toEqual({ available: false, currency: 'PKR', mayResolveReview: false });
    await expect(caller().charge(chargeInput('card-terminal:k-unadmitted'))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(terminal.charges).toEqual([]);
  });

  it('dispatches one PKR charge to the paired terminal and records it as one tender', async () => {
    terminal.scriptCharge({
      kind: 'APPROVED',
      providerRef: 'RRN-1',
      amountMinor: 1500,
      cardBrand: 'Visa',
      cardLast4: '4242',
    });
    await expect(
      caller().availability({ branchId: 'branch-a', deviceId: 'counter-device-1' })
    ).resolves.toEqual({ available: true, currency: 'PKR', mayResolveReview: false });
    // A manager or owner is told they may resolve a review; the server checks again.
    refundAuth.actorMayRefund.mockResolvedValueOnce(true);
    await expect(
      caller().availability({ branchId: 'branch-a', deviceId: 'counter-device-1' })
    ).resolves.toMatchObject({ mayResolveReview: true });
    const paid = await caller().charge(chargeInput('card-terminal:k-approve'));
    expect(paid).toMatchObject({
      phase: 'PAID',
      open: false,
      canCheckStatus: false,
      cardBrand: 'VISA',
      cardLast4: '4242',
      currency: 'PKR',
    });
    // The view never carries the provider reference or the terminal id.
    expect(JSON.stringify(paid)).not.toMatch(/RRN-1|paired-terminal-1/);
    const [attempt] = store.all();
    expect(terminal.charges).toEqual([
      {
        operationRef: attempt!.id,
        terminalId: 'paired-terminal-1',
        amountMinor: 1500,
        currency: 'PKR',
      },
    ]);
    expect(store.tenders).toHaveLength(1);
    // A replay of the same click returns the recorded attempt and never charges again.
    await expect(caller().charge(chargeInput('card-terminal:k-approve'))).resolves.toMatchObject({
      phase: 'PAID',
    });
    expect(terminal.charges).toHaveLength(1);
    expect(store.tenders).toHaveLength(1);
    await expect(
      caller().attempt({ branchId: 'branch-a', saleId: 'sale-1' })
    ).resolves.toMatchObject({ attemptKey: 'card-terminal:k-approve', phase: 'PAID' });
  });

  it('shows a lost answer as unknown and resolves it by status check, never a second charge', async () => {
    terminal.scriptCharge({ kind: 'ERROR', code: 'TIMEOUT', reachedTerminal: 'UNKNOWN' });
    const unknown = await caller().charge(chargeInput('card-terminal:k-unknown'));
    expect(unknown).toMatchObject({ phase: 'UNKNOWN', open: true, canCheckStatus: true });
    expect(store.tenders).toEqual([]);

    // While it is open, the sale takes no second terminal charge.
    await expect(caller().charge(chargeInput('card-terminal:k-second'))).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'ATTEMPT_IN_PROGRESS',
    });

    terminal.scriptQuery({ kind: 'PENDING' });
    await expect(
      caller().checkStatus({ branchId: 'branch-a', attemptKey: 'card-terminal:k-unknown' })
    ).resolves.toMatchObject({ phase: 'UNKNOWN', statusChecks: 1, canCheckStatus: true });

    terminal.scriptQuery({ kind: 'APPROVED', providerRef: 'RRN-2', amountMinor: 1500 });
    await expect(
      caller().checkStatus({ branchId: 'branch-a', attemptKey: 'card-terminal:k-unknown' })
    ).resolves.toMatchObject({ phase: 'PAID', open: false });
    expect(terminal.charges).toHaveLength(1);
    expect(terminal.queries.map((query) => query.operationRef)).toEqual([
      store.all()[0]!.id,
      store.all()[0]!.id,
    ]);
    expect(store.tenders).toEqual([
      expect.objectContaining({ providerRef: 'RRN-2', amountMinor: 1500 }),
    ]);
  });

  it('holds an approval for a different amount for manual review, with no status check', async () => {
    terminal.scriptCharge({ kind: 'APPROVED', providerRef: 'RRN-3', amountMinor: 1400 });
    await expect(caller().charge(chargeInput('card-terminal:k-review'))).resolves.toMatchObject({
      phase: 'MANUAL_REVIEW',
      open: true,
      canCheckStatus: false,
      reviewReason: 'Terminal approved a different amount',
    });
    await caller().checkStatus({ branchId: 'branch-a', attemptKey: 'card-terminal:k-review' });
    expect(terminal.queries).toEqual([]);
    expect(store.tenders).toEqual([]);
    await expect(caller().charge(chargeInput('card-terminal:k-after'))).rejects.toMatchObject({
      message: 'ATTEMPT_IN_PROGRESS',
    });
  });

  it('declines without a tender and frees the sale for the next payment', async () => {
    terminal.scriptCharge({ kind: 'DECLINED', declineCode: '05' });
    await expect(caller().charge(chargeInput('card-terminal:k-declined'))).resolves.toMatchObject({
      phase: 'DECLINED',
      open: false,
      declineCode: '05',
    });
    terminal.scriptCharge({ kind: 'APPROVED', providerRef: 'RRN-4', amountMinor: 1500 });
    await expect(caller().charge(chargeInput('card-terminal:k-retry'))).resolves.toMatchObject({
      phase: 'PAID',
    });
    expect(store.tenders).toHaveLength(1);
  });

  it('checks counter access before resolving a terminal or touching the store', async () => {
    harness.requireCounterReceiptAccess.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' })
    );
    await expect(caller().charge(chargeInput('card-terminal:k-denied'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller().checkStatus({ branchId: 'branch-a', attemptKey: 'card-terminal:k-denied' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller().attempt({ branchId: 'branch-a', saleId: 'sale-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(harness.resolve).not.toHaveBeenCalled();
    expect(terminal.charges).toEqual([]);
  });

  it('never lets the browser choose the currency, provider or terminal', async () => {
    for (const extra of [{ currency: 'USD' }, { provider: 'OTHER' }, { terminalId: 'mine' }])
      await expect(
        caller().charge({ ...chargeInput('card-terminal:k-extra'), ...extra } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().charge(chargeInput('short'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(store.all()).toEqual([]);
  });

  it('answers an unknown attempt as not found', async () => {
    await expect(
      caller().checkStatus({ branchId: 'branch-a', attemptKey: 'card-terminal:k-missing' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'ATTEMPT_NOT_FOUND' });
    await expect(caller().attempt({ branchId: 'branch-a', saleId: 'sale-1' })).resolves.toBeNull();
  });

  it('commits every attempt step in its own tenant transaction, never the request transaction', async () => {
    terminal.scriptCharge({ kind: 'APPROVED', providerRef: 'RRN-5', amountMinor: 1500 });
    await caller().charge(chargeInput('card-terminal:k-commit'));
    expect(harness.runners.length).toBeGreaterThan(0);
    // The request runs inside one transaction; a nested `ctx.db.$transaction` would reuse it, so
    // CREATED and SENT would not be committed while the terminal charges.
    for (const run of harness.runners) {
      const work = vi.fn(async () => 'done');
      await expect(run(work)).resolves.toBe('done');
    }
    expect(tenancy.withTenantDb).toHaveBeenCalledTimes(harness.runners.length);
    for (const call of tenancy.withTenantDb.mock.calls)
      expect([call[0], call[2]]).toEqual(['org-a', { userId: 'user-a' }]);
    expect(requestDb.$transaction).not.toHaveBeenCalled();
  });

  it('gives up on the terminal inside the 60-second request transaction', () => {
    expect(COUNTER_TERMINAL_TIMEOUT_MS).toBeLessThan(60_000);
    expect(COUNTER_TERMINAL_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('shares one timeout with the recovery sweep', () => {
    expect(COUNTER_TERMINAL_TIMEOUT_MS).toBe(CARD_TERMINAL_TIMEOUT_MS);
  });

  describe('resolveReview', () => {
    /** An attempt whose outcome stayed unknown until it was handed to a person. */
    /** By default a counter cashier took the charge, so the resolver is a second person. */
    async function underReview(attemptKey = 'card-terminal:k-review', takenBy = 'cashier-z') {
      const { attempt } = await store.create(
        { ...scope, actorId: takenBy },
        {
          saleId: 'sale-1',
          deviceId: 'counter-device-1',
          terminalId: 'paired-terminal-1',
          provider: 'FAKE_TERMINAL',
          attemptKey,
          amountMinor: 1500,
          currency: 'PKR',
          businessDate,
        }
      );
      const sent = await store.transition(scope, attempt, { status: 'SENT', sentAt: new Date() });
      await store.transition(scope, sent!, {
        status: 'MANUAL_REVIEW',
        reviewReason: 'Terminal outcome still unknown after 10 status checks',
      });
      return attemptKey;
    }
    const resolution = (attemptKey: string, outcome: 'DECLINED' | 'REVERSED' = 'DECLINED') => ({
      branchId: 'branch-a',
      attemptKey,
      outcome,
      resolutionReason: 'Slip shows the card was declined',
      slipRef: 'SLIP-0042',
      managerPin: '2468',
    });

    it('refuses a cashier before any PIN check, and leaves the review open', async () => {
      const attemptKey = await underReview();
      refundAuth.actorMayRefund.mockResolvedValue(false);
      await expect(caller().resolveReview(resolution(attemptKey))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: CARD_TERMINAL_REVIEW_FORBIDDEN,
      });
      expect(refundAuth.authenticateRefundPin).not.toHaveBeenCalled();
      expect(store.all()[0]).toMatchObject({ status: 'MANUAL_REVIEW', resolvedById: null });
    });

    it('changes nothing when the manager’s PIN is refused', async () => {
      const attemptKey = await underReview();
      refundAuth.actorMayRefund.mockResolvedValue(true);
      refundAuth.authenticateRefundPin.mockResolvedValueOnce({ blocked: 'Enter your PIN.' });
      await expect(caller().resolveReview(resolution(attemptKey))).resolves.toEqual({
        blocked: 'Enter your PIN.',
      });
      expect(store.all()[0]).toMatchObject({ status: 'MANUAL_REVIEW' });
      expect(annotateAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          metadata: expect.objectContaining({ pinVerified: false, approvedAt: null }),
        })
      );
    });

    it('refuses a manager’s own charge while another manager or owner could resolve it', async () => {
      const attemptKey = await underReview('card-terminal:k-own', 'user-a');
      refundAuth.actorMayRefund.mockResolvedValue(true);
      await expect(caller().resolveReview(resolution(attemptKey))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: `${CARD_TERMINAL_REVIEW_OWN_CHARGE} Ask Ayesha Khan or another manager at this branch to resolve it.`,
      });
      // Only people who could resolve it at THIS branch count (the counter and branch gate).
      expect(approvers.others).toHaveBeenCalledWith(expect.anything(), scope);
      // Refused before any PIN is asked, and nothing changes.
      expect(refundAuth.authenticateRefundPin).not.toHaveBeenCalled();
      expect(store.all()[0]).toMatchObject({ status: 'MANUAL_REVIEW', resolvedById: null });
      expect(store.audits.filter((entry) => entry.from === 'MANUAL_REVIEW')).toEqual([]);
    });

    it('lets another manager resolve a cashier’s charge, audited as a second person', async () => {
      const attemptKey = await underReview();
      refundAuth.actorMayRefund.mockResolvedValue(true);
      await expect(caller().resolveReview(resolution(attemptKey))).resolves.toMatchObject({
        phase: 'DECLINED',
      });
      // Not the resolver's own charge: the solo rule is not consulted.
      expect(approvers.others).not.toHaveBeenCalled();
      expect(store.audits.at(-1)?.detail).toMatchObject({
        initiatedById: 'cashier-z',
        approverId: 'user-a',
        pinVerified: true,
        selfApproved: false,
        soloOwner: false,
      });
    });

    it('lets a solo owner self-approve with a fresh PIN, audited, with no terminal bound', async () => {
      const attemptKey = await underReview('card-terminal:k-review', 'user-a');
      // Nobody else could resolve it at this branch: the owner resolves their own charge.
      approvers.others.mockResolvedValue([]);
      // Resolution reads the slip, never the terminal: it works with no provider bound.
      harness.resolve.mockResolvedValue(null);
      refundAuth.actorMayRefund.mockResolvedValue(true);
      const view = await caller().resolveReview(resolution(attemptKey));
      expect(view).toMatchObject({ phase: 'DECLINED', open: false, canCheckStatus: false });
      expect(refundAuth.authenticateRefundPin).toHaveBeenCalledWith({
        organizationId: 'org-a',
        actorId: 'user-a',
        pin: '2468',
        action: 'pharmacyCardTerminal.resolveReview',
        policy: CARD_TERMINAL_REVIEW_PIN_POLICY,
        errorCode: 'CARD_TERMINAL_REVIEW_PIN_REFUSED',
      });
      const approval = {
        policy: CARD_TERMINAL_REVIEW_PIN_POLICY,
        initiatedById: 'user-a',
        approverId: 'user-a',
        pinVerified: true,
        selfApproved: true,
        soloOwner: true,
        approvedAt: expect.any(String),
      };
      // The approval rides on the attempt's own committed audit entry, not only the request's.
      expect(store.audits.at(-1)).toEqual({
        attemptId: store.all()[0]!.id,
        from: 'MANUAL_REVIEW',
        to: 'DECLINED',
        detail: approval,
      });
      expect(store.all()[0]).toMatchObject({
        status: 'DECLINED',
        resolvedById: 'user-a',
        resolutionRef: 'SLIP-0042',
      });
      // The PIN never reaches a stored record.
      expect(JSON.stringify([store.all(), store.audits])).not.toContain('2468');
      // The sale may take another tender now.
      terminal.scriptCharge({ kind: 'APPROVED', providerRef: 'RRN-7', amountMinor: 1500 });
      harness.resolve.mockResolvedValue({
        adapter: terminal,
        terminalId: 'paired-terminal-1',
        admission: { admittedProviders: ['FAKE_TERMINAL'] },
      });
      await expect(caller().charge(chargeInput('card-terminal:k-after'))).resolves.toMatchObject({
        phase: 'PAID',
      });
    });

    it('refuses a self-resolution when a second manager appears between the check and the write', async () => {
      const attemptKey = await underReview('card-terminal:k-race', 'user-a');
      refundAuth.actorMayRefund.mockResolvedValue(true);
      // Alone at the first check (before the PIN); a manager is activated before the write.
      approvers.others
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: 'manager-b', name: 'Ayesha Khan' }]);
      await expect(caller().resolveReview(resolution(attemptKey))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: `${CARD_TERMINAL_REVIEW_OWN_CHARGE} Ask Ayesha Khan or another manager at this branch to resolve it.`,
      });
      // The second check ran inside the write's transaction, and nothing changed.
      expect(approvers.others).toHaveBeenCalledTimes(3);
      // The request's audit row does not claim the self-approval that was refused.
      expect(vi.mocked(annotateAudit).mock.calls.at(-1)?.[1]).toEqual({
        metadata: { selfApproved: false, soloOwner: false },
      });
      expect(store.all()[0]).toMatchObject({ status: 'MANUAL_REVIEW', resolvedById: null });
      expect(store.audits.filter((entry) => entry.from === 'MANUAL_REVIEW')).toEqual([]);
    });

    it('tells the counter whether this person may resolve this attempt', async () => {
      const read = () => caller().attempt({ branchId: 'branch-a', saleId: 'sale-1' });
      await underReview('card-terminal:k-access', 'user-a');
      // A cashier: no form.
      await expect(read()).resolves.toMatchObject({
        phase: 'MANUAL_REVIEW',
        reviewAccess: { mayResolve: false, selfResolve: false, askName: null },
      });
      refundAuth.actorMayRefund.mockResolvedValue(true);
      // Their own charge, and someone else can resolve it here: who to ask.
      await expect(read()).resolves.toMatchObject({
        reviewAccess: { mayResolve: false, selfResolve: false, askName: 'Ayesha Khan' },
      });
      // Nobody else can: they may resolve it themselves with their PIN.
      approvers.others.mockResolvedValue([]);
      await expect(read()).resolves.toMatchObject({
        reviewAccess: { mayResolve: true, selfResolve: true, askName: null },
      });
    });

    it('records money taken against the slip, and answers a second resolution plainly', async () => {
      const attemptKey = await underReview();
      refundAuth.actorMayRefund.mockResolvedValue(true);
      await expect(
        caller().resolveReview({
          ...resolution(attemptKey, 'REVERSED'),
          resolutionReason: 'Customer charged',
        })
      ).resolves.toMatchObject({ phase: 'REVERSED', open: false });
      expect(store.all()[0]).toMatchObject({ status: 'REVERSED', providerRef: 'SLIP-0042' });
      await expect(caller().resolveReview(resolution(attemptKey))).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'REVIEW_NOT_OPEN',
      });
    });

    it('validates the reason, slip reference and PIN shape before anything runs', async () => {
      const attemptKey = await underReview();
      refundAuth.actorMayRefund.mockResolvedValue(true);
      for (const patch of [{ resolutionReason: 'no' }, { slipRef: '' }, { managerPin: '12' }])
        await expect(
          caller().resolveReview({ ...resolution(attemptKey), ...patch })
        ).rejects.toBeInstanceOf(TRPCError);
      expect(refundAuth.authenticateRefundPin).not.toHaveBeenCalled();
      expect(store.all()[0]).toMatchObject({ status: 'MANUAL_REVIEW' });
    });
  });
});

describe('provider refund correction approval', () => {
  const edit = {
    branchId: 'branch-a',
    previousId: 'review:reviewed',
    commandKey: 'change-1001',
    kind: 'DECLINED' as const,
    resolutionReason: 'Provider confirmed no charge',
    slipRef: 'SLIP-991',
    managerPin: '1234',
  };
  it('refuses a cashier before reading the decision or either PIN', async () => {
    await expect(caller().recordRefundAction(edit)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(requestDb.pharmacyTerminalRefundEvent.findFirst).not.toHaveBeenCalled();
    expect(refundAuth.authenticateRefundPin).not.toHaveBeenCalled();
  });
  it('refuses a finance reader without manage access before obtaining either approval', async () => {
    refundAuth.actorMayRefund.mockResolvedValue(true);
    const reader = {
      role: 'ADMIN',
      status: 'ACTIVE',
      organizationRole: {
        isSystem: false,
        key: 'read-only',
        permissions: [
          { capability: 'finance:read', effect: 'ALLOW' },
          { capability: 'admin:access', effect: 'ALLOW' },
        ],
      },
      permissionOverrides: [],
    };
    requestDb.user.findUnique.mockResolvedValue(reader);
    try {
      await expect(caller(true).recordRefundAction(edit)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(requestDb.pharmacyTerminalRefundEvent.findFirst).not.toHaveBeenCalled();
      expect(refundAuth.authenticateRefundPin).not.toHaveBeenCalled();
    } finally {
      requestDb.user.findUnique.mockReset();
      requestDb.user.findUnique.mockImplementation(managerMembership);
    }
  });
  it('requires another eligible reviewer and that reviewer’s own verified PIN, even for the original manager', async () => {
    refundAuth.actorMayRefund.mockResolvedValue(true);
    await expect(caller(true).recordRefundAction(edit)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller(true).recordRefundAction({
        ...edit,
        secondApproval: { userId: scope.actorId, managerPin: '9876' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(refundAuth.authenticateRefundPin).not.toHaveBeenCalled();
    refundAuth.authenticateRefundPin
      .mockResolvedValueOnce({ verified: true })
      .mockResolvedValueOnce({ blocked: 'PIN refused' });
    expect(
      await caller(true).recordRefundAction({
        ...edit,
        secondApproval: { userId: 'manager-b', managerPin: '9876' },
      })
    ).toEqual({ blocked: 'PIN refused' });
    expect(refundAuth.authenticateRefundPin).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actorId: scope.actorId, pin: '1234' })
    );
    expect(refundAuth.authenticateRefundPin).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actorId: 'manager-b', requestedById: scope.actorId, pin: '9876' })
    );
  });
});
