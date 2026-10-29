/**
 * PH-OFF / OFF-01 — the counter runtime: encrypted-at-rest local store, signed
 * snapshot installation, the pre-allocated receipt lease, and outbox replay.
 *
 * The load-bearing case in this file is "reconnect never renumbers an issued
 * receipt" (OFF-01 acceptance, §8A invariant 16). It is proved the only way that
 * means anything: a number is drawn OFFLINE, the runtime is thrown away and
 * rebuilt from the same storage, the first replay attempt is lost, the second
 * succeeds — and the number the customer was handed is still the number the
 * server is told about.
 *
 * The runtime is driven through the in-memory driver, which has the same
 * contract as the IndexedDB one (jsdom ships no IndexedDB and this lane adds no
 * dependency).
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { createMemoryDriver } from '@/lib/retail-terminal/local-store';
import type { TerminalStorageDriver } from '@/lib/retail-terminal/local-store';

import { PharmacyCounterRuntime } from './counter-offline-runtime';
import type { SnapshotVerifier } from './counter-offline-runtime';
import type { CachedSnapshotState, PharmacyOfflineSnapshotKind } from './offline-action-matrix';
import type { OfflineSnapshotEnvelope } from './offline-snapshot-envelope';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

type Signing = typeof import('./offline-snapshots');
let signing: Signing;
let publicKey: string;

/** The Node half of the `SnapshotVerifier` seam. A browser surface supplies a
 * WebCrypto one; the contract it has to meet is exactly this. */
const nodeVerifier: SnapshotVerifier = {
  verify: ({ envelope, signature, publicKey: key }) =>
    signing.verifySnapshotSignature(envelope, signature, key),
};

beforeAll(async () => {
  signing = await import('./offline-snapshots');
  publicKey = signing.snapshotPublicKey();
});

const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', deviceId: 'counter_1' };
const ISSUED_AT = '2026-09-02T09:00:00.000Z';
const EXPIRES_AT = '2026-09-02T21:00:00.000Z';
const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const SAFETY_LEASE = {
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  recallVersion: 0,
  licenceVersion: 1,
  ruleVersion: 1,
};

const CATALOG_KINDS: PharmacyOfflineSnapshotKind[] = [
  'CATALOG',
  'PRICES',
  'TAX',
  'RULES',
  'LOT_BALANCES',
  'CUSTOMER_CREDIT',
];

function runtime(driver: TerminalStorageDriver, verifier: SnapshotVerifier = nodeVerifier) {
  return new PharmacyCounterRuntime(SCOPE, driver, verifier, publicKey);
}

function envelopeFor(
  kind: PharmacyOfflineSnapshotKind,
  payload: unknown,
  overrides: Partial<OfflineSnapshotEnvelope> = {}
): OfflineSnapshotEnvelope {
  return {
    ...SCOPE,
    kind,
    version: 1,
    payloadHash: signing.snapshotPayloadHash(payload),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    safetyLease: SAFETY_LEASE,
    signingKeyId: signing.SNAPSHOT_SIGNING_KEY_ID,
    ...overrides,
  };
}

async function install(
  counter: PharmacyCounterRuntime,
  kind: PharmacyOfflineSnapshotKind,
  payload: unknown = { kind },
  overrides: Partial<OfflineSnapshotEnvelope> = {}
) {
  const envelope = envelopeFor(kind, payload, overrides);
  return counter.installSnapshot({
    envelope,
    signature: signing.signSnapshotEnvelope(envelope),
    payload,
    payloadHash: signing.snapshotPayloadHash(payload),
    nowMs: NOW,
  });
}

/** A counter ready to sell: every required snapshot installed, one lease block,
 * one quota. Deliberately small so an exhaustion case is reachable. */
