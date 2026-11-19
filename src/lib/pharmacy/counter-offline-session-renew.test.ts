// @vitest-environment node
/**
 * DEV-957 phase 2: an online counter renews its own device secret before it expires, keeps
 * the new one only as its signing key, and starts a fresh session with it; a confirmed
 * revocation wipes the counter (and says how many unsent sales that cost); a failed renewal
 * keeps the counter working until its credential expires.
 */
import { describe, expect, it, vi } from 'vitest';

import { FIXTURE_SCOPE, fixturePublicKey } from '@/lib/test-support/pharmacy-offline-snapshots';
import { terminalScopeKey } from '@/lib/retail-terminal/local-store';

import { createMemoryDriver, PharmacyCounterRuntime } from './counter-offline-runtime';
import { discardCounterDrafts, openCounterRuntime, type CounterOfflineDeps } from './counter-offline-session';
import { CounterRequestError } from './counter-offline-transport';
import { webCryptoSnapshotVerifier, browserSnapshotPayloadHash } from './counter-snapshot-verifier';

const ENROLMENT = { ...FIXTURE_SCOPE, name: 'Front counter', enrolledAt: '2026-11-19T08:00:00.000Z' };

function session(renewDue: boolean, token = 'token-1') {
  return {
    sessionToken: token,
    snapshotPublicKey: fixturePublicKey(),
    device: { id: FIXTURE_SCOPE.deviceId },
    credential: { expiresAt: '2026-12-01T00:00:00.000Z', expired: false, renewDue },
  };
}

function deps(overrides: Partial<CounterOfflineDeps['transport']>, rekey = vi.fn(async () => undefined)) {
  const value: CounterOfflineDeps = {
    driver: createMemoryDriver(),
    verifier: webCryptoSnapshotVerifier(),
    transport: {
      establish: vi.fn(async () => session(false)),
      snapshots: vi.fn(async () => ({ snapshots: [], publicKey: fixturePublicKey() })),
      lease: vi.fn(),
      quota: vi.fn(),
      ...overrides,
    },
    rekey,
    payloadHash: (payload) => browserSnapshotPayloadHash(payload),
    now: () => Date.now(),
  };
  return { deps: value, rekey };
}

describe('DEV-957 phase 2: renewing the counter credential while online', () => {
  it('renews when due, keeps only the new signing key, and opens a new session with it', async () => {
    const establish = vi
      .fn()
      .mockResolvedValueOnce(session(true, 'old-session'))
      .mockResolvedValueOnce(session(false, 'new-session'));
    const renew = vi.fn(async () => ({
      secret: `pcd_${'n'.repeat(43)}`,
      credentialExpiresAt: '2027-01-01T00:00:00.000Z',
    }));
    const { deps: value, rekey } = deps({ establish, renew });
    const opened = await openCounterRuntime(ENROLMENT, value, true);
    expect(renew).toHaveBeenCalledWith('old-session');
    expect(rekey).toHaveBeenCalledWith(`pcd_${'n'.repeat(43)}`);
    expect(opened.sessionToken).toBe('new-session');
    expect(opened.renewalFailed).toBe(false);
    // The secret is never written to the counter's document.
    const raw = await value.driver.read(terminalScopeKey(FIXTURE_SCOPE));
    expect(JSON.stringify(raw ?? null)).not.toContain('pcd_');
  });

  it('does not renew when not due', async () => {
    const renew = vi.fn();
    const { deps: value } = deps({ renew });
    await openCounterRuntime(ENROLMENT, value, true);
    expect(renew).not.toHaveBeenCalled();
  });

  it('keeps working on the current credential when renewal fails', async () => {
    const renew = vi.fn(async () => {
      throw new CounterRequestError(0, 'offline');
    });
    const { deps: value } = deps({ establish: vi.fn(async () => session(true)), renew });
    const opened = await openCounterRuntime(ENROLMENT, value, true);
    expect(opened.renewalFailed).toBe(true);
    expect(opened.sessionToken).toBe('token-1');
  });

  it('wipes the counter on a confirmed revocation and counts the unsent sales', async () => {
    const driver = createMemoryDriver();
    const seeded = new PharmacyCounterRuntime(FIXTURE_SCOPE, driver, webCryptoSnapshotVerifier(), '');
    await seeded.hydrate();
    await seeded.adoptLeases([{ leaseId: 'l', blockStart: 1, blockEnd: 9, nextNumber: 1 }]);
    const { deps: value } = deps({
      establish: vi.fn(async () => {
        throw new CounterRequestError(401, 'device_revoked');
      }),
    });
    value.driver = driver;
    const opened = await openCounterRuntime(ENROLMENT, value, true);
    expect(opened.revoked).toEqual({ discarded: 0 });
    expect(opened.sessionToken).toBeNull();
    expect(await driver.read(terminalScopeKey(FIXTURE_SCOPE))).toBeUndefined();
    // Never on a generic refusal: only the server's word "revoked" purges.
    const kept = createMemoryDriver();
    const other = new PharmacyCounterRuntime(FIXTURE_SCOPE, kept, webCryptoSnapshotVerifier(), '');
    await other.hydrate();
    await other.adoptLeases([{ leaseId: 'l', blockStart: 1, blockEnd: 9, nextNumber: 1 }]);
    const refused = deps({
      establish: vi.fn(async () => {
        throw new CounterRequestError(401, 'unauthorized');
      }),
    }).deps;
    refused.driver = kept;
    const signedOut = await openCounterRuntime(ENROLMENT, refused, true);
    expect(signedOut.revoked).toBeUndefined();
    expect(signedOut.runtime.snapshot().queue?.leases).toHaveLength(1);
  });

  it('sign-out forgets unfinished bills but keeps queued work', async () => {
    const driver = createMemoryDriver();
    const runtime = new PharmacyCounterRuntime(FIXTURE_SCOPE, driver, webCryptoSnapshotVerifier(), '');
    await runtime.hydrate();
    await runtime.adoptLeases([{ leaseId: 'l', blockStart: 1, blockEnd: 9, nextNumber: 1 }]);
    await runtime.saveDraft({
      draftId: 'draft_1',
      operatorUserId: 'user_a',
      updatedAt: new Date().toISOString(),
      lines: [
        {
          inventoryLotId: 'lot',
          stockLocationId: 'loc',
          medicineId: 'med',
          presentationId: 'pres',
          packLevelId: 'pack',
          saleUnit: 'UNIT',
          canonicalUnitsPerSaleUnit: 1,
          quantity: 1,
        },
      ],
    });
    await discardCounterDrafts(ENROLMENT, driver);
    const reopened = new PharmacyCounterRuntime(FIXTURE_SCOPE, driver, webCryptoSnapshotVerifier(), '');
    await reopened.hydrate();
    expect(reopened.drafts()).toEqual([]);
    expect(reopened.snapshot().queue?.leases).toHaveLength(1);
  });
});
