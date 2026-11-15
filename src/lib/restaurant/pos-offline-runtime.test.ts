import { afterEach, describe, expect, it, vi } from 'vitest';

import { withTerminalScopeLock } from '@/lib/retail-terminal/local-store';

import { createMemoryDriver, posScopeKey, readPosState, writePosState } from './pos-client-store';
import type { PosQueueSnapshot } from './pos-command-queue';
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
  it.each(['composerStaffProfileId', 'composerProof'])(
    'quarantines legacy drafts missing %s without blocking signed work',
    async (field) => {
      const driver = createMemoryDriver();
      const first = new PosOfflineRuntime(scope, driver);
      await first.enqueue(input);
      await first.enqueue(input);
      const legacy = first.snapshot().queue!.drafts[0];
      Reflect.deleteProperty(legacy, field);
      await writePosState(driver, first.snapshot());

      const reloaded = new PosOfflineRuntime(scope, driver);
      expect(await reloaded.hydrate()).toBe('ready');
      expect(reloaded.snapshot().queue!.drafts[0]).toMatchObject({
        draftId: legacy.draftId,
        status: 'QUARANTINED',
        review: { reason: 'COMPOSER_UNVERIFIED' },
        commands: legacy.commands,
      });
      await reloaded.resolveReview(legacy.draftId, 'REPLAY');
      expect(reloaded.snapshot().queue!.drafts[0].status).toBe('QUARANTINED');
      let sent = 0;
      await reloaded.replay('staff-1', async (request) => {
        expect(request.headers['X-POS-Composer-Proof']).toBe(input.composerProof);
        sent++;
        return { status: 201, serverRef: 'server-ref' };
      });
      expect(sent).toBe(2); // Only the signed draft's open/add commands.
      expect(reloaded.snapshot().queue!.drafts[1].status).toBe('COMPLETED');
      await reloaded.resolveReview(legacy.draftId, 'DISCARD');
      const again = new PosOfflineRuntime(scope, driver);
      await again.hydrate();
      expect(again.snapshot().queue!.drafts.map((draft) => draft.draftId)).not.toContain(
        legacy.draftId
      );
    }
  );
  it('replays a persisted draft only as the operator who composed it', async () => {
    const runtime = new PosOfflineRuntime(scope, createMemoryDriver());
    await runtime.enqueue(input);
    const send = async () => ({ status: 201, serverRef: 'server-ref' });

    expect(await runtime.replay('staff-2', send)).toEqual({
      state: 'REFUSED',
      discarded: null,
      waitingComposers: ['staff-1'],
    });
    expect(runtime.snapshot().queue?.drafts[0]?.status).toBe('QUEUED');

    expect((await runtime.replay('staff-1', send)).state).toBe('IDLE');
    expect(runtime.snapshot().queue?.drafts[0]?.status).toBe('COMPLETED');
  });

  it('renews a queued proof only for the reauthenticated composing operator', async () => {
    const runtime = new PosOfflineRuntime(scope, createMemoryDriver());
    await runtime.enqueue(input);

    await runtime.renewComposerProof('staff-2', async () => 'wrong-operator-proof');
    expect(runtime.snapshot().queue?.drafts[0]?.composerProof).toBe('signed-composer-proof');

    await runtime.renewComposerProof('staff-1', async () => 'renewed-proof');
    await runtime.replay('staff-1', async (request) => {
      expect(request.headers['X-POS-Composer-Proof']).toBe('renewed-proof');
      return { status: 201, serverRef: 'server-ref' };
    });
  });

  it('does not call renewal for proofs that are still valid', async () => {
    const runtime = new PosOfflineRuntime(scope, createMemoryDriver());
    await runtime.enqueue(input);
    let renewals = 0;

    await runtime.renewComposerProof(
      'staff-1',
      async () => {
        renewals++;
        return 'renewed-proof';
      },
      () => false
    );
    expect(renewals).toBe(0);
    expect(runtime.snapshot().queue?.drafts[0]?.composerProof).toBe('signed-composer-proof');
  });

  it("replays the current operator's later draft while an earlier draft waits for its composer", async () => {
    const runtime = new PosOfflineRuntime(scope, createMemoryDriver());
    await runtime.enqueue(input);
    await runtime.enqueue({
      ...input,
      composerStaffProfileId: 'staff-2',
      composerProof: 'proof-b',
    });
    const sentProofs: string[] = [];

    expect(
      await runtime.replay('staff-2', async (request) => {
        sentProofs.push(request.headers['X-POS-Composer-Proof']);
        return { status: 201, serverRef: 'server-ref' };
      })
    ).toEqual({ state: 'REFUSED', discarded: null, waitingComposers: ['staff-1'] });
    expect(new Set(sentProofs)).toEqual(new Set(['proof-b']));
    expect(runtime.snapshot().queue?.drafts.map((draft) => draft.status)).toEqual([
      'QUEUED',
      'COMPLETED',
    ]);
  });

  it('cannot renew after tampering the unsigned composer id', async () => {
    const driver = createMemoryDriver();
    const runtime = new PosOfflineRuntime(scope, driver);
    await runtime.enqueue(input);
    const draft = runtime.snapshot().queue?.drafts[0];
    if (!draft) throw new Error('Expected queued draft');
    draft.composerStaffProfileId = 'staff-2';
    // The tamper happens in browser storage, which every write now re-reads.
    await writePosState(driver, runtime.snapshot());

    await runtime.renewComposerProof('staff-2', async (originalProof) => {
      expect(originalProof).toBe('signed-composer-proof');
      return null; // The server rejects A's signed proof while B is active.
    });

    expect(draft.composerProof).toBe('signed-composer-proof');
    expect(runtime.snapshot().queue?.drafts[0]).toMatchObject({
      composerStaffProfileId: 'staff-2',
      composerProof: 'signed-composer-proof',
    });
    expect((await runtime.replay('staff-2', async () => ({ status: 403 }))).state).toBe('PAUSED');
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

describe('PosOfflineRuntime across tabs of one terminal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const draftB = {
    ...input,
    lines: [{ menuItemId: 'menu-item-2', quantity: 2, quotedUnitPrice: '6.00' }],
  };

  const catalogPayload = {
    publicationId: 'publication-2',
    branchId: scope.branchId,
    channel: 'DINE_IN',
    channelOpen: true,
    version: 'catalog-2',
    menu: { id: 'menu-1', name: 'All day' },
    sections: [],
  };

  async function persistedDrafts(driver: ReturnType<typeof createMemoryDriver>) {
    const read = await readPosState<PosQueueSnapshot>(driver, scope);
    if (read.status !== 'ok') throw new Error(`expected a persisted record, got ${read.status}`);
    return read.state.queue?.drafts ?? [];
  }

  function itemsOf(drafts: PosQueueSnapshot['drafts']) {
    return drafts.map((draft) =>
      draft.commands.flatMap((command) =>
        command.kind === 'ADD_ITEM' ? [command.body.menuItemId] : []
      )
    );
  }

  it('keeps both drafts when two hydrated tabs save one after the other', async () => {
    const driver = createMemoryDriver();
    const tabA = new PosOfflineRuntime(scope, driver);
    const tabB = new PosOfflineRuntime(scope, driver);
    expect(await tabA.hydrate()).toBe('ready');
    expect(await tabB.hydrate()).toBe('ready');

    const savedA = await tabA.enqueue(input);
    const savedB = await tabB.enqueue(draftB);
    expect(savedA.ok && savedB.ok).toBe(true);

    const reloaded = new PosOfflineRuntime(scope, driver);
    expect(await reloaded.hydrate()).toBe('ready');
    const drafts = reloaded.snapshot().queue!.drafts;
    expect(drafts).toHaveLength(2);
    expect(itemsOf(drafts)).toEqual([['menu-item-1'], ['menu-item-2']]);
    expect(new Set(drafts.map((draft) => draft.sequence)).size).toBe(2);
    // The second tab's view now includes the first tab's draft too.
    expect(tabB.snapshot().queue!.drafts).toHaveLength(2);
  });

  it('keeps every draft when tabs save concurrently', async () => {
    const driver = createMemoryDriver();
    const tabs = [0, 1, 2].map(() => new PosOfflineRuntime(scope, driver));
    await Promise.all(tabs.map((tab) => tab.hydrate()));

    const results = await Promise.all([
      tabs[0].enqueue(input),
      tabs[1].enqueue(draftB),
      tabs[2].enqueue(input),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    const drafts = await persistedDrafts(driver);
    expect(drafts).toHaveLength(3);
    expect(new Set(drafts.map((draft) => draft.draftId)).size).toBe(3);
  });

  it('does not let a stale tab catalog refresh roll back newer queue state', async () => {
    const driver = createMemoryDriver();
    const stale = new PosOfflineRuntime(scope, driver);
    const writer = new PosOfflineRuntime(scope, driver);
    await stale.hydrate();
    await writer.hydrate();

    await writer.enqueue(input);
    await stale.cacheCatalog(catalogPayload, '2026-11-15T00:00:00.000Z');

    const read = await readPosState<PosQueueSnapshot>(driver, scope);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.state.catalog?.version).toBe('catalog-2');
    expect(read.state.queue?.drafts).toHaveLength(1);
  });

  it('keeps a draft saved in another tab while this tab replays', async () => {
    const driver = createMemoryDriver();
    const replaying = new PosOfflineRuntime(scope, driver);
    const other = new PosOfflineRuntime(scope, driver);
    await replaying.hydrate();
    await other.hydrate();
    await replaying.enqueue(input);

    let savedDuringReplay = false;
    const result = await replaying.replay('staff-1', async (request) => {
      if (!savedDuringReplay) {
        savedDuringReplay = true;
        expect((await other.enqueue(draftB)).ok).toBe(true);
      }
      return { status: 201, serverRef: request.path.endsWith('/open') ? 'order-1' : 'item-1' };
    });
    expect(result.state).toBe('IDLE');

    const drafts = await persistedDrafts(driver);
    expect(drafts).toHaveLength(2);
    expect(drafts.every((draft) => draft.status === 'COMPLETED')).toBe(true);
    expect(itemsOf(drafts)).toEqual([['menu-item-1'], ['menu-item-2']]);
  });

  it('serializes every write under one cross-tab lock per terminal scope', async () => {
    const names: string[] = [];
    const recordingLock = <T>(name: string, run: () => Promise<T>) => {
      names.push(name);
      return withTerminalScopeLock(name, run);
    };
    const runtime = new PosOfflineRuntime(scope, createMemoryDriver(), recordingLock);
    await runtime.hydrate();
    await runtime.enqueue(input);
    await runtime.cacheCatalog(catalogPayload, '2026-11-15T00:00:00.000Z');
    await runtime.resume();
    await runtime.replay('staff-1', async () => ({ status: 201, serverRef: 'ref' }));

    const stateLock = `devfathom-pos:${posScopeKey(scope)}`;
    expect(new Set(names)).toEqual(new Set([stateLock, `${stateLock}:replay`]));
    expect(names.filter((name) => name === stateLock).length).toBeGreaterThanOrEqual(4);
  });

  it('uses the Web Locks API so the lock spans browser tabs', async () => {
    const request = vi.fn(
      async (_name: string, _options: { mode: string }, run: () => Promise<unknown>) => run()
    );
    vi.stubGlobal('navigator', { locks: { request } });

    const runtime = new PosOfflineRuntime(scope, createMemoryDriver());
    expect((await runtime.enqueue(input)).ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      `devfathom-pos:${posScopeKey(scope)}`,
      { mode: 'exclusive' },
      expect.any(Function)
    );
  });

  it('reports a failed save instead of overwriting a record it can no longer read', async () => {
    const driver = createMemoryDriver();
    const tabA = new PosOfflineRuntime(scope, driver);
    await tabA.hydrate();
    await tabA.enqueue(input);
    await driver.write(posScopeKey(scope), { schemaVersion: 99 });

    await expect(tabA.enqueue(draftB)).rejects.toThrow(/another tab/);
    expect(await driver.read(posScopeKey(scope))).toEqual({ schemaVersion: 99 });
  });

  it('stays revoked after the record is purged instead of accepting new work', async () => {
    const driver = createMemoryDriver();
    const runtime = new PosOfflineRuntime(scope, driver);
    await runtime.enqueue(input);
    await runtime.replay('staff-1', async () => ({
      status: 403,
      serverMessage: 'This device has been revoked.',
    }));

    const refused = await runtime.enqueue(draftB);
    expect(refused).toMatchObject({ ok: false, reason: 'DEVICE_REVOKED' });
    expect(await driver.read(posScopeKey(scope))).toBeUndefined();
  });
});
