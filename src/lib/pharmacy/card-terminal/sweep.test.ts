import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: vi.fn(), withTenantDb: vi.fn() }));
vi.mock('./registry', () => ({ resolvePharmacyCardTerminal: vi.fn(async () => null) }));
// The real store, as the production sweep builds it, is replaced by the in-memory one.
const realStore = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  prismaCardTerminalAttemptStore: realStore.build,
}));

import { beginCardTerminalCharge, dispatchCardTerminalCharge } from './service';
import {
  CARD_TERMINAL_STALE_AFTER_MS,
  processDueCardTerminalRecovery,
  type CardTerminalSweepCandidate,
  type CardTerminalSweepOptions,
} from './sweep';
import { createFakeTerminal, type FakeTerminal } from './testing/fake-terminal';
import { createInMemoryAttemptStore, type InMemoryAttemptStore } from './testing/in-memory-store';
import { CARD_TERMINAL_TIMEOUT_MS } from './timing';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
const admission = { admittedProviders: ['FAKE_TERMINAL'] };
const start = new Date('2026-11-18T10:00:00.000Z');
const later = new Date(start.getTime() + 10 * 60_000);

let terminal: FakeTerminal;
let store: InMemoryAttemptStore;

const candidate = (attemptKey: string): CardTerminalSweepCandidate => ({
  ...scope,
  attemptKey,
  deviceId: 'device-1',
});

async function openAttempt(attemptKey: string, saleId: string) {
  const deps = { store, adapter: terminal, admission, now: () => start };
  await beginCardTerminalCharge(deps, scope, {
    saleId,
    deviceId: 'device-1',
    terminalId: 'counter-1',
    attemptKey,
    amountMinor: 1500,
    currency: 'PKR',
    businessDate: new Date('2026-11-18T00:00:00.000Z'),
  });
  terminal.scriptCharge({ kind: 'ERROR', code: 'TIMEOUT', reachedTerminal: 'UNKNOWN' });
  return dispatchCardTerminalCharge(deps, scope, attemptKey);
}

const options = (
  resolve: NonNullable<CardTerminalSweepOptions['resolve']> = vi.fn(async () => ({
    adapter: terminal,
    terminalId: 'counter-1',
    admission,
  }))
) => ({
  resolve,
  storeFor: () => store,
});

beforeEach(() => {
  terminal = createFakeTerminal();
  store = createInMemoryAttemptStore({ now: () => start });
});

