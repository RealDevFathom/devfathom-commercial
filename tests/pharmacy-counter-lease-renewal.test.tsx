import { webcrypto } from 'node:crypto';
import { act, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CounterOfflinePanel } from '@/components/pharmacy/counter/counter-offline-panel';
import { useCounterOffline } from '@/components/pharmacy/counter/use-counter-offline';
import { importCounterSigningKey } from '@/lib/pharmacy/counter-device-signing';
import { COUNTER_ENROLMENT_MIRROR_KEY } from '@/lib/pharmacy/counter-device-store';
import {
  COUNTER_LEASE_RENEWAL_INTERVAL_MS,
  createMemoryDriver,
  PharmacyCounterRuntime,
} from '@/lib/pharmacy/counter-offline-runtime';

const h = vi.hoisted(() => ({
  driver: undefined as ReturnType<typeof createMemoryDriver> | undefined,
  signingKey: undefined as CryptoKey | undefined,
}));
const SCOPE = {
  organizationId: 'org_fixture',
  branchId: 'branch_fixture',
  deviceId: 'device_fixture',
};
const ENROLMENT = { ...SCOPE, name: 'Front counter', enrolledAt: '2026-11-19T08:00:00.000Z' };
const HELD_BLOCK = { leaseId: 'held', blockStart: 1, blockEnd: 100, nextNumber: 51 };
const SESSION = 'fixture-terminal-session';
const WARNING = 'Receipt numbers could not be reserved.';

vi.mock('@/lib/pharmacy/counter-offline-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/counter-offline-runtime')>()),
  createCounterIndexedDbDriver: () => h.driver,
}));
vi.mock('@/lib/pharmacy/counter-device-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/counter-device-store')>()),
  indexedDbDeviceKeyBackend: () => ({}),
  readCounterEnrolment: async () => ({ ...ENROLMENT, signingKey: h.signingKey }),
}));
vi.mock('@/lib/pharmacy/counter-shell', () => ({ armCounterShell: async () => true }));

function Counter() {
  const offline = useCounterOffline({ ...SCOPE, online: true });
  return <CounterOfflinePanel offline={offline} />;
}

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  h.signingKey = await importCounterSigningKey(`pcd_${'a'.repeat(43)}`);
  expect(h.signingKey.extractable).toBe(false);
  h.driver = createMemoryDriver();
  window.localStorage.setItem(COUNTER_ENROLMENT_MIRROR_KEY, JSON.stringify(ENROLMENT));
  const stored = new PharmacyCounterRuntime(SCOPE, h.driver, { verify: () => false }, 'unused');
  await stored.adoptLeases([HELD_BLOCK]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('DEV-767 counter receipt lease renewal', () => {
  it.each([200, 403])(
    'rechecks a depleted runway mid-shift (lease response %i)',
    async (status) => {
      const reserve = vi.fn<(init?: RequestInit) => Response>(() =>
        status === 200
          ? Response.json({
              id: 'new',
              deviceId: SCOPE.deviceId,
              blockStart: 101,
              blockEnd: 200,
              nextNumber: 101,
            })
          : Response.json({ error: 'branch_forbidden' }, { status })
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          switch (url) {
            case '/api/pharmacy/counter/establish':
              return Response.json({
                device: { id: SCOPE.deviceId },
                sessionToken: SESSION,
                snapshotPublicKey: 'unused',
              });
            case '/api/pharmacy/counter/snapshot':
              return Response.json({ publicKey: 'unused', snapshots: [] });
            case '/api/pharmacy/counter/lease':
              return reserve(init);
            default:
              throw new Error(`Unexpected counter request ${url}`);
          }
        })
      );
      const hydrate = vi.spyOn(PharmacyCounterRuntime.prototype, 'hydrate');
      const warn = vi.spyOn(toast, 'warning');
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      render(<Counter />);
      const receiptCount = (await screen.findByText('Receipt numbers left')).nextElementSibling;
      expect(receiptCount).toHaveTextContent(/^50$/);
      expect(reserve).not.toHaveBeenCalled();

      const runtime = hydrate.mock.contexts[0] as PharmacyCounterRuntime;
      // Simulate the runway dwindling without enabling or taking offline cash sales.
      const held = { ...HELD_BLOCK, nextNumber: status === 200 ? 101 : 98 };
      await runtime.adoptLeases([held]);
      await act(() => vi.advanceTimersByTimeAsync(COUNTER_LEASE_RENEWAL_INTERVAL_MS));

      expect(reserve).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-terminal-session': SESSION },
          body: JSON.stringify({ size: 100 }),
        })
      );
      const leases = runtime.snapshot().queue?.leases;
      if (status === 200) {
        expect(leases).toEqual([
          held,
          { leaseId: 'new', blockStart: 101, blockEnd: 200, nextNumber: 101 },
        ]);
        expect(receiptCount).toHaveTextContent(/^100$/);
        expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
        expect(warn).not.toHaveBeenCalled();
      } else {
        expect(leases).toEqual([held]);
        expect(screen.getByText(WARNING)).toBeVisible();
        expect(warn).toHaveBeenCalledExactlyOnceWith(WARNING);
      }
    }
  );
});
