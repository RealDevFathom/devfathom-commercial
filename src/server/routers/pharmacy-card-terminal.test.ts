/**
 * DEV-743: the card-terminal router, mocked end to end. The fake terminal and an in-memory
 * attempt store that enforces the migration's rules stand in for a device and PostgreSQL; the
 * service, the router and its access check order are the real ones. No provider, SDK or device.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
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
}));
vi.mock('./pharmacy-sales', () => ({
  requireCounterReceiptAccess: harness.requireCounterReceiptAccess,
  failPharmacySale: harness.failPharmacySale,
}));
vi.mock('@/lib/pharmacy/card-terminal/registry', () => ({
  resolvePharmacyCardTerminal: harness.resolve,
}));
vi.mock('@/lib/pharmacy/card-terminal/store', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/card-terminal/store')>()),
  // The router's store is the in-memory one, which enforces the migration's rules.
  prismaCardTerminalAttemptStore: () => harness.store,
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
import { router, type TRPCContext } from '../trpc';
import { pharmacyCardTerminalRouter } from './pharmacy-card-terminal';

const app = router({ pharmacyCardTerminal: pharmacyCardTerminalRouter });
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };
const businessDate = new Date('2026-11-18T00:00:00.000Z');

function caller() {
  const db = { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)) };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a' },
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
    ).resolves.toEqual({ available: false, currency: 'PKR' });
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
    ).resolves.toEqual({ available: false, currency: 'PKR' });
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
    ).resolves.toEqual({ available: true, currency: 'PKR' });
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
});
