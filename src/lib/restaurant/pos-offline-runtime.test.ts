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
      await reloaded.resolveReview(
        legacy.draftId,
        'REPLAY',
        reloaded.snapshot().queue!.drafts[0].review
      );
      expect(reloaded.snapshot().queue!.drafts[0].status).toBe('QUARANTINED');
      let sent = 0;
      await reloaded.replay('staff-1', async (request) => {
        expect(request.headers['X-POS-Composer-Proof']).toBe(input.composerProof);
        sent++;
        return { status: 201, serverRef: 'server-ref' };
      });
      expect(sent).toBe(2); // Only the signed draft's open/add commands.
      expect(reloaded.snapshot().queue!.drafts[1].status).toBe('COMPLETED');
      await reloaded.resolveReview(
        legacy.draftId,
        'DISCARD',
        reloaded.snapshot().queue!.drafts[0].review
      );
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

  it.each(['reason', 'command ID'] as const)(
    'keeps a newer review when a stale tab approves a different %s, then accepts the displayed review',
    async (changedField) => {
      const driver = createMemoryDriver();
      const tabA = new PosOfflineRuntime(scope, driver);
      let pauseWrite = false;
      let releaseWrite!: () => void;
      let writerEntered!: () => void;
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const writerReady = new Promise<void>((resolve) => {
        writerEntered = resolve;
      });
      const tabB = new PosOfflineRuntime(scope, driver, (name, run) =>
        withTerminalScopeLock(name, async () => {
          if (pauseWrite) {
            pauseWrite = false;
            writerEntered();
            await writeGate;
          }
          return run();
        })
      );
      await tabA.hydrate();
      await tabB.hydrate();
      await tabA.enqueue({ ...input, lines: [...input.lines, ...draftB.lines] });
      const catalog = (price1: string, available1: boolean, price2: string) => ({
        ...catalogPayload,
        publicationId: input.open.publicationId,
        channel: input.open.channel,
        sections: [
          {
            id: 'section-1',
            name: 'Menu',
            sortOrder: 1,
            items: [
              {
                id: 'menu-item-1',
                displayName: 'First item',
                price: price1,
                available: available1,
              },
              { id: 'menu-item-2', displayName: 'Second item', price: price2, available: true },
            ].map((item) => ({
              ...item,
              productId: item.id,
              product: { name: item.displayName },
              sortOrder: 1,
              priceSource: 'BASE_LIST',
              modifierGroups: [],
            })),
          },
        ],
      });
      await tabA.cacheCatalog(catalog('5.00', true, '6.00'), '2026-11-17T00:00:00.000Z');
      const displayed = tabA.snapshot().queue!.drafts[0];
      expect(displayed.review?.reason).toBe('PRICE_CHANGED');

      pauseWrite = true;
      const updating = tabB.cacheCatalog(
        changedField === 'reason' ? catalog('5.00', false, '6.00') : catalog('4.00', true, '7.00'),
        '2026-11-17T00:01:00.000Z'
      );
      await writerReady;
      // The click arrives while B holds the lock: compare only after B commits.
      const approving = tabA.resolveReview(displayed.draftId, 'REPLAY', displayed.review);
      releaseWrite();
      await updating;
      const current = tabB.snapshot().queue!.drafts[0];
      expect(current.review).not.toEqual(displayed.review);
      if (changedField === 'reason') {
        expect(current.review?.atCommandId).toBe(displayed.review?.atCommandId);
        expect(current.review?.reason).toBe('ITEM_UNAVAILABLE');
      } else {
        expect(current.review?.reason).toBe(displayed.review?.reason);
        expect(current.review?.atCommandId).not.toBe(displayed.review?.atCommandId);
      }

      await approving;
      expect(tabA.snapshot().queue!.drafts[0]).toEqual(current);
      expect(await persistedDrafts(driver)).toEqual([current]);
      const send = vi.fn(async () => ({ status: 201, serverRef: 'server-ref' }));
      expect((await tabA.replay('staff-1', send)).state).toBe('IDLE');
      expect(send).not.toHaveBeenCalled();

      const reloaded = new PosOfflineRuntime(scope, driver);
      await reloaded.hydrate();
      expect(reloaded.snapshot().queue!.drafts[0]).toEqual(current);
      // A fresh click on the now-displayed conflict is still allowed to send.
      await tabA.resolveReview(current.draftId, 'REPLAY', { ...current.review! });
      expect(tabA.snapshot().queue!.drafts[0].status).toBe('QUEUED');
      await tabA.replay('staff-1', send);
      expect(send).toHaveBeenCalledTimes(3);
      expect((await persistedDrafts(driver))[0].status).toBe('COMPLETED');
      tabA.close();
      tabB.close();
      reloaded.close();
    }
  );

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

