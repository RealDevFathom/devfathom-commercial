// @vitest-environment node
/**
 * DEV-957 phase 1: a counter installs only snapshots the browser verifier
 * (WebCrypto Ed25519) accepts, from envelopes the real server signer issued; a
 * tampered snapshot is never stored; the offline catalogue then lists only
 * over-the-counter lots this counter holds quota for; "Prepare" reserves a
 * receipt block and grants quotas through the injected manager transport.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_SCOPE,
  fixturePayloads,
  fixturePublicKey,
  signedSnapshot,
} from '@/lib/test-support/pharmacy-offline-snapshots';
import { terminalScopeKey } from '@/lib/retail-terminal/local-store';
import { createMemoryDriver } from './counter-offline-runtime';
import {
  browserSnapshotPayloadHash,
  ed25519Supported,
  webCryptoSnapshotVerifier,
} from './counter-snapshot-verifier';
import {
  installCounterSnapshots,
  openCounterRuntime,
  prepareCounterForOffline,
  type CounterOfflineDeps,
} from './counter-offline-session';
import {
  counterOfflineReadiness,
  offlineCatalogueRows,
  searchOfflineCatalogue,
} from './counter-offline-catalogue';
import { snapshotPayloadHash, verifySnapshotSignature } from './offline-snapshots';
import type { PharmacyOfflineSnapshotKind } from './offline-action-matrix';

const ENROLMENT = { ...FIXTURE_SCOPE, name: 'Front counter', enrolledAt: '2026-11-19T08:00:00.000Z' };
const KINDS: PharmacyOfflineSnapshotKind[] = ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'];

function issued(version = 1, recalled: string[] = ['lot_ors_recalled']) {
  const payloads = fixturePayloads();
  return KINDS.map((kind) =>
    signedSnapshot(kind, payloads[kind as keyof typeof payloads], {
      version,
      recalledBatchIds: recalled,
    })
  );
}

function deps(snapshots = issued(), overrides: Partial<CounterOfflineDeps['transport']> = {}) {
  const mocks = {
    establish: vi.fn(async () => ({
      sessionToken: 'token-in-memory',
      snapshotPublicKey: fixturePublicKey(),
      device: { id: FIXTURE_SCOPE.deviceId },
    })),
    snapshots: vi.fn(async () => ({ snapshots, publicKey: fixturePublicKey() })),
    lease: vi.fn(async (_token: string, size: number) => ({
      id: 'lease_1',
      deviceId: FIXTURE_SCOPE.deviceId,
      blockStart: 1001,
      blockEnd: 1000 + size,
      nextNumber: 1001,
    })),
    quota: vi.fn(async () => ({ id: 'quota' })),
  };
  const transport = { ...mocks, ...overrides } as typeof mocks;
  const value: CounterOfflineDeps = {
    driver: createMemoryDriver(),
    verifier: webCryptoSnapshotVerifier(),
    transport,
    payloadHash: (payload) => browserSnapshotPayloadHash(payload),
    now: () => Date.now(),
  };
  return { deps: value, transport };
}

describe('DEV-957 browser snapshot verification', () => {
  it('runs on this runtime (Ed25519 in SubtleCrypto)', async () => {
    expect(await ed25519Supported()).toBe(true);
  });

  it('computes the payload hash the server signs', async () => {
    const payload = fixturePayloads().PRICES;
    expect(await browserSnapshotPayloadHash(payload)).toBe(snapshotPayloadHash(payload));
  });

  it('agrees with the server verifier on genuine and forged envelopes', async () => {
    const verifier = webCryptoSnapshotVerifier();
    const good = signedSnapshot('CATALOG', fixturePayloads().CATALOG);
    const key = fixturePublicKey();
    expect(verifySnapshotSignature(good.envelope, good.signature, key)).toBe(true);
    expect(await verifier.verify({ ...good, publicKey: key })).toBe(true);
    const forged = { ...good.envelope, version: good.envelope.version + 1 };
    expect(verifySnapshotSignature(forged, good.signature, key)).toBe(false);
    expect(await verifier.verify({ envelope: forged, signature: good.signature, publicKey: key })).toBe(
      false
    );
    expect(await verifier.verify({ ...good, publicKey: 'not-a-key' })).toBe(false);
    expect(await verifier.verify({ ...good, signature: 'AAAA', publicKey: key })).toBe(false);
  });
});

describe('DEV-957 installing snapshots on an enrolled counter', () => {
  it('establishes, installs all five verified snapshots and adopts the signed quotas', async () => {
    const { deps: d, transport } = deps();
    const opened = await openCounterRuntime(ENROLMENT, d, true);
    expect(opened.sessionToken).toBe('token-in-memory');
    expect(transport.establish).toHaveBeenCalledTimes(1);
    const report = await installCounterSnapshots(opened.runtime, opened.sessionToken!, d);
    expect(report.refused).toEqual([]);
    expect(report.installed.sort()).toEqual([...KINDS].sort());
    const state = opened.runtime.snapshot();
    expect(state.queue?.quotas).toHaveLength(3);
    // The token is not part of the stored document.
    expect(JSON.stringify(state)).not.toContain('token-in-memory');
  });

  it('never installs a tampered payload, a forged envelope or another counter’s snapshot', async () => {
    const good = issued();
    const tamperedPayload = { ...good[1]!, payload: [{ ...fixturePayloads().PRICES[0], printedMrpMinor: 1 }] };
    const forgedEnvelope = {
      ...good[0]!,
      envelope: { ...good[0]!.envelope, expiresAt: new Date(Date.now() + 99 * 3_600_000).toISOString() },
    };
    const otherCounter = signedSnapshot('RULES', fixturePayloads().RULES, {
      scope: { ...FIXTURE_SCOPE, deviceId: 'device_someone_else' },
    });
    const { deps: d } = deps([forgedEnvelope, tamperedPayload, good[2]!, otherCounter, good[4]!]);
    const opened = await openCounterRuntime(ENROLMENT, d, true);
    const report = await installCounterSnapshots(opened.runtime, opened.sessionToken!, d);
    expect(report.refused).toEqual([
      { kind: 'CATALOG', reason: 'BAD_SIGNATURE' },
      { kind: 'PRICES', reason: 'PAYLOAD_MISMATCH' },
      { kind: 'RULES', reason: 'SCOPE_MISMATCH' },
    ]);
    const kinds = opened.runtime.snapshot().catalog?.snapshots.map((s) => s.envelope.kind);
    expect(kinds?.sort()).toEqual(['LOT_BALANCES', 'TAX']);
    // Nothing unverified reaches the offline catalogue.
    expect(offlineCatalogueRows(opened.runtime.snapshot(), Date.now())).toEqual([]);
    expect(counterOfflineReadiness(opened.runtime.snapshot(), Date.now()).snapshotsReady).toBe(false);
  });

  it('opens offline from the stored document, with no request at all', async () => {
    const { deps: d, transport } = deps();
    const online = await openCounterRuntime(ENROLMENT, d, true);
    await installCounterSnapshots(online.runtime, online.sessionToken!, d);
    transport.establish.mockClear();
    transport.snapshots.mockClear();
    const offline = await openCounterRuntime(ENROLMENT, d, false);
    expect(transport.establish).not.toHaveBeenCalled();
    expect(offline.sessionToken).toBeNull();
    const rows = offlineCatalogueRows(offline.runtime.snapshot(), Date.now());
    expect(rows.map((row) => row.inventoryLotId)).toEqual(['lot_panadol_a']);
  });

  it('refuses a document stored for another counter', async () => {
    const { deps: d } = deps();
    const opened = await openCounterRuntime(ENROLMENT, d, true);
    await installCounterSnapshots(opened.runtime, opened.sessionToken!, d);
    const mismatched = await openCounterRuntime(
      { ...ENROLMENT, deviceId: 'device_offline_fixture' },
      { ...d, transport: { ...d.transport, establish: async () => ({ sessionToken: 't', snapshotPublicKey: fixturePublicKey(), device: { id: 'device_other' } }) } },
      true
    );
    // The server named another device: no session is trusted.
    expect(mismatched.sessionToken).toBeNull();
  });
});

describe('DEV-957 an unreadable stored document', () => {
  it('gets no session, so neither a lease nor a snapshot can overwrite it', async () => {
    const { deps: d, transport } = deps();
    const scopeKey = terminalScopeKey(FIXTURE_SCOPE);
    const foreign = { schemaVersion: 999, scope: FIXTURE_SCOPE, queue: { deviceId: 'x' } };
    d.driver = createMemoryDriver([[scopeKey, foreign]]);
    const opened = await openCounterRuntime(ENROLMENT, d, true);
    expect(opened.hydrated).toBe('unrecoverable');
    expect(opened.sessionToken).toBeNull();
    expect(transport.lease).not.toHaveBeenCalled();
    expect(await d.driver.read(scopeKey)).toEqual(foreign);
  });
});

describe('DEV-957 offline catalogue', () => {
  async function installed() {
    const { deps: d } = deps();
    const opened = await openCounterRuntime(ENROLMENT, d, true);
    await installCounterSnapshots(opened.runtime, opened.sessionToken!, d);
    return opened.runtime;
  }

  it('lists only signed over-the-counter lots with quota, not recalled and not expired', async () => {
    const runtime = await installed();
    const rows = offlineCatalogueRows(runtime.snapshot(), Date.now());
    // lot_ors_recalled is recalled under the signed lease; lot_rx_only is not in
    // the signed catalogue (the server leaves prescription-only medicines out).
    expect(rows).toEqual([
      {
        inventoryLotId: 'lot_panadol_a',
        stockLocationId: 'loc_front',
        medicineId: 'med_panadol',
        medicineName: 'Panadol 500mg',
        presentation: 'Tablet',
        unitsPerPack: 10,
        packPriceMinor: 3_500,
        unitsLeft: 20,
        expiresAt: '2030-01-31T00:00:00.000Z',
      },
    ]);
    expect(searchOfflineCatalogue(rows, 'pana')).toHaveLength(1);
    expect(searchOfflineCatalogue(rows, 'ors')).toEqual([]);
    expect(searchOfflineCatalogue(rows, 'p')).toEqual([]);
    // After the lot expires it is gone too.
    expect(offlineCatalogueRows(runtime.snapshot(), Date.parse('2030-02-01T00:00:00Z'))).toEqual([]);
  });

  it('reports readiness: price list age, offline end, receipt numbers and items', async () => {
    const runtime = await installed();
    const now = Date.now();
    const readiness = counterOfflineReadiness(runtime.snapshot(), now);
    expect(readiness.snapshotsReady).toBe(true);
    expect(readiness.itemsAvailable).toBe(1);
    expect(readiness.receiptNumbersLeft).toBe(0);
    expect(readiness.prepared).toBe(false);
    expect(Date.parse(readiness.offlineUntil!)).toBeGreaterThan(now);
    // Past the signed window nothing is offered.
    const later = now + 9 * 3_600_000;
    expect(counterOfflineReadiness(runtime.snapshot(), later).snapshotsReady).toBe(false);
    expect(offlineCatalogueRows(runtime.snapshot(), later)).toEqual([]);
  });
});

describe('DEV-957 prepare this counter for offline', () => {
  it('reserves a receipt block, grants each quota and refreshes the snapshots', async () => {
    const { deps: d, transport } = deps();
    const opened = await openCounterRuntime(ENROLMENT, d, true);
    const report = await prepareCounterForOffline(opened.runtime, opened.sessionToken!, d, {
      grants: [
        { inventoryLotId: 'lot_panadol_a', stockLocationId: 'loc_front', units: 10 },
        { inventoryLotId: 'lot_skip', stockLocationId: 'loc_front', units: 0 },
      ],
    });
    expect(transport.lease).toHaveBeenCalledWith('token-in-memory', 200);
    expect(transport.quota).toHaveBeenCalledTimes(1);
    expect(transport.quota).toHaveBeenCalledWith('token-in-memory', {
      inventoryLotId: 'lot_panadol_a',
      stockLocationId: 'loc_front',
      units: 10,
    });
    expect(report).toMatchObject({ receipts: 'RESERVED', receiptNumbersLeft: 200, granted: 1 });
    expect(counterOfflineReadiness(opened.runtime.snapshot(), Date.now()).prepared).toBe(true);
    // A second prepare keeps the block it holds rather than reserving another.
    transport.lease.mockClear();
    const again = await prepareCounterForOffline(opened.runtime, opened.sessionToken!, d, {
      grants: [],
    });
    expect(again.receipts).toBe('ALREADY_HELD');
    expect(transport.lease).not.toHaveBeenCalled();
  });

  it('reports a refused grant and keeps going', async () => {
    const refused = Object.assign(new Error('QUOTA_EXCEEDS_ON_HAND'), {});
    const { deps: d } = deps(issued(), {
      quota: vi.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce({ id: 'q2' }),
    });
    const opened = await openCounterRuntime(ENROLMENT, d, true);
    const report = await prepareCounterForOffline(opened.runtime, opened.sessionToken!, d, {
      grants: [
        { inventoryLotId: 'a', stockLocationId: 'l', units: 5 },
        { inventoryLotId: 'b', stockLocationId: 'l', units: 5 },
      ],
    });
    expect(report.granted).toBe(1);
    expect(report.refused).toEqual([
      { grant: { inventoryLotId: 'a', stockLocationId: 'l', units: 5 }, error: refused },
    ]);
  });
});

