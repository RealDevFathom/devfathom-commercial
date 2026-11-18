/**
 * DEV-767: the counter keeps its offline receipt runway topped up in the
 * background, through the cashier's own terminal transport, so an exhausted
 * lease never stops a sale mid-shift.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryDriver } from '@/lib/retail-terminal/local-store';
import { PharmacyCounterRuntime } from '@/lib/pharmacy/counter-offline-runtime';

import {
  COUNTER_LEASE_PATH,
  counterLeaseReserver,
  useReceiptLeaseRenewal,
} from './use-receipt-lease-renewal';

const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', deviceId: 'counter_1' };
const CREDENTIALS = { deviceSecret: `pcd_${'a'.repeat(43)}`, sessionToken: 'payload.mac' };
const BLOCK = {
  id: 'lease_2',
  deviceId: SCOPE.deviceId,
  blockStart: 1_000,
  blockEnd: 1_099,
  nextNumber: 1_000,
};

/** A counter down to its last three reserved numbers. */
async function lowCounter() {
  const runtime = new PharmacyCounterRuntime(
    SCOPE,
    createMemoryDriver(),
    { verify: () => false },
    'public-key'
  );
  await runtime.adoptLeases([{ leaseId: 'lease_1', blockStart: 900, blockEnd: 902, nextNumber: 900 }]);
  return runtime;
}

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => {
  vi.useRealTimers();
});

describe('DEV-767 counterLeaseReserver', () => {
  it("asks the lease endpoint for this terminal's block with its own credentials", async () => {
    const fetchImpl = answer(200, BLOCK);
    await expect(counterLeaseReserver(CREDENTIALS, fetchImpl)(100)).resolves.toEqual(BLOCK);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      COUNTER_LEASE_PATH,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${CREDENTIALS.deviceSecret}`,
          'X-Terminal-Session': CREDENTIALS.sessionToken,
        }),
        body: JSON.stringify({ size: 100 }),
      })
    );
  });

  it('throws on a refusal so the runtime keeps the blocks it holds', async () => {
    await expect(
      counterLeaseReserver(CREDENTIALS, answer(403, { error: 'branch_forbidden' }))(100)
    ).rejects.toThrow('lease_refused_403');
  });
});

describe('DEV-767 useReceiptLeaseRenewal', () => {
  it('renews a low runway in the background once the counter is established', async () => {
    const runtime = await lowCounter();
    const fetchImpl = answer(200, BLOCK);
    const { result } = renderHook(() =>
      useReceiptLeaseRenewal(runtime, CREDENTIALS, { fetchImpl })
    );
    await waitFor(() => expect(result.current).toEqual({ status: 'RENEWED', remaining: 103 }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().queue?.leases.map((lease) => lease.leaseId)).toEqual([
      'lease_1',
      'lease_2',
    ]);
  });

  it('reports a refused renewal and keeps the held block', async () => {
    const runtime = await lowCounter();
    const before = runtime.snapshot().queue?.leases;
    const { result } = renderHook(() =>
      useReceiptLeaseRenewal(runtime, CREDENTIALS, {
        fetchImpl: answer(403, { error: 'forbidden' }),
      })
    );
    await waitFor(() => expect(result.current).toEqual({ status: 'FAILED', remaining: 3 }));
    expect(runtime.snapshot().queue?.leases).toEqual(before);
  });

  it('does nothing until the counter has an established terminal session', async () => {
    const runtime = await lowCounter();
    const fetchImpl = answer(200, BLOCK);
    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useReceiptLeaseRenewal(ready ? runtime : null, ready ? CREDENTIALS : null, { fetchImpl }),
      { initialProps: { ready: false } }
    );
    await act(async () => {});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
    rerender({ ready: true });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  });

  it('re-checks on every interval and stops when the counter closes', async () => {
    vi.useFakeTimers();
    const renewReceiptLeases = vi.fn(async () => ({
      status: 'SUFFICIENT' as const,
      remaining: 50,
    }));
    const runtime = { renewReceiptLeases };
    const { unmount } = renderHook(() =>
      useReceiptLeaseRenewal(runtime, CREDENTIALS, { intervalMs: 1_000 })
    );
    expect(renewReceiptLeases).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(renewReceiptLeases).toHaveBeenCalledTimes(2);
    unmount();
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event('online'));
    expect(renewReceiptLeases).toHaveBeenCalledTimes(2);
  });
});