describe('DEV-743 card-terminal recovery sweep', () => {
  it('asks for attempts untouched past the stale window, and never for manual review', async () => {
    const listDue = vi.fn(async () => []);
    await expect(
      processDueCardTerminalRecovery(later, 7, { ...options(), listDue })
    ).resolves.toEqual({
      attempts: 0,
      resolved: 0,
      open: 0,
      skipped: 0,
      failed: 0,
    });
    expect(listDue).toHaveBeenCalledWith(
      new Date(later.getTime() - CARD_TERMINAL_STALE_AFTER_MS),
      7
    );
  });

  it('resolves a stale unknown attempt by status query on the same operation, never a new charge', async () => {
    const unknown = await openAttempt('sale-1:card:0001', 'sale-1');
    expect(unknown.status).toBe('UNKNOWN');
    terminal.scriptQuery({ kind: 'APPROVED', providerRef: 'RRN-9', amountMinor: 1500 });
    const result = await processDueCardTerminalRecovery(later, 25, {
      ...options(),
      listDue: async () => [candidate('sale-1:card:0001')],
    });
    expect(result).toEqual({ attempts: 1, resolved: 1, open: 0, skipped: 0, failed: 0 });
    expect(terminal.charges).toHaveLength(1);
    expect(terminal.queries).toEqual([{ operationRef: unknown.id, terminalId: 'counter-1' }]);
    expect(store.all()[0]).toMatchObject({ status: 'SETTLED' });
    expect(store.tenders).toHaveLength(1);
  });

  it('keeps an attempt open while the terminal still cannot say, and counts it', async () => {
    await openAttempt('sale-1:card:0002', 'sale-1');
    terminal.scriptQuery({ kind: 'PENDING' });
    await expect(
      processDueCardTerminalRecovery(later, 25, {
        ...options(),
        listDue: async () => [candidate('sale-1:card:0002')],
      })
    ).resolves.toMatchObject({ resolved: 0, open: 1 });
    expect(store.all()[0]).toMatchObject({ status: 'UNKNOWN', statusChecks: 1 });
  });

  it('skips an attempt with no admitted terminal and carries on past a failure', async () => {
    await openAttempt('sale-1:card:0003', 'sale-1');
    await openAttempt('sale-2:card:0004', 'sale-2');
    terminal.scriptQuery({ kind: 'DECLINED', declineCode: '05' });
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('registry down'))
      .mockResolvedValueOnce({ adapter: terminal, terminalId: 'counter-1', admission });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await processDueCardTerminalRecovery(later, 25, {
      ...options(resolve),
      listDue: async () => [
        candidate('sale-1:card:0003'),
        candidate('sale-1:card:0003'),
        candidate('sale-2:card:0004'),
      ],
    });
    log.mockRestore();
    expect(result).toEqual({ attempts: 3, resolved: 1, open: 0, skipped: 1, failed: 1 });
    expect(store.all().map((row) => row.status)).toEqual(['UNKNOWN', 'DECLINED']);
  });

  it('refuses a terminal outside the admission list, as the counter does', async () => {
    await openAttempt('sale-1:card:0005', 'sale-1');
    const result = await processDueCardTerminalRecovery(later, 25, {
      ...options(vi.fn(async () => ({ adapter: terminal, terminalId: 'counter-1' }))),
      listDue: async () => [candidate('sale-1:card:0005')],
    });
    expect(result).toMatchObject({ skipped: 1, resolved: 0 });
    expect(terminal.queries).toEqual([]);
  });

  it('judges staleness by the counter’s own timeout, so both close a crash-stale attempt alike', async () => {
    // Committed, never sent: the counter crashed between commit and dispatch.
    await beginCardTerminalCharge(
      { store, adapter: terminal, admission, now: () => start },
      scope,
      {
        saleId: 'sale-1',
        deviceId: 'device-1',
        terminalId: 'counter-1',
        attemptKey: 'sale-1:card:0006',
        amountMinor: 1500,
        currency: 'PKR',
        businessDate: new Date('2026-11-18T00:00:00.000Z'),
      }
    );
    const justPast = new Date(start.getTime() + CARD_TERMINAL_TIMEOUT_MS + 1);
    await expect(
      processDueCardTerminalRecovery(justPast, 25, {
        ...options(),
        listDue: async () => [candidate('sale-1:card:0006')],
      })
    ).resolves.toMatchObject({ resolved: 1, open: 0 });
    expect(store.all()[0]).toMatchObject({ status: 'ABANDONED' });
    expect(terminal.charges).toEqual([]);
    expect(CARD_TERMINAL_STALE_AFTER_MS).toBeGreaterThan(CARD_TERMINAL_TIMEOUT_MS);
  });

  it('audits what it changes as the system, in each change’s own committed transaction', async () => {
    await openAttempt('sale-1:card:0007', 'sale-1');
    realStore.build.mockReturnValueOnce(store);
    terminal.scriptQuery({ kind: 'DECLINED', declineCode: '05' });
    await processDueCardTerminalRecovery(later, 25, {
      resolve: async () => ({ adapter: terminal, terminalId: 'counter-1', admission }),
      listDue: async () => [candidate('sale-1:card:0007')],
    });
    expect(realStore.build).toHaveBeenCalledWith(expect.any(Function), 'SYSTEM');
    expect(store.audits.at(-1)).toMatchObject({ from: 'UNKNOWN', to: 'DECLINED' });
  });
});
