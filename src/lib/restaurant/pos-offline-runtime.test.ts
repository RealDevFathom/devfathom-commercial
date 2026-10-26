import { describe, expect, it } from 'vitest';

import { createMemoryDriver } from './pos-client-store';
import { PosOfflineRuntime } from './pos-offline-runtime';

const scope = { organizationId: 'org-1', branchId: 'branch-1', deviceId: 'device-1' };
const input = {
  deviceId: scope.deviceId,
  composerStaffProfileId: 'staff-1',
  composerProof: 'signed-composer-proof',
  catalogVersion: 'catalog-1',
  clientOriginAt: '2026-08-31T00:00:00.000Z',
  open: { channel: 'TAKEAWAY' as const, publicationId: 'publication-1' },
  lines: [
    {
      menuItemId: 'menu-item-1',
      quantity: 1,
      quotedUnitPrice: '4.00',
    },
  ],
};

describe('PosOfflineRuntime', () => {
  it('replays a persisted draft only as the operator who composed it', async () => {
    const runtime = new PosOfflineRuntime(scope, createMemoryDriver());
    await runtime.enqueue(input);
    const send = async () => ({ status: 201, serverRef: 'server-ref' });

    expect(await runtime.replay('staff-2', send)).toEqual({
      state: 'REFUSED',
      discarded: null,
    });
    expect(runtime.snapshot().queue?.drafts[0]?.status).toBe('QUEUED');

    expect((await runtime.replay('staff-1', send)).state).toBe('IDLE');
    expect(runtime.snapshot().queue?.drafts[0]?.status).toBe('COMPLETED');
  });

  it('renews a queued proof only for the reauthenticated composing operator', async () => {
    const runtime = new PosOfflineRuntime(scope, createMemoryDriver());
    await runtime.enqueue(input);

    await runtime.renewComposerProof('staff-2', 'wrong-operator-proof');
    expect(runtime.snapshot().queue?.drafts[0]?.composerProof).toBe('signed-composer-proof');

    await runtime.renewComposerProof('staff-1', 'renewed-proof');
    await runtime.replay('staff-1', async (request) => {
      expect(request.headers['X-POS-Composer-Proof']).toBe('renewed-proof');
      return { status: 201, serverRef: 'server-ref' };
    });
  });

  it('hydrates an atomically persisted draft and resumes at the first unacknowledged command', async () => {
    const driver = createMemoryDriver();
    const first = new PosOfflineRuntime(scope, driver);
    await first.enqueue(input);

    const calls: string[] = [];
    await first.replay('staff-1', async (request) => {
      calls.push(request.path);
      if (calls.length === 1) return { status: 201, serverRef: 'order-1' };
      return { status: 0 };
    });

    const reloaded = new PosOfflineRuntime(scope, driver);
    expect(await reloaded.hydrate()).toBe('ready');
    await reloaded.replay('staff-1', async (request) => {
      calls.push(request.path);
      expect(request.body).toMatchObject({ orderId: 'order-1' });
      return { status: 201, serverRef: 'item-1' };
    });
    expect(calls).toEqual([
      '/api/restaurant/orders/open',
      '/api/restaurant/orders/add-item',
      '/api/restaurant/orders/add-item',
    ]);
    expect(reloaded.snapshot().queue?.drafts[0]?.status).toBe('COMPLETED');
  });

  it('reuses the stable key after response loss and pauses without purge for reauth', async () => {
    const runtime = new PosOfflineRuntime(scope, createMemoryDriver());
    await runtime.enqueue(input);
    const keys: string[] = [];
    await runtime.replay('staff-1', async (request) => {
      keys.push(request.headers['Idempotency-Key']);
      return { status: 0 };
    });
    await runtime.replay('staff-1', async (request) => {
      keys.push(request.headers['Idempotency-Key']);
      return { status: 401, serverMessage: 'Terminal session is no longer valid.' };
    });
    expect(keys[0]).toBe(keys[1]);
    expect(runtime.snapshot().queue?.replay).toBe('PAUSED_REAUTH');
    expect(runtime.snapshot().queue?.drafts).toHaveLength(1);
  });

  it('coalesces concurrent replay triggers into one transport pass', async () => {
    const runtime = new PosOfflineRuntime(scope, createMemoryDriver());
    await runtime.enqueue(input);
    const calls: string[] = [];
    let releaseOpen!: () => void;
    let openStarted!: () => void;
    const openPending = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const started = new Promise<void>((resolve) => {
      openStarted = resolve;
    });
    const send = async (request: { path: string }) => {
      calls.push(request.path);
      if (request.path.endsWith('/open')) {
        openStarted();
        await openPending;
        return { status: 201, serverRef: 'order-1' };
      }
      return { status: 201, serverRef: 'item-1' };
    };

    const onlineReplay = runtime.replay('staff-1', send);
    const duplicateOnlineReplay = runtime.replay('staff-1', send);
    expect(duplicateOnlineReplay).toBe(onlineReplay);
    await started;
    expect(calls).toEqual(['/api/restaurant/orders/open']);

    releaseOpen();
    await Promise.all([onlineReplay, duplicateOnlineReplay]);
    expect(calls).toEqual(['/api/restaurant/orders/open', '/api/restaurant/orders/add-item']);
  });

  it('purges only a confirmed revocation and reports the discarded draft', async () => {
    const driver = createMemoryDriver();
    const runtime = new PosOfflineRuntime(scope, driver);
    await runtime.enqueue(input);
    const result = await runtime.replay('staff-1', async () => ({
      status: 403,
      serverMessage: 'This device has been revoked.',
    }));
    expect(result).toMatchObject({ state: 'STOPPED', discarded: { drafts: 1 } });

    const reloaded = new PosOfflineRuntime(scope, driver);
    expect(await reloaded.hydrate()).toBe('ready');
    expect(reloaded.snapshot().queue?.drafts).toEqual([]);
  });
});
