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

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createMemoryDriver } from '@/lib/retail-terminal/local-store';
import type { TerminalStorageDriver } from '@/lib/retail-terminal/local-store';

import { PharmacyCounterRuntime, startReceiptLeaseRenewal } from './counter-offline-runtime';
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
  recalledBatchIds: [],
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
  // DEV-957 phase 2 (review): the owner's switch forced ON in the signed RULES.
  for (const kind of CATALOG_KINDS)
    await install(counter, kind, kind === 'RULES' ? FORCED_ON_RULES : { kind });
  await counter.adoptLeases([
    { leaseId: 'lease_1', blockStart: 900, blockEnd: 902, nextNumber: 900 },
  ]);
  await counter.adoptQuotas([
    { inventoryLotId: 'lot_1', stockLocationId: 'loc_1', quotaUnits: 5, consumedUnits: 0 },
  ]);
  return counter;
}

const replaySigner = () => ({ command: 'command-signature', receipt: 'receipt-signature' });

/** Signed RULES with offline cash selling forced on (it is off in the product). */
const FORCED_ON_RULES = { kind: 'RULES', offlineCashSelling: true };

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

describe('#710 offline manual merchant evidence', () => {
  it('persists a Raast tender through restart and signs the same evidence on retry', async () => {
    const driver = createMemoryDriver();
    const counter = await readyCounter(driver);
    await install(
      counter,
      'RULES',
      {
        offlineCashSelling: true,
        manualMerchantPolicies: { RAAST: { allowReferenceSkip: false } },
      },
      { version: 2 }
    );
    const manualCapture = { type: 'RAAST', providerRef: '001234', payerName: 'Ayesha' };
    const result = await counter.enqueue(
      {
        ...cashSale(),
        action: 'MANUAL_OTC_SALE',
        payload: {
          ...cashSale().payload,
          amountMinor: 100,
          manualCapture: { ...manualCapture, payerName: ' Ayesha ' },
          snapshots: counter
            .snapshot()
            .catalog!.snapshots.map(({ envelope, signature, payload }) => ({
              envelope,
              signature,
              payload,
            })),
        },
      },
      MATRIX
    );
    expect(result).toMatchObject({ ok: true, command: { receiptNumber: 900 } });
    const restarted = runtime(driver);
    expect(await restarted.hydrate()).toBe('ready');
    const bodies: unknown[] = [];
    const send = vi.fn(async (request: { body: Record<string, unknown> }) => {
      bodies.push(request.body);
      return bodies.length === 1 ? { status: 0 } : { status: 200, serverRef: 'sale-1' };
    });
    await restarted.replay(send, replaySigner);
    await restarted.replay(send, replaySigner);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({
      action: 'MANUAL_OTC_SALE',
      manualCapture,
      leasedReceipt: { receiptNumber: 900 },
    });
    expect(bodies[0]).not.toHaveProperty('cashReceivedMinor');
    expect(restarted.snapshot().queue?.quotas[0]?.consumedUnits).toBe(1);
    expect(restarted.snapshot().queue?.commands[0]?.status).toBe('ACKNOWLEDGED');
  });
  it('refuses a missing reference or unauthorized skip without consuming stock or receipts', async () => {
    const counter = await readyCounter(createMemoryDriver());
    await install(
      counter,
      'RULES',
      {
        offlineCashSelling: true,
        manualMerchantPolicies: { RAAST: { allowReferenceSkip: false } },
      },
      { version: 2 }
    );
    for (const manualCapture of [
      { type: 'RAAST', payerName: 'Ayesha' },
      { type: 'RAAST', payerName: 'Ayesha', referenceSkipped: true },
      { type: 'JAZZCASH', payerName: 'Ayesha', providerRef: '1234' },
    ]) {
      expect(
        await counter.enqueue(
          {
            ...cashSale(),
            action: 'MANUAL_OTC_SALE',
            payload: { ...cashSale().payload, manualCapture },
          },
          MATRIX
        )
      ).toMatchObject({ ok: false });
    }
    expect(counter.snapshot().queue).toMatchObject({
      commands: [],
      leases: [{ nextNumber: 900 }],
      quotas: [{ consumedUnits: 0 }],
    });
    await install(
      counter,
      'RULES',
      { offlineCashSelling: true, manualMerchantPolicies: { RAAST: { allowReferenceSkip: true } } },
      { version: 3 }
    );
    expect(
      await counter.enqueue(
        {
          ...cashSale(),
          action: 'MANUAL_OTC_SALE',
          payload: {
            ...cashSale().payload,
            manualCapture: { type: 'RAAST', payerName: 'Ayesha', referenceSkipped: true },
          },
        },
        MATRIX
      )
    ).toMatchObject({ ok: true });
  });
});

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

    await install(
      counter,
      'RULES',
      { kind: 'RULES', offlineCashSelling: true, renewed: true },
      { version: 2 }
    );
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
      { kind: 'RULES', offlineCashSelling: true, renewed: true },
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

  it('#519: blocks a lot the signed lease marks recalled, with no bulletin applied', async () => {
    const counter = await readyCounter(createMemoryDriver());
    const renewedAt = '2026-09-02T11:00:00.000Z';
    await install(
      counter,
      'RULES',
      { kind: 'RULES', offlineCashSelling: true, recalled: true },
      {
        version: 2,
        issuedAt: renewedAt,
        safetyLease: { ...SAFETY_LEASE, issuedAt: renewedAt, recalledBatchIds: ['lot_1'] },
      }
    );

    expect(counter.safetyLeaseState().recalledBatchIds).toEqual(['lot_1']);
    expect(counter.snapshot().queue?.safetyLeaseEvents.at(-1)).toMatchObject({
      type: 'RENEWED',
      recalledBatchIds: ['lot_1'],
    });
    expect(await counter.enqueue(cashSale(), MATRIX)).toMatchObject({
      ok: false,
      reason: 'BATCH_RECALLED',
    });
  });

  it('#519: refuses a snapshot whose safety lease carries no recall set', async () => {
    const counter = runtime(createMemoryDriver());
    await counter.hydrate();
    const leaseWithoutRecalls: Partial<typeof SAFETY_LEASE> = { ...SAFETY_LEASE };
    delete leaseWithoutRecalls.recalledBatchIds;
    const result = await install(counter, 'RULES', FORCED_ON_RULES, {
      safetyLease: leaseWithoutRecalls as typeof SAFETY_LEASE,
    });
    expect(result).toMatchObject({ ok: false, reason: 'MALFORMED' });
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
      { kind: 'RULES', offlineCashSelling: true, shortLease: true },
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

/** #554: an in-memory driver whose writes resolve only when the test releases them. */
function gatedDriver() {
  const inner = createMemoryDriver();
  let gated = false;
  const pending: Array<() => void> = [];
  const driver: TerminalStorageDriver = {
    ...inner,
    writeIfRevision: async (key, record, revision) => {
      if (gated) await new Promise<void>((resolve) => pending.push(resolve));
      return inner.writeIfRevision(key, record, revision);
    },
  };
  return {
    driver,
    gate: () => {
      gated = true;
    },
    pendingWrites: () => pending.length,
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    open: () => {
      gated = false;
      pending.splice(0).forEach((resolve) => resolve());
    },
  };
}

describe('#554 — overlapping transitions never reuse a receipt or drop a sale', () => {
  it('gives concurrent enqueues distinct receipts and sequences and persists both', async () => {
    const storage = gatedDriver();
    const counter = await readyCounter(storage.driver);
    storage.gate();

    const first = counter.enqueue(cashSale(1), MATRIX);
    const second = counter.enqueue(cashSale(1), MATRIX);
    // Each sale's write is held open in turn; the second may not even start
    // composing until the first one's document is durable.
    await vi.waitFor(() => expect(storage.pendingWrites()).toBe(1));
    storage.release();
    await vi.waitFor(() => expect(storage.pendingWrites()).toBe(1));
    storage.release();
    const results = await Promise.all([first, second]);

    expect(results.map((r) => (r.ok ? r.command.receiptNumber : null))).toEqual([900, 901]);
    expect(results.map((r) => (r.ok ? r.command.sequence : null))).toEqual([1, 2]);

    // The durable document holds BOTH sales, not just the later write.
    const reloaded = runtime(storage.driver);
    expect(await reloaded.hydrate()).toBe('ready');
    const queue = reloaded.snapshot().queue!;
    expect(queue.commands.map((command) => command.receiptNumber)).toEqual([900, 901]);
    expect(queue.leases[0]?.nextNumber).toBe(902);
    expect(queue.quotas[0]?.consumedUnits).toBe(2);
  });

  it('keeps a sale whose write is still landing when a replay response arrives', async () => {
    const storage = gatedDriver();
    const counter = await readyCounter(storage.driver);
    await counter.enqueue(cashSale(1), MATRIX);

    let duringFlight: Promise<unknown> | null = null;
    const replaying = counter.replay(async (request) => {
      if (!duringFlight) {
        // A second sale is rung up while the first one's request is out, and
        // its document write has not landed when the server answers.
        storage.gate();
        duringFlight = counter.enqueue(cashSale(1), MATRIX);
        await vi.waitFor(() => expect(storage.pendingWrites()).toBe(1));
      }
      const receipt = request.body.leasedReceipt as { receiptNumber: unknown };
      return { status: 200, serverRef: `sale_${String(receipt.receiptNumber)}` };
    }, replaySigner);
    await vi.waitFor(() => expect(duringFlight).not.toBeNull());
    // Give the replay every chance to apply its outcome before the sale lands.
    await new Promise((resolve) => setTimeout(resolve, 20));
    storage.open();
    expect((await replaying).state).toBe('IDLE');
    expect(await duringFlight).toMatchObject({ ok: true, command: { receiptNumber: 901 } });

    const reloaded = runtime(storage.driver);
    expect(await reloaded.hydrate()).toBe('ready');
    const commands = reloaded.snapshot().queue!.commands;
    expect(commands.map((command) => command.receiptNumber)).toEqual([900, 901]);
    expect(commands.every((command) => command.status === 'ACKNOWLEDGED')).toBe(true);
  });

  it('does not wedge later transitions after a failed write', async () => {
    const inner = createMemoryDriver();
    let fail = true;
    const driver: TerminalStorageDriver = {
      ...inner,
      writeIfRevision: async (key, record, revision) => {
        if (fail) throw new Error('disk full');
        return inner.writeIfRevision(key, record, revision);
      },
    };
    const counter = runtime(driver);
    await counter.hydrate();
    await expect(counter.adoptLeases([])).rejects.toThrow('disk full');
    fail = false;
    await expect(counter.adoptQuotas([])).resolves.toBeUndefined();
  });
});

describe('PH-OFF OFF-01 — replay: re-auth pauses, revocation purges', () => {
  it.each(['resolve', 'reject'])(
    'keeps revocation final when signing later %ss',
    async (result) => {
      const driver = createMemoryDriver();
      const counter = await readyCounter(driver);
      await counter.enqueue(cashSale(1), MATRIX);
      const send = vi.fn(async () => ({ status: 200 }));

      await expect(
        counter.replay(send, async () => {
          await counter.revoke();
          if (result === 'reject') throw new Error('credential revoked');
          return replaySigner();
        })
      ).resolves.toMatchObject({ state: 'STOPPED' });

      expect(send).not.toHaveBeenCalled();
      expect(counter.snapshot().queue?.replay).toBe('STOPPED_REVOKED');
      expect(counter.snapshot().queue?.commands).toEqual([]);
      expect(await driver.read('org_a::branch_a::counter_1')).toBeUndefined();
    }
  );

  it.each([{ status: 200 }, { status: 503 }, { status: 401 }, { status: 409 }, { status: 422 }])(
    'keeps revocation final when the counter is revoked while the replay request is in flight',
    async (response) => {
      const driver = createMemoryDriver();
      const counter = await readyCounter(driver);
      await counter.enqueue(cashSale(1), MATRIX);
      const send = vi.fn(async () => {
        await counter.revoke();
        return response;
      });

      await expect(counter.replay(send, async () => replaySigner())).resolves.toMatchObject({
        state: 'STOPPED',
      });

      expect(counter.snapshot().queue?.replay).toBe('STOPPED_REVOKED');
      expect(counter.snapshot().queue?.commands).toEqual([]);
      expect(await driver.read('org_a::branch_a::counter_1')).toBeUndefined();
    }
  );

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

  it.each([
    [403, 'medicine_not_offline_otc'],
    [403, 'invalid_pack'],
    [403, 'invalid_snapshot'],
    [401, 'INVALID_COMMAND_SIGNATURE'],
  ] as const)(
    'retains a refused receipt for manager review after %i %s',
    async (status, serverMessage) => {
      const counter = await readyCounter(createMemoryDriver());
      await counter.enqueue(cashSale(1), MATRIX);
      await counter.replay(async () => ({ status, serverMessage }), replaySigner);
      expect(counter.snapshot().queue?.commands[0]).toMatchObject({ status: 'QUARANTINED' });
    }
  );

  it('keeps the new cause when a reviewed retry discovers a different refusal', async () => {
    const counter = await readyCounter(createMemoryDriver());
    await counter.enqueue(cashSale(1), MATRIX);
    await counter.replay(
      async () => ({ status: 409, serverMessage: 'DRAWER_NOT_OPEN' }),
      replaySigner
    );
    const head = counter.snapshot().queue!.commands[0]!;
    await expect(
      counter.resolveConflict(
        head.commandId,
        async () => ({ status: 403, serverMessage: 'invalid_snapshot' }),
        replaySigner,
        { action: 'retry', reason: 'Drawer is open' }
      )
    ).rejects.toThrow('sealed sale');
    expect(counter.snapshot().queue!.commands[0]).toMatchObject({
      commandId: head.commandId,
      status: 'QUARANTINED',
      refusalCode: 'invalid_snapshot',
    });
  });

  it('retries the same refused drawer receipt once after manager review', async () => {
    const counter = await readyCounter(createMemoryDriver());
    await counter.enqueue(cashSale(1), MATRIX);
    await counter.replay(
      async () => ({ status: 409, serverMessage: 'DRAWER_NOT_OPEN' }),
      replaySigner
    );
    const head = counter.snapshot().queue!.commands[0]!;
    expect(head.refusalCode).toBe('DRAWER_NOT_OPEN');
    const booked = vi.fn(async () => ({ status: 200, serverRef: 'sale-one' }));
    await counter.resolveConflict(head.commandId, booked, replaySigner);
    await counter.replay(booked, replaySigner);
    expect(booked).toHaveBeenCalledTimes(1);
    expect(booked.mock.calls[0]).toMatchObject([
      { body: { sequence: head.sequence, idempotencyKey: head.idempotencyKey } },
    ]);
    expect(counter.snapshot().queue!.commands[0]).toMatchObject({
      status: 'ACKNOWLEDGED',
      serverRef: 'sale-one',
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

describe('DEV-712 — the receipt lease renews in the background', () => {
  const block = (overrides: Record<string, unknown> = {}) => ({
    id: 'lease_2',
    deviceId: SCOPE.deviceId,
    blockStart: 1_000,
    blockEnd: 1_099,
    nextNumber: 1_000,
    ...overrides,
  });

  it('tops up a low runway so the next sale still gets a number', async () => {
    const driver = createMemoryDriver();
    const counter = await readyCounter(driver);
    const reserve = vi.fn(async () => block());
    for (const attempt of [0, 1, 2]) {
      expect((await counter.enqueue(cashSale(1), MATRIX)).ok, `attempt ${attempt}`).toBe(true);
    }
    expect(await counter.renewReceiptLeases(reserve)).toEqual({
      status: 'RENEWED',
      remaining: 100,
    });
    expect(reserve).toHaveBeenCalledExactlyOnceWith(100);
    const next = await counter.enqueue(cashSale(1), MATRIX);
    expect(next).toMatchObject({ ok: true, command: { receiptNumber: 1_000 } });
    // The old block keeps its issued numbers; the new one is persisted beside it.
    const reopened = runtime(driver);
    await reopened.hydrate();
    expect(reopened.snapshot().queue?.leases).toEqual([
      { leaseId: 'lease_1', blockStart: 900, blockEnd: 902, nextNumber: 903 },
      { leaseId: 'lease_2', blockStart: 1_000, blockEnd: 1_099, nextNumber: 1_001 },
    ]);
  });

  it('does not reserve while the runway is above the low-water mark', async () => {
    const counter = await readyCounter(createMemoryDriver());
    const reserve = vi.fn(async () => block());
    expect(await counter.renewReceiptLeases(reserve, { lowWater: 3 })).toEqual({
      status: 'SUFFICIENT',
      remaining: 3,
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('is single-flight: overlapping renewals reserve one block', async () => {
    const counter = await readyCounter(createMemoryDriver());
    let release!: (value: unknown) => void;
    const reserve = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const first = counter.renewReceiptLeases(reserve);
    const second = counter.renewReceiptLeases(reserve);
    release(block());
    expect(await first).toEqual(await second);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(counter.snapshot().queue?.leases).toHaveLength(2);
  });

  it.each([
    ['a refused request', () => Promise.reject(new Error('forbidden'))],
    ['another device', async () => block({ deviceId: 'counter_2' })],
    ['a malformed block', async () => block({ blockEnd: 900 })],
    [
      'an overlapping block',
      async () => block({ blockStart: 902, blockEnd: 990, nextNumber: 902 }),
    ],
  ])('keeps the held leases and never throws on %s', async (_label, answer) => {
    const counter = await readyCounter(createMemoryDriver());
    const before = counter.snapshot().queue?.leases;
    await expect(counter.renewReceiptLeases(vi.fn(answer))).resolves.toEqual({
      status: 'FAILED',
      remaining: 3,
    });
    expect(counter.snapshot().queue?.leases).toEqual(before);
  });

  it('never renews a revoked counter', async () => {
    const counter = await readyCounter(createMemoryDriver());
    await counter.revoke();
    const reserve = vi.fn(async () => block());
    expect(await counter.renewReceiptLeases(reserve)).toEqual({ status: 'STOPPED', remaining: 0 });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('runs now, on every interval and when the browser comes back online, until stopped', async () => {
    vi.useFakeTimers();
    try {
      const renewReceiptLeases = vi.fn(async () => ({
        status: 'SUFFICIENT' as const,
        remaining: 50,
      }));
      const onResult = vi.fn();
      const reserve = vi.fn();
      const stop = startReceiptLeaseRenewal({ renewReceiptLeases }, reserve, {
        intervalMs: 1_000,
        onResult,
      });
      expect(renewReceiptLeases).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renewReceiptLeases).toHaveBeenCalledTimes(2);
      window.dispatchEvent(new Event('online'));
      expect(renewReceiptLeases).toHaveBeenCalledTimes(3);
      expect(renewReceiptLeases).toHaveBeenCalledWith(reserve, {
        lowWater: undefined,
        size: undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(onResult).toHaveBeenCalledWith({ status: 'SUFFICIENT', remaining: 50 });
      stop();
      await vi.advanceTimersByTimeAsync(5_000);
      window.dispatchEvent(new Event('online'));
      expect(renewReceiptLeases).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

it('keeps the sale another counter tab saved while a replay response was in flight', async () => {
  const driver = createMemoryDriver();
  const first = await readyCounter(driver);
  await first.enqueue(cashSale(1), MATRIX);
  await first
    .replay(async () => {
      const second = runtime(driver);
      await second.hydrate();
      expect((await second.enqueue(cashSale(1), MATRIX)).ok).toBe(true);
      return { status: 200, serverRef: 'sale-1' };
    }, replaySigner)
    .catch((error) => expect(error).toMatchObject({ reason: 'WRITE_CONFLICT' }));
  const reopened = runtime(driver);
  await reopened.hydrate();
  expect(reopened.snapshot().queue?.commands.map((c) => c.sequence)).toEqual([1, 2]);
});