async function readyCounter(driver: TerminalStorageDriver) {
  const counter = runtime(driver);
  await counter.hydrate();
  for (const kind of CATALOG_KINDS) await install(counter, kind);
  await counter.adoptLeases([
    { leaseId: 'lease_1', blockStart: 900, blockEnd: 902, nextNumber: 900 },
  ]);
  await counter.adoptQuotas([
    { inventoryLotId: 'lot_1', stockLocationId: 'loc_1', quotaUnits: 5, consumedUnits: 0 },
  ]);
  return counter;
}

const replaySigner = () => ({ command: 'command-signature', receipt: 'receipt-signature' });

const MATRIX = {
  nowMs: NOW,
  cachedCreditRemainingMinor: 100_000,
  controlledMedicinesPermittedOffline: false,
  originalSaleAvailable: true,
  deviceUsable: true,
};

function cashSale(units = 1) {
  return {
    deviceId: SCOPE.deviceId,
    action: 'CASH_OTC_SALE' as const,
    payload: { leasedReceipt: { leaseId: 'lease_1' }, lines: [{ medicineId: 'med_1', units }] },
    clientOriginAt: '2026-09-02T12:05:00.000Z',
    bucket: { inventoryLotId: 'lot_1', stockLocationId: 'loc_1' },
    requestedUnits: units,
  };
}

describe('PH-OFF OFF-01 — hydration fails closed', () => {
  it('starts empty on a fresh counter', async () => {
    const counter = runtime(createMemoryDriver());
    expect(await counter.hydrate()).toBe('ready');
    expect(counter.snapshot().queue?.commands).toEqual([]);
  });

  it('refuses a document written by another counter', async () => {
    const driver = createMemoryDriver([
      [
        'org_a::branch_a::counter_1',
        {
          schemaVersion: 2,
          scope: SCOPE,
          catalog: null,
          queue: {
            deviceId: 'counter_9',
            nextSequence: 1,
            replay: 'READY',
            commands: [],
            leases: [],
            quotas: [],
            safetyLeaseEvents: [],
          },
        },
      ],
    ]);
    expect(await runtime(driver).hydrate()).toBe('unrecoverable');
  });

  it('refuses a document written by another app version', async () => {
    const driver = createMemoryDriver([
      [
        'org_a::branch_a::counter_1',
        { schemaVersion: 99, scope: SCOPE, catalog: null, queue: null },
      ],
    ]);
    expect(await runtime(driver).hydrate()).toBe('unrecoverable');
  });

  it('refuses a document belonging to another branch', async () => {
    const driver = createMemoryDriver([
      [
        'org_a::branch_a::counter_1',
        { schemaVersion: 2, scope: { ...SCOPE, branchId: 'branch_b' }, catalog: null, queue: null },
      ],
    ]);
    expect(await runtime(driver).hydrate()).toBe('unrecoverable');
  });
});