describe('persisted server review creation', () => {
  const menu = (price = '4.00') => ({
    version: 'same-version',
    branchId: scope.branchId,
    channel: input.open.channel,
    publicationId: input.open.publicationId,
    channelOpen: true,
    menu: { id: 'menu-1', name: 'All day' },
    sections: [
      {
        id: 'section-1',
        name: 'Drinks',
        sortOrder: 1,
        items: [
          {
            id: 'menu-item-1',
            productId: 'product-1',
            variantId: null,
            displayName: 'Coffee',
            modifierGroups: [],
            product: { name: 'Coffee' },
            price,
            available: true,
            priceSource: 'BASE_LIST',
            sortOrder: 1,
          },
        ],
      },
    ],
  });

  it('persists the 409 identity, survives reload/menu refresh, then approves once', async () => {
    const driver = createMemoryDriver();
    const tabA = new PosOfflineRuntime(scope, driver);
    await tabA.cacheCatalog(menu(), '2026-11-17T00:00:00Z');
    await tabA.enqueue(input);
    let calls = 0;
    const send = vi.fn(async () =>
      ++calls === 1 ? { status: 201, serverRef: 'order-1' } : { status: 409 }
    );
    await tabA.replay('staff-1', send);
    expect(send).toHaveBeenCalledTimes(2);
    const displayed = tabA.snapshot().queue!.drafts[0];
    expect(displayed.review?.catalog?.line).toMatchObject({
      name: 'Coffee',
      currentPrice: '4.00',
      quotedPrice: '4.00',
    });
    const tabB = new PosOfflineRuntime(scope, driver);
    await tabB.hydrate();
    await tabB.cacheCatalog(menu(), '2026-11-17T01:00:00Z');
    expect(tabB.snapshot().queue!.drafts[0]).toEqual(displayed);
    expect(await tabB.resolveReview(displayed.draftId, 'REPLAY', displayed.review)).toBe('APPLIED');
    const retry = vi.fn(async () => ({ status: 201, serverRef: 'item-1' }));
    await tabB.replay('staff-1', retry);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(tabB.snapshot().queue!.drafts[0].status).toBe('COMPLETED');
  });

  it('captures fresh values when another tab changes the catalog during the HTTP request', async () => {
    const driver = createMemoryDriver();
    const tabA = new PosOfflineRuntime(scope, driver);
    const tabB = new PosOfflineRuntime(scope, driver);
    await tabA.cacheCatalog(menu(), '2026-11-17T00:00:00Z');
    await tabA.enqueue(input);
    let calls = 0;
    await tabA.replay('staff-1', async () => {
      if (++calls === 1) return { status: 201, serverRef: 'order-1' };
      await tabB.cacheCatalog(menu('5.00'), '2026-11-17T01:00:00Z');
      return { status: 409 };
    });
    const displayed = tabA.snapshot().queue!.drafts[0];
    expect(displayed.review?.catalog?.line?.currentPrice).toBe('5.00');
    await tabB.cacheCatalog(menu('7.00'), '2026-11-17T02:00:00Z');
    expect(await tabA.resolveReview(displayed.draftId, 'REPLAY', displayed.review)).toBe('STALE');
    expect(tabA.snapshot().queue!.drafts[0].commands).toEqual(displayed.commands);
    const send = vi.fn(async () => ({ status: 201, serverRef: 'item-1' }));
    await tabA.replay('staff-1', send);
    expect(send).not.toHaveBeenCalled();
    const fresh = tabA.snapshot().queue!.drafts[0];
    expect(await tabA.resolveReview(fresh.draftId, 'REPLAY', fresh.review)).toBe('APPLIED');
    await tabA.replay('staff-1', send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])(
    'returns successive foreign publications to original scope (cached=%s)',
    async (cached) => {
      const driver = createMemoryDriver();
      const tabA = new PosOfflineRuntime(scope, driver);
      const tabB = new PosOfflineRuntime(scope, driver);
      await tabA.hydrate();
      if (cached) await tabA.cacheCatalog(menu(), '2026-11-17T00:00:00Z');
      await tabA.enqueue(input);
      await tabA.cacheCatalog(
        { ...menu('5.00'), publicationId: 'foreign-2' },
        '2026-11-17T01:00:00Z'
      );
      const displayed = tabA.snapshot().queue!.drafts[0];
      await tabB.cacheCatalog(
        { ...menu('5.00'), publicationId: 'foreign-3' },
        '2026-11-17T02:00:00Z'
      );
      expect(await tabA.resolveReview(displayed.draftId, 'REPLAY', displayed.review)).toBe(
        cached ? 'STALE' : 'CATALOG_REQUIRED'
      );
      const send = vi.fn(async () => ({ status: 201, serverRef: 'ref' }));
      await tabA.resume();
      await tabA.replay('staff-1', send);
      expect(send).not.toHaveBeenCalled();
      if (!cached) {
        await tabB.cacheCatalog(
          { ...menu('9.00'), publicationId: 'foreign-4' },
          '2026-11-17T03:00:00Z'
        );
        expect(await tabA.resolveReview(displayed.draftId, 'REPLAY', displayed.review)).toBe(
          'CATALOG_REQUIRED'
        );
        await tabA.replay('staff-1', send);
        expect(send).not.toHaveBeenCalled();
        await tabB.cacheCatalog(menu(), '2026-11-17T04:00:00Z');
      }
      await tabB.cacheCatalog(
        { ...menu('9.00'), publicationId: 'foreign-5' },
        '2026-11-17T05:00:00Z'
      );
      const reloaded = new PosOfflineRuntime(scope, driver);
      await reloaded.hydrate();
      const fresh = reloaded.snapshot().queue!.drafts[0];
      expect(fresh.status).toBe('NEEDS_REVIEW');
      expect(fresh.commands).toEqual(displayed.commands);
      expect(fresh.review?.catalog).toMatchObject({
        publicationId: input.open.publicationId,
        retainedOriginal: true,
        line: { currentPrice: '4.00', quotedPrice: '4.00' },
      });
      expect(reloaded.snapshot().queue!.reviewCatalogs).toHaveLength(2);
      expect(await reloaded.resolveReview(fresh.draftId, 'REPLAY', fresh.review)).toBe('APPLIED');
      await reloaded.replay('staff-1', send);
      expect(send).toHaveBeenCalledTimes(2);
      const completed = reloaded.snapshot().queue!.drafts[0];
      expect(completed.commands[0].body).toEqual(displayed.commands[0].body);
      expect(completed.commands[1].body).toMatchObject({ quotedUnitPrice: '4.00' });
      expect(completed.status).toBe('COMPLETED');
    }
  );

  it('requires a fresh approval if the retained original catalog itself changes', async () => {
    const driver = createMemoryDriver();
    const a = new PosOfflineRuntime(scope, driver);
    const b = new PosOfflineRuntime(scope, driver);
    await a.cacheCatalog(menu(), '2026-11-17T00:00:00Z');
    await a.enqueue(input);
    await a.cacheCatalog({ ...menu('5.00'), publicationId: 'foreign-2' }, '2026-11-17T01:00:00Z');
    const first = a.snapshot().queue!.drafts[0];
    await b.cacheCatalog({ ...menu('5.00'), publicationId: 'foreign-3' }, '2026-11-17T02:00:00Z');
    expect(await a.resolveReview(first.draftId, 'REPLAY', first.review)).toBe('STALE');
    const original = a.snapshot().queue!.drafts[0];
    await b.cacheCatalog(menu('7.00'), '2026-11-17T03:00:00Z');
    expect(await a.resolveReview(first.draftId, 'REPLAY', original.review)).toBe('STALE');
    expect(a.snapshot().queue!.drafts[0].commands).toEqual(first.commands);
    const fresh = a.snapshot().queue!.drafts[0];
    expect(fresh.review?.catalog?.line?.currentPrice).toBe('7.00');
    expect(await a.resolveReview(first.draftId, 'REPLAY', fresh.review)).toBe('APPLIED');
    expect(a.snapshot().queue!.drafts[0].commands[1].body).toMatchObject({
      quotedUnitPrice: '7.00',
    });
  });
  it('creates a new obligation when explicit retry receives another 409', async () => {
    const runtime = new PosOfflineRuntime(scope, createMemoryDriver());
    await runtime.cacheCatalog(menu(), '2026-11-17T00:00:00Z');
    await runtime.enqueue(input);
    let calls = 0;
    const send = vi.fn(async () =>
      ++calls === 1 ? { status: 201, serverRef: 'order' } : { status: 409 }
    );
    await runtime.replay('staff-1', send);
    for (let attempt = 0; attempt < 2; attempt++) {
      await runtime.cacheCatalog(menu('5.00'), '2026-11-17T01:00:00Z');
      await runtime.cacheCatalog(menu(), '2026-11-17T02:00:00Z');
      await runtime.resume();
      const count = send.mock.calls.length;
      await runtime.replay('staff-1', send);
      expect(send).toHaveBeenCalledTimes(count);
      const displayed = runtime.snapshot().queue!.drafts[0];
      expect(displayed.status).toBe('NEEDS_REVIEW');
      expect(await runtime.resolveReview(displayed.draftId, 'REPLAY', displayed.review)).toBe(
        'APPLIED'
      );
      await runtime.replay('staff-1', send);
      expect(send).toHaveBeenCalledTimes(count + 1);
      expect(runtime.snapshot().queue!.drafts[0].serverReview?.reason).toBe('CATALOG_CONFLICT');
    }
  });
  async function restorationPair() {
    const driver = createMemoryDriver();
    const a = new PosOfflineRuntime(scope, driver);
    const b = new PosOfflineRuntime(scope, driver);
    await a.enqueue(input);
    await a.cacheCatalog({ ...menu('5.00'), publicationId: 'foreign-2' }, '2026-11-17T00:00:00Z');
    const displayed = a.snapshot().queue!.drafts[0];
    await b.cacheCatalog({ ...menu('5.00'), publicationId: 'foreign-3' }, '2026-11-17T01:00:00Z');
    expect(await a.resolveReview(displayed.draftId, 'REPLAY', displayed.review)).toBe(
      'CATALOG_REQUIRED'
    );
    return { a, b, driver, draftId: displayed.draftId };
  }

  function delayedMenu() {
    let release!: (value: ReturnType<typeof menu>) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<ReturnType<typeof menu>>((resolve) => {
      release = resolve;
    });
    return {
      ready,
      release: (value: ReturnType<typeof menu>) => release(value),
      fetch: () => {
        started();
        return response;
      },
    };
  }

  it('restores A without changing live scope or unrelated accepted B, including an enqueue during HTTP await', async () => {
    const { a, b, draftId } = await restorationPair();
    const pending = delayedMenu();
    const restoring = a.restoreReviewCatalog(draftId, pending.fetch);
    await pending.ready;
    await b.enqueue({
      ...input,
      open: { ...input.open, publicationId: 'foreign-3' },
      lines: [{ ...input.lines[0], quotedUnitPrice: '5.00' }],
    });
    const live = b.snapshot().catalog;
    const acceptedB = b.snapshot().queue!.drafts[1];
    pending.release(menu());
    expect(await restoring).not.toBeNull();
    expect(a.snapshot().catalog).toEqual(live);
    expect(a.snapshot().queue!.drafts[1]).toEqual(acceptedB);
    const send = vi.fn(async () => ({ status: 201, serverRef: 'B-ref' }));
    await b.replay('staff-1', send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(b.snapshot().queue!.drafts[0].status).toBe('NEEDS_REVIEW');
    expect(b.snapshot().queue!.drafts[1].status).toBe('COMPLETED');
  });

  it.each(['old-first', 'new-first'] as const)(
    'keeps the latest-started original request when responses finish %s',
    async (order) => {
      const { a, b, driver, draftId } = await restorationPair();
      const old = delayedMenu();
      const fresh = delayedMenu();
      const first = a.restoreReviewCatalog(draftId, old.fetch);
      await old.ready;
      const second = b.restoreReviewCatalog(draftId, fresh.fetch);
      await fresh.ready;
      if (order === 'old-first') {
        old.release(menu());
        expect(await first).toBeNull();
      }
      fresh.release(menu('7.00'));
      expect(await second).not.toBeNull();
      if (order === 'new-first') {
        old.release(menu());
        expect(await first).toBeNull();
      }
      await a.refresh();
      expect(a.snapshot().catalog?.publicationId).toBe('foreign-3');
      expect(a.snapshot().queue!.drafts[0].review?.catalog?.line?.currentPrice).toBe('7.00');
      expect(a.snapshot().queue!.drafts[0].commands[1].body).toMatchObject({
        quotedUnitPrice: '4.00',
      });
      const reloaded = new PosOfflineRuntime(scope, driver);
      await reloaded.hydrate();
      const review = reloaded.snapshot().queue!.drafts[0];
      expect(review.review?.catalog?.line?.currentPrice).toBe('7.00');
      expect(await reloaded.resolveReview(draftId, 'REPLAY', review.review)).toBe('APPLIED');
      expect(reloaded.snapshot().queue!.drafts[0].commands[1].body).toMatchObject({
        quotedUnitPrice: '7.00',
      });
    }
  );

  it.each(['7.00', '4.00'])(
    'rejects a response after an intervening live write, including ABA to %s',
    async (price) => {
      const { a, b, draftId } = await restorationPair();
      const pending = delayedMenu();
      const restoring = a.restoreReviewCatalog(draftId, pending.fetch);
      await pending.ready;
      await b.cacheCatalog(menu('7.00'), '2026-11-17T02:00:00Z');
      if (price === '4.00') await b.cacheCatalog(menu(), '2026-11-17T03:00:00Z');
      pending.release(menu('9.00'));
      expect(await restoring).toBeNull();
      expect(a.snapshot().catalog?.sections[0].items[0].price).toBe(price);
      expect(a.snapshot().queue!.drafts[0].review?.catalog?.line?.currentPrice).toBe(price);
      const send = vi.fn(async () => ({ status: 201 }));
      await a.replay('staff-1', send);
      expect(send).not.toHaveBeenCalled();
    }
  );

  it.each(['old-first', 'new-first'] as const)(
    'guards live menu requests too, with %s completion',
    async (order) => {
      const { a, b } = await restorationPair();
      const old = delayedMenu();
      const fresh = delayedMenu();
      const first = a.fetchLiveCatalog(input.open.channel, old.fetch);
      await old.ready;
      const second = b.fetchLiveCatalog(input.open.channel, fresh.fetch);
      await fresh.ready;
      if (order === 'old-first') {
        old.release(menu());
        expect(await first).toBeNull();
      }
      fresh.release(menu('7.00'));
      expect(await second).not.toBeNull();
      if (order === 'new-first') {
        old.release(menu());
        expect(await first).toBeNull();
      }
      await a.refresh();
      expect(a.snapshot().catalog?.sections[0].items[0].price).toBe('7.00');
    }
  );

  it.each(['branch', 'channel', 'publication'] as const)(
    'refuses an original response for the wrong %s',
    async (field) => {
      const { a, draftId } = await restorationPair();
      const live = a.snapshot().catalog;
      const wrong = {
        ...menu(),
        ...(field === 'branch'
          ? { branchId: 'other-branch' }
          : field === 'channel'
            ? { channel: 'DINE_IN' }
            : { publicationId: 'other-publication' }),
      };
      await expect(a.restoreReviewCatalog(draftId, async () => wrong)).rejects.toThrow(
        /branch|scope/
      );
      expect(a.snapshot().catalog).toEqual(live);
      expect(a.snapshot().queue!.drafts[0].status).toBe('NEEDS_REVIEW');
    }
  );

  it('retains the obligation after fetch failure and an unrelated catalog write, then accepts a fresh retry', async () => {
    const { a, b, driver, draftId } = await restorationPair();
    await expect(
      a.restoreReviewCatalog(draftId, async () => {
        throw new Error('Menu unavailable');
      })
    ).rejects.toThrow('Menu unavailable');
    const pending = delayedMenu();
    const restoring = a.restoreReviewCatalog(draftId, pending.fetch);
    await pending.ready;
    await b.cacheCatalog({ ...menu('6.00'), publicationId: 'foreign-4' }, '2026-11-17T03:00:00Z');
    pending.release(menu());
    expect(await restoring).toBeNull();
    const reloaded = new PosOfflineRuntime(scope, driver);
    await reloaded.hydrate();
    expect(reloaded.snapshot().queue!.drafts[0].status).toBe('NEEDS_REVIEW');
    expect(await reloaded.restoreReviewCatalog(draftId, async () => menu())).not.toBeNull();
    expect(reloaded.snapshot().catalog?.publicationId).toBe('foreign-4');
    const displayed = reloaded.snapshot().queue!.drafts[0];
    expect(await reloaded.resolveReview(draftId, 'REPLAY', displayed.review)).toBe('APPLIED');
  });
  it.each(['old-first', 'new-first'] as const)(
    'a newer live fetch supersedes an original fetch even across request paths: %s',
    async (order) => {
      const { a, b, draftId } = await restorationPair();
      const old = delayedMenu();
      const fresh = delayedMenu();
      const first = a.restoreReviewCatalog(draftId, old.fetch);
      await old.ready;
      const second = b.fetchLiveCatalog(input.open.channel, fresh.fetch);
      await fresh.ready;
      if (order === 'old-first') {
        old.release(menu());
        expect(await first).toBeNull();
      }
      fresh.release(menu('7.00'));
      expect(await second).not.toBeNull();
      if (order === 'new-first') {
        old.release(menu());
        expect(await first).toBeNull();
      }
      await a.refresh();
      expect(a.snapshot().catalog?.sections[0].items[0].price).toBe('7.00');
      expect(a.snapshot().queue!.drafts[0].review?.catalog?.line?.currentPrice).toBe('7.00');
      expect(a.snapshot().queue!.drafts[0].commands[1].body).toMatchObject({
        quotedUnitPrice: '4.00',
      });
      const send = vi.fn(async () => ({ status: 201 }));
      await a.replay('staff-1', send);
      expect(send).not.toHaveBeenCalled();
    }
  );
});
