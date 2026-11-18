/**
 * PH-OFF / OFF-05 deterministic release-gate scenarios (PRD §6.9).
 *
 * Scenario → test map:
 * - loss before tender → leaves no command, receipt, or quota consumption
 * - loss during tender → failed atomic persistence leaves no phantom tender
 * - loss after tender → persisted tender survives restart with its issued number
 * - crash/restart → an IN_FLIGHT command resumes with the same identity
 * - duplicate retry → repeated delivery has one idempotency key/server effect
 * - 4-hour multi-counter outage → device quotas prevent last-unit oversell
 * - clock skew → FIFO follows device sequence, never client timestamps
 * - sequence exhaustion → the counter fails closed without inventing a receipt
 * - revocation → confirmed revocation purges queued work and local state
 * - corruption recovery → malformed persisted state fails closed
 *
 * No wall clock, browser, or database is used: Vitest owns the clock and the
 * in-memory driver exercises the same whole-document persistence contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalStorageDriver } from '@/lib/retail-terminal/local-store';

import { createMemoryDriver, PharmacyCounterRuntime } from './counter-offline-runtime';
import type { SnapshotVerifier } from './counter-offline-runtime';
import type { CounterReplayRequest } from './counter-command-queue';
import type { PharmacyOfflineSnapshotKind } from './offline-action-matrix';

const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', deviceId: 'counter_1' };
const START = new Date('2026-09-02T08:00:00.000Z');
const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;
const HASH = 'a'.repeat(64);
const PUBLIC_KEY = 'test-public-key';
const SNAPSHOT_KINDS: PharmacyOfflineSnapshotKind[] = [
  'CATALOG',
  'PRICES',
  'TAX',
  'RULES',
  'LOT_BALANCES',
  'CUSTOMER_CREDIT',
];
const verifier: SnapshotVerifier = { verify: () => true };
const replaySigner = () => ({ command: 'command-signature', receipt: 'receipt-signature' });

function runtime(driver: TerminalStorageDriver, deviceId = SCOPE.deviceId) {
  return new PharmacyCounterRuntime({ ...SCOPE, deviceId }, driver, verifier, PUBLIC_KEY);
}

async function readyCounter(
  driver: TerminalStorageDriver,
  options: { deviceId?: string; receiptEnd?: number; quotaUnits?: number } = {}
) {
  const deviceId = options.deviceId ?? SCOPE.deviceId;
  const counter = runtime(driver, deviceId);
  expect(await counter.hydrate()).toBe('ready');
  for (const kind of SNAPSHOT_KINDS) {
    const envelope = {
      organizationId: SCOPE.organizationId,
      branchId: SCOPE.branchId,
      deviceId,
      kind,
      version: 1,
      payloadHash: HASH,
      issuedAt: START.toISOString(),
      expiresAt: new Date(START.getTime() + FOUR_HOURS_MS + 1).toISOString(),
      safetyLease: {
        issuedAt: START.toISOString(),
        expiresAt: new Date(START.getTime() + FOUR_HOURS_MS + 1).toISOString(),
        recallVersion: 0,
        licenceVersion: 1,
        ruleVersion: 1,
        recalledBatchIds: [],
      },
      signingKeyId: 'test-key',
    };
    expect(
      await counter.installSnapshot({
        envelope,
        signature: 'valid',
        payload: { kind },
        payloadHash: HASH,
        nowMs: Date.now(),
      })
    ).toMatchObject({ ok: true });
  }
  await counter.adoptLeases([
    {
      leaseId: `lease_${deviceId}`,
      blockStart: 1,
      blockEnd: options.receiptEnd ?? 10,
      nextNumber: 1,
    },
  ]);
  await counter.adoptQuotas([
    {
      inventoryLotId: 'last_lot',
      stockLocationId: 'dispensary',
      quotaUnits: options.quotaUnits ?? 1,
      consumedUnits: 0,
    },
  ]);
  return counter;
}

function sale(deviceId = SCOPE.deviceId, clientOriginAt = new Date().toISOString()) {
  return {
    deviceId,
    action: 'CASH_OTC_SALE' as const,
    payload: {
      leasedReceipt: { leaseId: `lease_${deviceId}` },
      lines: [{ inventoryLotId: 'last_lot', units: 1 }],
    },
    clientOriginAt,
    bucket: { inventoryLotId: 'last_lot', stockLocationId: 'dispensary' },
    requestedUnits: 1,
  };
}

function matrix() {
  return {
    nowMs: Date.now(),
    cachedCreditRemainingMinor: 0,
    controlledMedicinesPermittedOffline: false,
    originalSaleAvailable: true,
    deviceUsable: true,
  };
}

describe('PH-OFF OFF-05 — offline verification gate', () => {
  beforeEach(() => vi.useFakeTimers({ now: START }));
  afterEach(() => vi.useRealTimers());

  it('loss before tender leaves no command, receipt, or quota consumption', async () => {
    const driver = createMemoryDriver();
    const counter = await readyCounter(driver);

    vi.advanceTimersByTime(1_000); // connectivity is lost; tender was never accepted
    const restarted = runtime(driver);
    expect(await restarted.hydrate()).toBe('ready');
    expect(restarted.snapshot().queue).toMatchObject({
      nextSequence: 1,
      commands: [],
      leases: [{ nextNumber: 1 }],
      quotas: [{ consumedUnits: 0 }],
    });
    counter.close();
  });

  it('loss during tender: failed atomic persistence leaves no phantom tender', async () => {
    const backing = createMemoryDriver();
    await readyCounter(backing);
    let failNextWrite = true;
    const interrupted: TerminalStorageDriver = {
      read: (key) => backing.read(key),
      write: (key, value) => {
        if (failNextWrite) {
          failNextWrite = false;
          return Promise.reject(new Error('power lost during atomic write'));
        }
        return backing.write(key, value);
      },
      writeIfRevision: (key, value, expected) => backing.writeIfRevision(key, value, expected),
      remove: (key) => backing.remove(key),
      close: () => backing.close(),
    };
    const tendering = runtime(interrupted);
    expect(await tendering.hydrate()).toBe('ready');

    await expect(tendering.enqueue(sale(), matrix())).rejects.toThrow('power lost');
    expect(tendering.snapshot().queue).toMatchObject({
      nextSequence: 1,
      commands: [],
      leases: [{ nextNumber: 1 }],
      quotas: [{ consumedUnits: 0 }],
    });
  });

  it('loss after tender: persisted tender survives restart with its issued number', async () => {
    const driver = createMemoryDriver();
    const counter = await readyCounter(driver);
    const accepted = await counter.enqueue(sale(), matrix());
    expect(accepted).toMatchObject({ ok: true, command: { receiptNumber: 1 } });

    const restarted = runtime(driver);
    expect(await restarted.hydrate()).toBe('ready');
    expect(restarted.snapshot().queue?.commands).toMatchObject([
      { receiptNumber: 1, status: 'PENDING' },
    ]);
  });

  it('crash/restart resumes an IN_FLIGHT command with the same identity', async () => {
    const driver = createMemoryDriver();
    const counter = await readyCounter(driver);
    const accepted = await counter.enqueue(sale(), matrix());
    if (!accepted.ok) throw new Error(accepted.reason);
    const crash = new Promise<never>(() => undefined);
    void counter.replay(() => crash, replaySigner);
    await vi.waitFor(() => expect(counter.snapshot().queue?.commands[0]?.status).toBe('IN_FLIGHT'));

    const restarted = runtime(driver);
    expect(await restarted.hydrate()).toBe('ready');
    const requests: CounterReplayRequest[] = [];
    expect(
      await restarted.replay(async (request) => {
        requests.push(request);
        return { status: 201, serverRef: 'sale_1' };
      }, replaySigner)
    ).toMatchObject({ state: 'IDLE' });
    expect(requests[0]?.headers['Idempotency-Key']).toBe(accepted.command.commandId);
  });

  it('duplicate retry reuses one idempotency key and produces one server effect', async () => {
    const driver = createMemoryDriver();
    const counter = await readyCounter(driver);
    await counter.enqueue(sale(), matrix());
    const effects = new Map<string, string>();
    const seen: string[] = [];
    const server = async (request: CounterReplayRequest) => {
      const key = request.headers['Idempotency-Key'];
      seen.push(key);
      const serverRef = effects.get(key) ?? `sale_${effects.size + 1}`;
      effects.set(key, serverRef);
      if (seen.length === 1) throw new Error('response lost after commit');
      return { status: 200, serverRef };
    };

    expect(await counter.replay(server, replaySigner)).toMatchObject({ state: 'PAUSED' });
    expect(await counter.replay(server, replaySigner)).toMatchObject({ state: 'IDLE' });
    expect(new Set(seen).size).toBe(1);
    expect(effects.size).toBe(1);
  });

  it('4-hour multi-counter outage prevents last-unit oversell with device quotas', async () => {
    const first = await readyCounter(createMemoryDriver(), {
      deviceId: 'counter_1',
      quotaUnits: 1,
    });
    const second = await readyCounter(createMemoryDriver(), {
      deviceId: 'counter_2',
      quotaUnits: 0,
    });
    vi.advanceTimersByTime(FOUR_HOURS_MS);

    expect(await first.enqueue(sale('counter_1'), matrix())).toMatchObject({ ok: true });
    expect(await second.enqueue(sale('counter_2'), matrix())).toMatchObject({
      ok: false,
      reason: 'QUOTA_EXCEEDED',
    });
  });

  it('clock skew orders replay by persisted sequence, never client timestamps', async () => {
    const counter = await readyCounter(createMemoryDriver(), { quotaUnits: 2 });
    await counter.enqueue(sale(SCOPE.deviceId, '2099-01-01T00:00:00.000Z'), matrix());
    await counter.enqueue(sale(SCOPE.deviceId, '2000-01-01T00:00:00.000Z'), matrix());
    const origins: unknown[] = [];

    await counter.replay(async (request) => {
      origins.push((request.body.leasedReceipt as { originalSaleAt: string }).originalSaleAt);
      return { status: 201 };
    }, replaySigner);
    expect(origins).toEqual(['2099-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z']);
  });

  it('sequence exhaustion fails closed without inventing a receipt number', async () => {
    const counter = await readyCounter(createMemoryDriver(), { receiptEnd: 1, quotaUnits: 2 });
    expect(await counter.enqueue(sale(), matrix())).toMatchObject({ ok: true });
    expect(await counter.enqueue(sale(), matrix())).toMatchObject({
      ok: false,
      reason: 'NO_RECEIPT_NUMBER',
    });
    expect(counter.snapshot().queue).toMatchObject({
      nextSequence: 2,
      leases: [{ nextNumber: 2 }],
    });
  });

  it('confirmed revocation purges queued work and local state', async () => {
    const driver = createMemoryDriver();
    const counter = await readyCounter(driver);
    await counter.enqueue(sale(), matrix());
    expect(await counter.revoke()).toEqual({ commands: 1 });

    const restarted = runtime(driver);
    expect(await restarted.hydrate()).toBe('ready');
    expect(restarted.snapshot().queue?.commands).toEqual([]);
    expect(restarted.cachedSnapshotStates()).toEqual([]);
  });

  it('corruption recovery fails closed without adopting malformed state', async () => {
    const driver = createMemoryDriver([
      [
        'org_a::branch_a::counter_1',
        { schemaVersion: 1, scope: SCOPE, catalog: [], queue: 'corrupt' },
      ],
    ]);
    const counter = runtime(driver);
    expect(await counter.hydrate()).toBe('unrecoverable');
    expect(counter.snapshot().queue?.commands).toEqual([]);
  });
});
