/**
 * DEV-957 phase 2: selling offline through the counter's hook, with the real runtime, the
 * real WebCrypto verifier and snapshots signed by the real server signer; only browser
 * storage (an in-memory driver that outlives a "reload"), the network and the service
 * worker are replaced.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_SCOPE,
  fixturePublicKey,
  fixtureSalePayloads,
  signedSnapshot,
} from '@/lib/test-support/pharmacy-offline-snapshots';
import type { PharmacyOfflineSnapshotKind } from '@/lib/pharmacy/offline-action-matrix';

const h = vi.hoisted(() => ({
  driver: null as unknown,
  establish: vi.fn(),
  snapshots: vi.fn(),
  arm: vi.fn(async () => true),
  clear: vi.fn(async () => undefined),
  forget: vi.fn(async () => {
    window.localStorage.clear();
    window.dispatchEvent(new Event('devfathom:pharmacy-counter-enrolment'));
  }),
  unbind: vi.fn(async () => undefined),
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
    // A real non-extractable HMAC key from a throwaway test secret: the hook seals each
    // sale with it at the moment of sale (hardening 4).
    readCounterEnrolment: async () => ({
      ...ENROLMENT,
      signingKey: await globalThis.crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(`pcd_${'k'.repeat(43)}`),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      ),
    }),
    forgetCounterEnrolment: h.forget,
  };
});
vi.mock('@/lib/pharmacy/counter-offline-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pharmacy/counter-offline-transport')>();
  return {
    ...actual,
    establishCounterSession: h.establish,
    fetchCounterSnapshots: h.snapshots,
    unbindCounterBrowser: h.unbind,
  };
});
vi.mock('@/lib/pharmacy/counter-shell', () => ({
  armCounterShell: h.arm,
  clearCounterShell: h.clear,
}));

import { createMemoryDriver, PharmacyCounterRuntime } from '@/lib/pharmacy/counter-offline-runtime';
import { COUNTER_ENROLMENT_MIRROR_KEY } from '@/lib/pharmacy/counter-device-store';
import { CounterRequestError } from '@/lib/pharmacy/counter-offline-transport';
import { webCryptoSnapshotVerifier } from '@/lib/pharmacy/counter-snapshot-verifier';
import { addToOfflineDraft, newOfflineDraft } from '@/lib/pharmacy/counter-offline-sale';
import { readReconcileIndex, readReconcileRecord } from '@/lib/pharmacy/counter-reconcile';
import { useCounterOffline, type CounterOfflineView } from './use-counter-offline';
import { CounterOfflinePanel } from './counter-offline-panel';

const ENROLMENT = { ...FIXTURE_SCOPE, name: 'Front counter', enrolledAt: '2026-11-19T08:00:00.000Z' };
const KINDS: PharmacyOfflineSnapshotKind[] = ['CATALOG', 'PRICES', 'TAX', 'RULES', 'LOT_BALANCES'];
const props = (online: boolean) => ({
  organizationId: FIXTURE_SCOPE.organizationId,
  branchId: FIXTURE_SCOPE.branchId,
  online,
});

function issue(operator = { userId: 'user_cashier_a', name: 'Ayesha Khan' }) {
  const payloads = fixtureSalePayloads({ operator });
  return KINDS.map((kind) => signedSnapshot(kind, payloads[kind as keyof typeof payloads]));
}

beforeEach(async () => {
  h.driver = createMemoryDriver();
  window.localStorage.setItem(COUNTER_ENROLMENT_MIRROR_KEY, JSON.stringify(ENROLMENT));
  h.establish.mockResolvedValue({
    sessionToken: 'in-memory-token',
    snapshotPublicKey: fixturePublicKey(),
    device: { id: FIXTURE_SCOPE.deviceId },
  });
  h.snapshots.mockImplementation(async () => ({ publicKey: fixturePublicKey(), snapshots: issue() }));
  // The receipt block a manager reserved when preparing this counter.
  const runtime = new PharmacyCounterRuntime(
    FIXTURE_SCOPE,
    h.driver as never,
    webCryptoSnapshotVerifier(),
    fixturePublicKey()
  );
  await runtime.hydrate();
  await runtime.adoptLeases([{ leaseId: 'lease_a', blockStart: 501, blockEnd: 510, nextNumber: 501 }]);
});
afterEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

async function preparedOnline() {
  const online = renderHook(() => useCounterOffline(props(true)));
  await waitFor(() => expect(online.result.current.actions).not.toBeNull());
  online.unmount();
}

function oneTablet(view: CounterOfflineView, lotId = 'lot_panadol_a') {
  const row = view.rows.find((candidate) => candidate.inventoryLotId === lotId)!;
  const unit = row.saleUnits.find((option) => option.kind === 'UNIT')!;
  return addToOfflineDraft(newOfflineDraft(view.operator?.userId ?? null, new Date()), row, unit, new Date());
}

describe('DEV-957 phase 2: selling offline through the counter', () => {
  it('keeps a sale queued after the browser is closed offline; the next sale takes the next number', async () => {
    await preparedOnline();
    const first = renderHook(() => useCounterOffline(props(false)));
    await waitFor(() => expect(first.result.current.actions).not.toBeNull());
    let paid!: Awaited<ReturnType<NonNullable<CounterOfflineView['actions']>['pay']>>;
    await act(async () => {
      paid = await first.result.current.actions!.pay(oneTablet(first.result.current), 500);
    });
    expect(paid).toMatchObject({ ok: true, changeMinor: 150 });
    if (!paid.ok) return;
    expect(paid.receipt.receiptNumber).toBe(501);
    expect(paid.receipt.cashierName).toBe('Ayesha Khan');
    await waitFor(() => expect(first.result.current.queued).toHaveLength(1));
    first.unmount();

    const reopened = renderHook(() => useCounterOffline(props(false)));
    await waitFor(() => expect(reopened.result.current.actions).not.toBeNull());
    expect(h.establish).toHaveBeenCalledTimes(1);
    expect(reopened.result.current.queued.map((command) => command.receiptNumber)).toEqual([501]);
    let next!: Awaited<ReturnType<NonNullable<CounterOfflineView['actions']>['pay']>>;
    await act(async () => {
      next = await reopened.result.current.actions!.pay(oneTablet(reopened.result.current), 350);
    });
    expect(next.ok && next.receipt.receiptNumber).toBe(502);
  });

  it('two sales tapped at once draw two different numbers and sequences (#554)', async () => {
    await preparedOnline();
    const view = renderHook(() => useCounterOffline(props(false)));
    await waitFor(() => expect(view.result.current.actions).not.toBeNull());
    const actions = view.result.current.actions!;
    let both: Array<Awaited<ReturnType<typeof actions.pay>>> = [];
    await act(async () => {
      both = await Promise.all([
        actions.pay(oneTablet(view.result.current), 350),
        actions.pay(oneTablet(view.result.current, 'lot_brufen'), 50),
      ]);
    });
    expect(both.every((result) => result.ok)).toBe(true);
    const numbers = both.map((result) => (result.ok ? result.command.receiptNumber : null));
    const sequences = both.map((result) => (result.ok ? result.command.sequence : null));
    expect(new Set(numbers)).toEqual(new Set([501, 502]));
    expect(new Set(sequences)).toEqual(new Set([1, 2]));
    await waitFor(() => expect(view.result.current.queued).toHaveLength(2));
  });

  it('brings back a bill being built after a reload', async () => {
    await preparedOnline();
    const first = renderHook(() => useCounterOffline(props(false)));
    await waitFor(() => expect(first.result.current.actions).not.toBeNull());
    const draft = oneTablet(first.result.current);
    await act(async () => {
      expect(await first.result.current.actions!.saveDraft(draft)).toBe(true);
    });
    first.unmount();
    const reopened = renderHook(() => useCounterOffline(props(false)));
    await waitFor(() => expect(reopened.result.current.drafts).toEqual([draft]));
  });

  it('clears the previous cashier bills and stored page when another person signs in', async () => {
    await preparedOnline();
    const offline = renderHook(() => useCounterOffline(props(false)));
    await waitFor(() => expect(offline.result.current.actions).not.toBeNull());
    await act(async () => {
      await offline.result.current.actions!.saveDraft(oneTablet(offline.result.current));
    });
    offline.unmount();
    h.snapshots.mockImplementation(async () => ({
      publicKey: fixturePublicKey(),
      snapshots: issue({ userId: 'user_cashier_b', name: 'Bilal' }).map((snapshot) =>
        signedSnapshot(snapshot.envelope.kind, snapshot.payload, { version: 2 })
      ),
    }));
    const next = renderHook(() => useCounterOffline(props(true)));
    await waitFor(() => expect(next.result.current.operator?.name).toBe('Bilal'));
    expect(next.result.current.drafts).toEqual([]);
    expect(h.clear).toHaveBeenCalled();
  });

  it('stops the counter when the server says it was revoked, keeps its unsent sale, and can never sell again', async () => {
    await preparedOnline();
    const offline = renderHook(() => useCounterOffline(props(false)));
    await waitFor(() => expect(offline.result.current.actions).not.toBeNull());
    await act(async () => {
      await offline.result.current.actions!.pay(oneTablet(offline.result.current), 500);
    });
    offline.unmount();
    h.establish.mockRejectedValue(new CounterRequestError(401, 'device_revoked'));
    const back = renderHook(() => useCounterOffline(props(true)));
    await waitFor(() => expect(back.result.current.revokedNotice).toEqual({ kept: 1 }));
    expect(back.result.current.status).toBe('unenrolled');
    expect(back.result.current.actions).toBeNull();
    expect(h.forget).toHaveBeenCalled();
    expect(h.unbind).toHaveBeenCalled();
    expect(h.clear).toHaveBeenCalled();
    // Nothing of the counter is left on this computer: no price list, receipt block or bill.
    expect(await (h.driver as ReturnType<typeof createMemoryDriver>).read(
      `${FIXTURE_SCOPE.organizationId}::${FIXTURE_SCOPE.branchId}::${FIXTURE_SCOPE.deviceId}`
    )).toBeUndefined();
    // Except the sale it took and never sent: kept read-only for a manager (review B2).
    const driver = h.driver as ReturnType<typeof createMemoryDriver>;
    const [entry] = await readReconcileIndex(driver);
    const record = await readReconcileRecord(driver, entry!.recordKey);
    expect(record?.sales).toHaveLength(1);
    expect(record?.sales[0]?.payload.seal).toBeTruthy();
  });
});

describe('DEV-957 phase 2 (review B1): with the owner switch off the counter checks prices only', () => {
  it('offers no offline bill and refuses every offline sale, as after phase 1', async () => {
    h.snapshots.mockImplementation(async () => ({
      publicKey: fixturePublicKey(),
      snapshots: KINDS.map((kind) => {
        const payloads = fixtureSalePayloads({ offlineCashSelling: false });
        return signedSnapshot(kind, payloads[kind as keyof typeof payloads]);
      }),
    }));
    await preparedOnline();
    const view = renderHook(() => useCounterOffline(props(false)));
    await waitFor(() => expect(view.result.current.actions).not.toBeNull());
    expect(view.result.current.sellingOn).toBe(false);
    const paid = await view.result.current.actions!.pay(oneTablet(view.result.current), 500);
    expect(paid).toEqual({
      ok: false,
      message:
        'Offline cash selling is off. It becomes available when sending offline sales to the server is ready; until then this counter checks prices only.',
    });
    render(<CounterOfflinePanel offline={view.result.current} />);
    expect(screen.getByText(/Offline cash selling is off:/)).toBeInTheDocument();
    expect(screen.getByLabelText('Offline price check')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add a medicine to the offline bill')).toBeNull();
    expect(screen.queryByRole('button', { name: /Take cash/ })).toBeNull();
  });
});

describe('DEV-957 phase 2: the offline sale screen', () => {
  it('shows "Paid" and the receipt only after the sale is written, and keeps the bill when it is refused', async () => {
    await preparedOnline();
    const view = renderHook(() => useCounterOffline(props(false)));
    await waitFor(() => expect(view.result.current.actions).not.toBeNull());
    const real = view.result.current;
    let allow = false;
    const offline: CounterOfflineView = {
      ...real,
      actions: {
        ...real.actions!,
        pay: async (draft, cash) =>
          allow
            ? real.actions!.pay(draft, cash)
            : {
                ok: false,
                message:
                  'This counter has used every receipt number it was given, so it cannot take another sale offline. Connect, or ask a manager to prepare it again.',
              },
      },
    };
    render(<CounterOfflinePanel offline={offline} />);
    await waitFor(() =>
      expect(screen.getByLabelText('Add a medicine to the offline bill')).toBeInTheDocument()
    );
    expect(screen.getByText(/Ayesha Khan, who was signed in when this counter last connected/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Add a medicine to the offline bill'), {
      target: { value: 'pana' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add tablet' }));
    expect(await screen.findByText('Rs 3.50 each', { exact: false })).toBeInTheDocument();
    const cash = screen.getByLabelText(/Cash received/);
    fireEvent.change(cash, { target: { value: '3.505' } });
    expect(screen.getByText('Use at most 2 decimal places, for example 125.50.')).toBeInTheDocument();
    fireEvent.change(cash, { target: { value: '5' } });
    expect(screen.getByText('Rs 1.50')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take cash Rs 3.50' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('used every receipt number');
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Offline bill lines' })).toBeInTheDocument();

    allow = true;
    fireEvent.click(screen.getByRole('button', { name: 'Take cash Rs 3.50' }));
    expect(await screen.findByText('Paid')).toBeInTheDocument();
    expect(screen.getByText(/Receipt 501/)).toBeInTheDocument();
    expect(screen.getByLabelText('Receipt 501')).toHaveTextContent('Counter Front counter, sold offline');
  });
});

describe('DEV-957 phase 2: the paid sale stays on screen when it ends offline selling', () => {
  it('keeps Paid, the receipt and the change after the sale that used the last receipt number', async () => {
    // A counter holding exactly one receipt number.
    h.driver = createMemoryDriver();
    const runtime = new PharmacyCounterRuntime(
      FIXTURE_SCOPE,
      h.driver as never,
      webCryptoSnapshotVerifier(),
      fixturePublicKey()
    );
    await runtime.hydrate();
    await runtime.adoptLeases([{ leaseId: 'lease_one', blockStart: 777, blockEnd: 777, nextNumber: 777 }]);
    await preparedOnline();

    function Counter() {
      return <CounterOfflinePanel offline={useCounterOffline(props(false))} />;
    }
    render(<Counter />);
    await waitFor(() =>
      expect(screen.getByLabelText('Add a medicine to the offline bill')).toBeInTheDocument()
    );
    fireEvent.change(screen.getByLabelText('Add a medicine to the offline bill'), {
      target: { value: 'pana' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add tablet' }));
    fireEvent.change(await screen.findByLabelText(/Cash received/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Take cash Rs 3.50' }));

    expect(await screen.findByText('Paid')).toBeInTheDocument();
    // No receipt number is left, so no further offline sale can be started …
    await waitFor(() =>
      expect(screen.queryByLabelText('Add a medicine to the offline bill')).not.toBeInTheDocument()
    );
    // … but the sale just taken still shows its receipt and the change to hand back.
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText(/Receipt 777/)).toBeInTheDocument();
    expect(screen.getByText('Rs 1.50')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next customer' }));
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
  });
});

describe('DEV-957 replay on reconnect', () => {
  async function waitingSales() {
    await preparedOnline();
    const offline = renderHook(() => useCounterOffline(props(false)));
    await waitFor(() => expect(offline.result.current.actions).not.toBeNull());
    await act(async () => {
      expect(
        (await offline.result.current.actions!.pay(oneTablet(offline.result.current), 500)).ok
      ).toBe(true);
      expect(
        (
          await offline.result.current.actions!.pay(
            oneTablet(offline.result.current, 'lot_brufen'),
            50
          )
        ).ok
      ).toBe(true);
    });
    offline.unmount();
  }

  it('sends the sealed sales in order and keeps a refused head visible across a reload until a manager settles it', async () => {
    await waitingSales();
    const requests: Array<{ path: string; sequence: number; key: string | null }> = [];
    const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, options) => {
      const body = JSON.parse(String(options?.body));
      const command = body.command ?? body;
      const headers = new Headers(options?.headers);
      expect(headers.get('x-terminal-session')).toBe('in-memory-token');
      expect(headers.get('x-command-signature')).toMatch(/^[a-f0-9]{64}$/);
      expect(command.seal).toBeTruthy();
      requests.push({
        path: String(path),
        sequence: command.sequence,
        key: headers.get('idempotency-key'),
      });
      if (String(path).endsWith('/reject'))
        return Response.json({ commandId: 'db-command-1', status: 'REJECTED', replayed: false });
      return command.sequence === 1
        ? Response.json({ error: 'PERIOD_CLOSED' }, { status: 409 })
        : Response.json({ saleId: 'sale-2', receiptNumber: 502, replayed: false });
    });
    try {
      const back = renderHook(() => useCounterOffline(props(true)));
      await waitFor(() => expect(back.result.current.queued[0]?.status).toBe('QUARANTINED'));
      expect(back.result.current.queued[0]?.rejection).toMatch(/closed/i);
      const first = back.result.current.queued[0]!;
      back.unmount();
      const again = renderHook(() => useCounterOffline(props(true)));
      await waitFor(() => expect(again.result.current.actions).not.toBeNull());
      expect(again.result.current.queued.map((c) => c.sequence)).toEqual([1, 2]);
      expect(requests.map((r) => r.sequence)).toEqual([1]);
      await act(async () => {
        await again.result.current.actions!.resolveConflict!(first.commandId, 'Refunded the cash');
      });
      await waitFor(() => expect(again.result.current.actions).not.toBeNull());
      expect(again.result.current.queued).toHaveLength(0);
      expect(requests.map((r) => [r.path, r.sequence])).toEqual([
        ['/api/pharmacy/counter/replay', 1],
        ['/api/pharmacy/counter/reject', 1],
        ['/api/pharmacy/counter/replay', 2],
      ]);
      expect(requests[0]?.key).toBe(first.commandId);
      expect(requests[1]?.key).toBe(first.commandId);
      again.unmount();
    } finally {
      send.mockRestore();
    }
  });
});