describe('PH-OFF OFF-01 — signed snapshots', () => {
  it('installs a snapshot whose signature verifies', async () => {
    const counter = runtime(createMemoryDriver());
    await counter.hydrate();
    expect(await install(counter, 'PRICES', { priceMinor: 100 })).toMatchObject({ ok: true });
    expect(counter.payloadFor('PRICES')).toEqual({ priceMinor: 100 });
    expect(counter.cachedSnapshotStates()).toEqual<CachedSnapshotState[]>([
      { kind: 'PRICES', verified: true, expiresAtMs: Date.parse(EXPIRES_AT) },
    ]);
  });

  it('does NOT store a snapshot whose signature fails', async () => {
    const counter = runtime(createMemoryDriver());
    await counter.hydrate();
    const payload = { priceMinor: 100 };
    const envelope = envelopeFor('PRICES', payload);
    const result = await counter.installSnapshot({
      envelope,
      // A valid signature over a DIFFERENT envelope: the shape is right, the
      // binding is not.
      signature: signing.signSnapshotEnvelope({ ...envelope, version: 2 }),
      payload,
      payloadHash: envelope.payloadHash,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    // The matrix reads "cached" as "verified", so an unverified snapshot must
    // leave no trace at all.
    expect(counter.cachedSnapshotStates()).toEqual([]);
    expect(counter.payloadFor('PRICES')).toBeNull();
  });

  it('does not store a snapshot whose payload does not match its hash', async () => {
    const counter = runtime(createMemoryDriver());
    await counter.hydrate();
    const envelope = envelopeFor('PRICES', { priceMinor: 100 });
    const result = await counter.installSnapshot({
      envelope,
      signature: signing.signSnapshotEnvelope(envelope),
      payload: { priceMinor: 999 },
      payloadHash: signing.snapshotPayloadHash({ priceMinor: 999 }),
      nowMs: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'PAYLOAD_MISMATCH' });
    expect(counter.cachedSnapshotStates()).toEqual([]);
  });

  it('does not store an expired snapshot', async () => {
    const counter = runtime(createMemoryDriver());
    await counter.hydrate();
    const envelope = envelopeFor('PRICES', { priceMinor: 100 });
    const result = await counter.installSnapshot({
      envelope,
      signature: signing.signSnapshotEnvelope(envelope),
      payload: { priceMinor: 100 },
      payloadHash: envelope.payloadHash,
      nowMs: Date.parse(EXPIRES_AT) + 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'EXPIRED' });
  });

  it('does not roll back to an older version of the same kind', async () => {
    const counter = runtime(createMemoryDriver());
    await counter.hydrate();
    await install(counter, 'PRICES', { priceMinor: 200 }, { version: 4 });
    const rolled = await install(counter, 'PRICES', { priceMinor: 100 }, { version: 3 });
    expect(rolled).toMatchObject({ ok: false, reason: 'STALE_VERSION' });
    expect(counter.payloadFor('PRICES')).toEqual({ priceMinor: 200 });
  });

  it('survives a reload: an installed snapshot is read back from storage', async () => {
    const driver = createMemoryDriver();
    const first = runtime(driver);
    await first.hydrate();
    await install(first, 'RULES', { controlled: false });

    const second = runtime(driver);
    expect(await second.hydrate()).toBe('ready');
    expect(second.payloadFor('RULES')).toEqual({ controlled: false });
  });
});

describe('PH-OFF OFF-02 — the matrix gates what may be composed', () => {
  it('queues an allowed cash sale and debits the quota', async () => {
    const counter = await readyCounter(createMemoryDriver());
    const result = await counter.enqueue(cashSale(2), MATRIX);
    expect(result.ok).toBe(true);
    expect(counter.snapshot().queue?.quotas[0]).toMatchObject({ consumedUnits: 2 });
  });

  it('refuses a denied action and queues nothing', async () => {
    const counter = await readyCounter(createMemoryDriver());
    const result = await counter.enqueue(
      { ...cashSale(1), action: 'PRICE_CHANGE', requestedUnits: 0, bucket: null },
      MATRIX
    );
    expect(result).toMatchObject({ ok: false, reason: 'DENIED_OFFLINE' });
    expect(counter.snapshot().queue?.commands).toEqual([]);
  });

  it('refuses beyond the quota without spending a receipt number', async () => {
    const counter = await readyCounter(createMemoryDriver());
    const result = await counter.enqueue(cashSale(6), MATRIX);
    expect(result).toMatchObject({ ok: false, reason: 'QUOTA_EXCEEDED' });
    // A refusal must not half-spend the lease: the runway is untouched.
    expect(counter.snapshot().queue?.leases[0]).toMatchObject({ nextNumber: 900 });
    expect(counter.snapshot().queue?.quotas[0]).toMatchObject({ consumedUnits: 0 });
  });

  it('refuses once the pre-allocated numbers run out rather than inventing one', async () => {
    const counter = await readyCounter(createMemoryDriver());
    for (const attempt of [0, 1, 2]) {
      expect((await counter.enqueue(cashSale(1), MATRIX)).ok, `attempt ${attempt}`).toBe(true);
    }
    const exhausted = await counter.enqueue(cashSale(1), MATRIX);
    expect(exhausted).toMatchObject({ ok: false, reason: 'NO_RECEIPT_NUMBER' });
  });

  it('refuses everything on a revoked counter', async () => {
    const counter = await readyCounter(createMemoryDriver());
    const result = await counter.enqueue(cashSale(1), { ...MATRIX, deviceUsable: false });
    expect(result).toMatchObject({ ok: false, reason: 'DEVICE_REVOKED' });
  });
});

describe('PH-OFF OFF-04 — safety lease and recall bulletin', () => {
  it('issues, renews and reports an expired lease in the append-only event log', async () => {
    const counter = await readyCounter(createMemoryDriver());
    expect(counter.counterStatus(NOW)).toMatchObject({ safetyLeaseStatus: 'ACTIVE' });
    expect(counter.snapshot().queue?.safetyLeaseEvents[0]?.type).toBe('ISSUED');

    await install(counter, 'RULES', { kind: 'RULES', renewed: true }, { version: 2 });
    expect(counter.snapshot().queue?.safetyLeaseEvents.at(-1)?.type).toBe('RENEWED');

    const denied = await counter.enqueue(cashSale(), { ...MATRIX, nowMs: Date.parse(EXPIRES_AT) });
    expect(denied).toMatchObject({ ok: false, reason: 'SAFETY_LEASE_EXPIRED' });
    expect(counter.counterStatus(Date.parse(EXPIRES_AT))).toMatchObject({
      safetyLeaseStatus: 'EXPIRED',
    });
    expect(counter.snapshot().queue?.safetyLeaseEvents.at(-1)?.type).toBe('EXPIRED');
  });

  it('applies a reconnect recall before sale and blocks its batch within the lease SLA', async () => {
    const counter = await readyCounter(createMemoryDriver());
    const renewedAt = '2026-09-02T11:00:00.000Z';
    const renewedLease = { ...SAFETY_LEASE, issuedAt: renewedAt, recallVersion: 1 };
    await install(
      counter,
      'RULES',
      { kind: 'RULES', renewed: true },
      {
        version: 2,
        issuedAt: renewedAt,
        safetyLease: renewedLease,
      }
    );

    expect(await counter.enqueue(cashSale(), MATRIX)).toMatchObject({
      ok: false,
      reason: 'SAFETY_LEASE_EXPIRED',
    });
    expect(
      await counter.applyRecallBulletin({
        issuedAt: '2026-09-02T12:01:00.000Z',
        recallVersion: 1,
        recalledBatchIds: ['lot_1'],
      })
    ).toBe(true);
    expect(await counter.enqueue(cashSale(), MATRIX)).toMatchObject({
      ok: false,
      reason: 'BATCH_RECALLED',
    });
    expect(counter.counterStatus(NOW)).toMatchObject({
      safetyLeaseStatus: 'ACTIVE',
      appliedRecallVersion: 1,
    });
  });

  it('fails medicine closed after expiry while an allowed non-medicine OTC row continues', async () => {
    const counter = await readyCounter(createMemoryDriver());
    const renewedAt = '2026-09-02T11:00:00.000Z';
    const shortLease = {
      ...SAFETY_LEASE,
      issuedAt: renewedAt,
      expiresAt: '2026-09-02T12:30:00.000Z',
    };
    await install(
      counter,
      'RULES',
      { kind: 'RULES', shortLease: true },
      {
        version: 2,
        issuedAt: renewedAt,
        safetyLease: shortLease,
      }
    );
    const afterLease = { ...MATRIX, nowMs: Date.parse('2026-09-02T12:31:00.000Z') };

    expect(await counter.enqueue(cashSale(), afterLease)).toMatchObject({
      ok: false,
      reason: 'SAFETY_LEASE_EXPIRED',
    });
    expect(
      await counter.enqueue(
        { ...cashSale(), medicineSale: false, payload: { lines: [{ sku: 'soap', units: 1 }] } },
        afterLease
      )
    ).toMatchObject({ ok: true });
  });
});

describe('PH-OFF OFF-01 — reconnect never renumbers an issued receipt', () => {
  it('replays the number printed offline, across a reload and a lost response', async () => {
    const driver = createMemoryDriver();
    const offline = await readyCounter(driver);

    const first = await offline.enqueue(cashSale(1), MATRIX);
    const second = await offline.enqueue(cashSale(1), MATRIX);
    expect(first.ok && second.ok).toBe(true);
    const printed = [first, second].map((r) => (r.ok ? r.command.receiptNumber : null));
    // Consecutive, from the reserved block, and handed to the customer already.
    expect(printed).toEqual([900, 901]);

    // The counter is closed and reopened before it ever reaches the server.
    offline.close();
    const reconnected = runtime(driver);
    expect(await reconnected.hydrate()).toBe('ready');

    // The first attempt is lost in the network; the second succeeds. Both carry
    // the same idempotency key and the same already-issued number.
    const sent: Array<{ key: string; receiptNumber: unknown; sequence: unknown }> = [];
    let failFirst = true;
    const outcome = await reconnected.replay(async (request) => {
      sent.push({
        key: request.headers['Idempotency-Key'],
        receiptNumber: (request.body.leasedReceipt as { receiptNumber: unknown }).receiptNumber,
        sequence: request.body.sequence,
      });
      if (failFirst) {
        failFirst = false;
        return { status: 0 };
      }
      const receipt = request.body.leasedReceipt as { receiptNumber: unknown };
      return { status: 200, serverRef: `sale_${String(receipt.receiptNumber)}` };
    }, replaySigner);
    expect(outcome.state).toBe('PAUSED');

    // Drain the rest with a healthy server.
    const drained = await reconnected.replay(async (request) => {
      sent.push({
        key: request.headers['Idempotency-Key'],
        receiptNumber: (request.body.leasedReceipt as { receiptNumber: unknown }).receiptNumber,
        sequence: request.body.sequence,
      });
      const receipt = request.body.leasedReceipt as { receiptNumber: unknown };
      return { status: 200, serverRef: `sale_${String(receipt.receiptNumber)}` };
    }, replaySigner);
    expect(drained.state).toBe('IDLE');

    // Three attempts for two commands: the lost one, its retry, and the second
    // command. The retry reused the key AND the already-printed number — that
    // is §8A invariant 16 holding across the crash window.
    expect(sent.map((row) => row.receiptNumber)).toEqual([900, 900, 901]);
    expect(sent[0]!.key).toBe(sent[1]!.key);
    expect(sent[0]!.key).not.toBe(sent[2]!.key);
    expect(sent.map((row) => row.sequence)).toEqual([1, 1, 2]);

    const acknowledged = reconnected.snapshot().queue!.commands;
    expect(acknowledged.map((command) => command.receiptNumber)).toEqual([900, 901]);
    expect(acknowledged.every((command) => command.status === 'ACKNOWLEDGED')).toBe(true);
    expect(acknowledged.map((command) => command.serverRef)).toEqual(['sale_900', 'sale_901']);
  });

  it('never issues the same number twice, even after a replay failure', async () => {
    const counter = await readyCounter(createMemoryDriver());
    await counter.enqueue(cashSale(1), MATRIX);
    await counter.replay(async () => ({ status: 500 }), replaySigner);
    const next = await counter.enqueue(cashSale(1), MATRIX);
    expect(next.ok && next.command.receiptNumber).toBe(901);
  });
});

describe('PH-OFF OFF-01 — replay: re-auth pauses, revocation purges', () => {
  it('pauses without losing an upgraded persisted command when replay signing cannot complete', async () => {
    const counter = await readyCounter(createMemoryDriver());
    await counter.enqueue(cashSale(1), MATRIX);

    await expect(
      counter.replay(
        async () => {
          throw new Error('transport must not receive an unsigned command');
        },
        async () => {
          throw new Error('enrollment credential unavailable');
        }
      )
    ).resolves.toMatchObject({ state: 'PAUSED' });
    expect(counter.snapshot().queue).toMatchObject({
      replay: 'PAUSED_REAUTH',
      commands: [{ status: 'PENDING' }],
    });
  });

  it('pauses and keeps the queue on a generic 401', async () => {
    const counter = await readyCounter(createMemoryDriver());
    await counter.enqueue(cashSale(1), MATRIX);
    const outcome = await counter.replay(
      async () => ({
        status: 401,
        serverMessage: 'Session expired.',
      }),
      replaySigner
    );
    expect(outcome.state).toBe('PAUSED');
    expect(counter.snapshot().queue?.replay).toBe('PAUSED_REAUTH');
    expect(counter.snapshot().queue?.commands).toHaveLength(1);

    await counter.resume();
    expect(counter.snapshot().queue?.replay).toBe('READY');
  });

  it('purges and wipes local state on a CONFIRMED revocation', async () => {
    const driver = createMemoryDriver();
    const counter = await readyCounter(driver);
    await counter.enqueue(cashSale(1), MATRIX);

    const outcome = await counter.replay(
      async () => ({
        status: 403,
        serverMessage: 'This device has been revoked.',
      }),
      replaySigner
    );
    expect(outcome).toMatchObject({ state: 'STOPPED', discarded: { commands: 1 } });
    expect(counter.snapshot().queue?.commands).toEqual([]);
    // A revoked counter must not keep printing from a block it no longer owns.
    expect(counter.snapshot().queue?.leases).toEqual([]);
    expect(await driver.read('org_a::branch_a::counter_1')).toBeUndefined();
  });

  it('quarantines a command the server refuses outright instead of looping', async () => {
    const counter = await readyCounter(createMemoryDriver());
    await counter.enqueue(cashSale(1), MATRIX);
    const outcome = await counter.replay(async () => ({ status: 400 }), replaySigner);
    expect(outcome.state).toBe('PAUSED');
    expect(counter.snapshot().queue?.commands[0]).toMatchObject({ status: 'QUARANTINED' });

    // A quarantined command is not retried, so the queue drains to idle.
    expect((await counter.replay(async () => ({ status: 200 }), replaySigner)).state).toBe('IDLE');
  });

  it('refuses to replay another counter’s queue', async () => {
    const driver = createMemoryDriver();
    const counter = await readyCounter(driver);
    await counter.enqueue(cashSale(1), MATRIX);
    const impostor = new PharmacyCounterRuntime(
      { ...SCOPE, deviceId: 'counter_2' },
      driver,
      nodeVerifier,
      publicKey
    );
    await impostor.hydrate();
    expect((await impostor.replay(async () => ({ status: 200 }), replaySigner)).state).toBe('IDLE');
  });
});

describe('PH-OFF OFF-01 — storage minimization is enforced on every write', () => {
  it('refuses to persist a forbidden field rather than writing it', async () => {
    const counter = await readyCounter(createMemoryDriver());
    await expect(
      counter.enqueue(
        {
          ...cashSale(1),
          payload: { lines: [], customerPhone: '+92-300-0000000' },
        },
        MATRIX
      )
    ).rejects.toMatchObject({ reason: 'FORBIDDEN_FIELD' });
  });

  it('refuses a device secret anywhere in the document', async () => {
    const counter = await readyCounter(createMemoryDriver());
    await expect(
      counter.enqueue({ ...cashSale(1), payload: { deviceSecret: 'pcd_x' } }, MATRIX)
    ).rejects.toMatchObject({ reason: 'FORBIDDEN_FIELD' });
  });
});
