/**
 * DEV-957 phase 1: the counter's offline hook, end to end with the real runtime,
 * the real WebCrypto verifier and snapshots signed by the real server signer;
 * only the browser storage, the network and the service worker are replaced.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_SCOPE,
  fixturePayloads,
  fixturePublicKey,
  signedSnapshot,
} from '@/lib/test-support/pharmacy-offline-snapshots';
import type { PharmacyOfflineSnapshotKind } from '@/lib/pharmacy/offline-action-matrix';

const h = vi.hoisted(() => ({
  driver: null as unknown,
  establish: vi.fn(),
  snapshots: vi.fn(),
  arm: vi.fn(async () => true),
}));

vi.mock('@/lib/pharmacy/counter-offline-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/counter-offline-runtime')>();
  return { ...actual, createCounterIndexedDbDriver: () => h.driver };
});
vi.mock('@/lib/pharmacy/counter-device-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/counter-device-store')>();
  return {
    ...actual,
    indexedDbDeviceKeyBackend: () => ({}),
    readCounterEnrolment: async () => ({ ...ENROLMENT, signingKey: {} }),
  };
});
vi.mock('@/lib/pharmacy/counter-offline-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/counter-offline-transport')>();
  return { ...actual, establishCounterSession: h.establish, fetchCounterSnapshots: h.snapshots };
});
vi.mock('@/lib/pharmacy/counter-shell', () => ({ armCounterShell: h.arm }));

import { createMemoryDriver } from '@/lib/pharmacy/counter-offline-runtime';
import { COUNTER_ENROLMENT_MIRROR_KEY } from '@/lib/pharmacy/counter-device-store';
import { CounterRequestError } from '@/lib/pharmacy/counter-offline-transport';
import { useCounterOffline } from './use-counter-offline';

const ENROLMENT = { ...FIXTURE_SCOPE, name: 'Front counter', enrolledAt: '2026-11-19T08:00:00.000Z' };
const KINDS: PharmacyOfflineSnapshotKind[] = ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'];

beforeEach(() => {
  h.driver = createMemoryDriver();
  window.localStorage.setItem(COUNTER_ENROLMENT_MIRROR_KEY, JSON.stringify(ENROLMENT));
  h.establish.mockResolvedValue({
    sessionToken: 'in-memory-token',
    snapshotPublicKey: fixturePublicKey(),
    device: { id: FIXTURE_SCOPE.deviceId },
  });
  // Signed a moment AFTER the counter mounted, as on a fresh online open.
  h.snapshots.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const payloads = fixturePayloads();
    return {
      publicKey: fixturePublicKey(),
      snapshots: KINDS.map((kind) => signedSnapshot(kind, payloads[kind as keyof typeof payloads])),
    };
  });
});
afterEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('DEV-957 useCounterOffline', () => {
  it('is inert for an unenrolled browser', () => {
    window.localStorage.clear();
    const { result } = renderHook(() =>
      useCounterOffline({ organizationId: FIXTURE_SCOPE.organizationId, branchId: FIXTURE_SCOPE.branchId, online: true })
    );
    expect(result.current.status).toBe('unenrolled');
    expect(h.establish).not.toHaveBeenCalled();
  });

  it('uses a list signed after mount at once, and stores the offline shell', async () => {
    const { result } = renderHook(() =>
      useCounterOffline({ organizationId: FIXTURE_SCOPE.organizationId, branchId: FIXTURE_SCOPE.branchId, online: true })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.readiness?.snapshotsReady).toBe(true);
    // The prescription-only lot is not in the signed catalogue, so it is never offered.
    expect(result.current.rows.map((row) => row.medicineName)).toEqual(['ORS sachet', 'Panadol 500mg']);
    expect(result.current.message).toBeNull();
    expect(h.arm).toHaveBeenCalledTimes(1);
  });

  it('opens offline from what it stored, with no request', async () => {
    const online = renderHook(() =>
      useCounterOffline({ organizationId: FIXTURE_SCOPE.organizationId, branchId: FIXTURE_SCOPE.branchId, online: true })
    );
    await waitFor(() => expect(online.result.current.readiness?.snapshotsReady).toBe(true));
    online.unmount();
    h.establish.mockClear();
    const offline = renderHook(() =>
      useCounterOffline({ organizationId: FIXTURE_SCOPE.organizationId, branchId: FIXTURE_SCOPE.branchId, online: false })
    );
    await waitFor(() => expect(offline.result.current.status).toBe('ready'));
    expect(h.establish).not.toHaveBeenCalled();
    expect(offline.result.current.rows).toHaveLength(2);
  });

  it('treats an unreachable server behind a working Wi-Fi as offline', async () => {
    h.establish.mockRejectedValue(new CounterRequestError(0, 'offline'));
    const { result } = renderHook(() =>
      useCounterOffline({ organizationId: FIXTURE_SCOPE.organizationId, branchId: FIXTURE_SCOPE.branchId, online: true })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.serverUnreachable).toBe(true);
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('treats a line that drops during the price-list download as offline too', async () => {
    h.snapshots.mockRejectedValue(new CounterRequestError(0, 'offline'));
    const { result } = renderHook(() =>
      useCounterOffline({ organizationId: FIXTURE_SCOPE.organizationId, branchId: FIXTURE_SCOPE.branchId, online: true })
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.serverUnreachable).toBe(true);
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('is "other-branch" at a branch this computer is not enrolled for', () => {
    const { result } = renderHook(() =>
      useCounterOffline({ organizationId: FIXTURE_SCOPE.organizationId, branchId: 'branch_else', online: true })
    );
    expect(result.current.status).toBe('other-branch');
    expect(h.establish).not.toHaveBeenCalled();
  });
});
