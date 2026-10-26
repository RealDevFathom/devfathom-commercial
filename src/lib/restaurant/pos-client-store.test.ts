/**
 * M9-L1 — the POS client-store battery (acceptance criterion 2).
 *
 * Everything here runs without a browser: jsdom ships no IndexedDB and M9 authorizes
 * no new dependency, so the native driver is exercised against a minimal fake
 * `IDBFactory` written in this file, and the rest of the store is exercised through
 * the in-memory driver the seam already exposes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CATALOG_REFRESH_INTERVAL_MS,
  POS_STORE_OBJECT_STORE,
  POS_STORE_SCHEMA_VERSION,
  PosStorageError,
  assertPersistSafe,
  createIndexedDbDriver,
  createMemoryDriver,
  emptyPosState,
  findCatalogItem,
  findForbiddenPersistPath,
  isForbiddenPersistKey,
  isPosStoreSupported,
  posScopeKey,
  purgePosScope,
  readPosState,
  sanitizeCatalogSnapshot,
  shouldRefreshCatalog,
  writePosState,
  type PosScope,
  type PosStorageDriver,
} from './pos-client-store';

const scope: PosScope = { organizationId: 'org-1', branchId: 'branch-1', deviceId: 'device-1' };

/** A response shaped exactly like `GET /api/restaurant/orders/effective-menu`. */
function effectiveMenuResponse(overrides: { price?: string; available?: boolean } = {}) {
  return {
    publicationId: 'pub-1',
    branchId: 'branch-1',
    channel: 'DINE_IN',
    channelOpen: true,
    version: 'v1:aaaa',
    menu: { id: 'menu-1', name: 'All day', nameLocalized: { ur: 'سارا دن' } },
    sections: [
      {
        id: 'sec-1',
        name: 'Grill',
        nameLocalized: { ur: 'گرل' },
        sortOrder: 1,
        items: [
          {
            id: 'mi-1',
            productId: 'prod-1',
            variantId: null,
            displayName: 'Seekh Kebab',
            nameLocalized: { ur: 'سیخ کباب' },
            sortOrder: 1,
            product: {
              id: 'prod-1',
              name: 'Seekh Kebab',
              type: 'FOOD',
              status: 'ACTIVE',
              nameLocalized: null,
              descriptionLocalized: { ur: 'تفصیل' },
            },
            variant: null,
            modifierGroups: [
              {
                id: 'group-1',
                name: 'Heat',
                minSelect: 0,
                maxSelect: 1,
                internalNote: 'must not persist',
                options: [
                  {
                    id: 'option-1',
                    name: 'Spicy',
                    priceDelta: '1.50',
                    costPrice: '0.25',
                  },
                ],
              },
            ],
            price: overrides.price ?? '450.00',
            priceSource: 'PUBLICATION_LIST',
            available: overrides.available ?? true,
          },
        ],
      },
    ],
  };
}

const snapshotOf = (overrides?: { price?: string; available?: boolean }, version = 'v1:aaaa') =>
  sanitizeCatalogSnapshot(effectiveMenuResponse(overrides), {
    version,
    fetchedAtClient: '2026-08-27T10:00:00.000Z',
  });

// ── A minimal fake IndexedDB (no dependency added) ───────────────────────────

type Handler = (() => void) | null;

function createFakeIndexedDb() {
  const data = new Map<string, Map<string, unknown>>();
  let openCount = 0;
  let writeTail = Promise.resolve();

  function makeRequest() {
    return {
      result: undefined as unknown,
      error: null as unknown,
      onsuccess: null as Handler,
      onerror: null as Handler,
      onupgradeneeded: null as Handler,
      onblocked: null as Handler,
    };
  }

  function makeTransaction(storeName: string, mode: IDBTransactionMode = 'readonly') {
    let pending = 0;
    let aborted = false;
    let releaseWrite: (() => void) | undefined;
    const ready = mode === 'readwrite' ? writeTail : Promise.resolve();
    if (mode === 'readwrite') {
      writeTail = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    }
    const tx = {
      error: null as unknown,
      oncomplete: null as Handler,
      onabort: null as Handler,
      onerror: null as Handler,
      objectStore: () => store,
      abort: () => {
        aborted = true;
        releaseWrite?.();
        setTimeout(() => tx.onabort?.(), 0);
      },
    };

    const run = <T>(work: () => T) => {
      const request = makeRequest();
      pending += 1;
      void ready.then(() =>
        setTimeout(() => {
          if (aborted) return;
          try {
            request.result = work();
            request.onsuccess?.();
          } catch (err) {
            request.error = err;
            request.onerror?.();
          }
          pending -= 1;
          if (pending === 0) {
            setTimeout(() => {
              if (aborted) return;
              releaseWrite?.();
              tx.oncomplete?.();
            }, 0);
          }
        }, 0)
      );
      return request;
    };

    const rows = () => {
      const found = data.get(storeName);
      if (!found) throw new Error(`Unknown object store ${storeName}`);
      return found;
    };

    const store = {
      get: (key: string) => run(() => rows().get(key)),
      put: (value: unknown, key: string) =>
        run(() => {
          rows().set(key, JSON.parse(JSON.stringify(value)));
          return key;
        }),
      delete: (key: string) =>
        run(() => {
          rows().delete(key);
          return undefined;
        }),
    };
    return tx;
  }

  const factory = {
    open: () => {
      const request = makeRequest();
      openCount += 1;
      const db = {
        objectStoreNames: { contains: (name: string) => data.has(name) },
        createObjectStore: (name: string) => {
          data.set(name, new Map());
          return {};
        },
        transaction: (name: string, mode?: IDBTransactionMode) => makeTransaction(name, mode),
        close: () => undefined,
      };
      request.result = db;
      setTimeout(() => {
        if (!data.has(POS_STORE_OBJECT_STORE)) request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };

  return { factory: factory as unknown as IDBFactory, data, openCount: () => openCount };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Scope partitioning ───────────────────────────────────────────────────────

describe('scope partitioning (criterion 2)', () => {
  it('keys a document by organization, branch and device', () => {
    expect(posScopeKey(scope)).toBe('org-1::branch-1::device-1');
    expect(posScopeKey({ ...scope, deviceId: 'device-2' })).not.toBe(posScopeKey(scope));
  });

  it('refuses an empty or separator-bearing scope id', () => {
    expect(() => posScopeKey({ ...scope, branchId: '' })).toThrow(PosStorageError);
    expect(() => posScopeKey({ ...scope, branchId: 'a::b' })).toThrow(PosStorageError);
  });

  it('reads as unrecoverable rather than inheriting another terminal state', async () => {
    const driver = createMemoryDriver();
    await writePosState(driver, { ...emptyPosState(scope), catalog: snapshotOf() });

    // Same key, foreign scope body — the only way this happens is corruption.
    await driver.write(posScopeKey(scope), {
      schemaVersion: POS_STORE_SCHEMA_VERSION,
      scope: { ...scope, deviceId: 'device-9' },
      catalog: null,
      queue: null,
    });

    const read = await readPosState(driver, scope);
    expect(read.status).toBe('unrecoverable');
    if (read.status === 'unrecoverable') expect(read.reason).toBe('SCOPE_MISMATCH');
  });
});

// ── Storage minimization ─────────────────────────────────────────────────────

describe('storage minimization (criterion 2)', () => {
  it('denylists every forbidden family regardless of casing or separators', () => {
    for (const key of [
      'deviceSecret',
      'enrollment_secret',
      'SESSION-TOKEN',
      'sessionToken',
      'pin',
      'pinHash',
      'managerPin',
      'operator_pin',
      'APPROVING-PIN',
      'customerId',
      'customerName',
      'loyaltyAccountId',
      'loyaltyBalance',
      'tenderAmount',
      'paymentMethod',
      'cardNumber',
      'cardholderName',
      'cvv',
      'email',
      'phoneNumber',
      'authorization',
      'pointsBalance',
    ]) {
      expect(isForbiddenPersistKey(key), key).toBe(true);
    }
  });

  it('leaves the fields the terminal legitimately needs alone', () => {
    for (const key of [
      'menuItemId',
      'productId',
      'deviceId',
      'branchId',
      'organizationId',
      'publicationId',
      'idempotencyKey',
      'commandId',
      'quantity',
      'price',
      'priceSource',
      'available',
      'sortOrder',
      'sequence',
      'channelOpen',
    ]) {
      expect(isForbiddenPersistKey(key), key).toBe(false);
    }
  });

  it('reports the nested path of the first forbidden key without echoing its value', () => {
    const found = findForbiddenPersistPath({
      queue: { drafts: [{ operator: { pin: '4821' } }] },
    });
    expect(found).toEqual({ reason: 'FORBIDDEN_FIELD', path: 'queue.drafts[0].operator.pin' });
  });

  it('refuses non-JSON values and cycles, and allows a value shared twice in a tree', () => {
    expect(findForbiddenPersistPath({ at: new Date() })?.reason).toBe('UNSUPPORTED_VALUE');
    expect(findForbiddenPersistPath({ fn: () => 1 })?.reason).toBe('UNSUPPORTED_VALUE');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(findForbiddenPersistPath(cyclic)?.reason).toBe('CYCLE');
    const shared = { id: 'x' };
    expect(findForbiddenPersistPath({ a: shared, b: shared })).toBeNull();
  });

  it('never lets a contaminated document reach the storage adapter', async () => {
    const driver = createMemoryDriver();
    const write = vi.spyOn(driver, 'write');

    for (const contaminated of [
      { deviceSecret: 'dvs_live_abcdef' },
      { session: { sessionToken: 'tst_abc' } },
      { operator: { pin: '1234' } },
      { customer: { id: 'cus-1', name: 'A Person' } },
      { loyaltyBalance: '250.00' },
      { walletAlias: `wla_${'0'.repeat(26)}` },
      { wallet: { alias: `wla_${'1'.repeat(26)}` } },
      { tenders: [{ amount: '100.00' }] },
      { payment: { cardNumber: '4111111111111111' } },
    ]) {
      await expect(
        writePosState(driver, {
          ...emptyPosState<Record<string, unknown>>(scope),
          queue: contaminated as Record<string, unknown>,
        })
      ).rejects.toBeInstanceOf(PosStorageError);
    }
    expect(write).not.toHaveBeenCalled();
  });

  it('drops every field outside the catalog allowlist', () => {
    const snapshot = snapshotOf();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('nameLocalized');
    expect(serialized).not.toContain('descriptionLocalized');
    expect(serialized).not.toContain('ACTIVE'); // product.status is not persisted
    expect(snapshot.sections[0].items[0]).toEqual({
      menuItemId: 'mi-1',
      productId: 'prod-1',
      variantId: null,
      name: 'Seekh Kebab',
      sortOrder: 1,
      price: '450.00',
      priceSource: 'PUBLICATION_LIST',
      available: true,
      modifierGroups: [
        {
          id: 'group-1',
          name: 'Heat',
          minSelect: 0,
          maxSelect: 1,
          options: [{ id: 'option-1', name: 'Spicy', priceDelta: '1.50' }],
        },
      ],
    });
    expect(serialized).not.toContain('internalNote');
    expect(serialized).not.toContain('costPrice');
    expect(() => assertPersistSafe(snapshot)).not.toThrow();
  });

  it('refuses a malformed effective-menu payload instead of storing a partial catalog', () => {
    expect(() =>
      sanitizeCatalogSnapshot(
        { ...effectiveMenuResponse(), channel: 'DRIVE_THRU' },
        { version: 'v1:a', fetchedAtClient: '2026-08-27T10:00:00.000Z' }
      )
    ).toThrow(PosStorageError);
    expect(() =>
      sanitizeCatalogSnapshot(null, {
        version: 'v1:a',
        fetchedAtClient: '2026-08-27T10:00:00.000Z',
      })
    ).toThrow(PosStorageError);
  });
});

// ── Catalog persistence and restore ──────────────────────────────────────────

describe('versioned catalog cache (criterion 2)', () => {
  it('stores the catalog on unlock and restores it after a reload', async () => {
    const first = createMemoryDriver();
    await writePosState(first, { ...emptyPosState(scope), catalog: snapshotOf() });
    // Simulate the reload: a brand-new driver over the same persisted document.
    const raw = await first.read(posScopeKey(scope));
    const reloaded = createMemoryDriver([[posScopeKey(scope), raw]]);

    const read = await readPosState(reloaded, scope);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.state.catalog?.version).toBe('v1:aaaa');
    expect(read.state.catalog?.sections[0].items[0].price).toBe('450.00');
  });

  it('writes catalog, drafts and queue in ONE atomic put', async () => {
    const driver = createMemoryDriver();
    const write = vi.spyOn(driver, 'write');
    await writePosState(driver, {
      ...emptyPosState<{ drafts: string[] }>(scope),
      catalog: snapshotOf(),
      queue: { drafts: ['d1'] },
    });
    expect(write).toHaveBeenCalledTimes(1);
    const [, record] = write.mock.calls[0];
    expect(record).toMatchObject({ catalog: { version: 'v1:aaaa' }, queue: { drafts: ['d1'] } });
  });

  it('resolves one item tap from the cache with zero fetch calls', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const driver = createMemoryDriver();
    await writePosState(driver, { ...emptyPosState(scope), catalog: snapshotOf() });

    const read = await readPosState(driver, scope);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok' || !read.state.catalog) return;

    const tapped = findCatalogItem(read.state.catalog, 'mi-1');
    expect(tapped?.price).toBe('450.00');
    expect(findCatalogItem(read.state.catalog, 'mi-missing')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('fails closed on an unknown schema version and on a corrupt record', async () => {
    const driver = createMemoryDriver();
    await driver.write(posScopeKey(scope), {
      schemaVersion: 99,
      scope,
      catalog: null,
      queue: null,
    });
    const stale = await readPosState(driver, scope);
    expect(stale.status).toBe('unrecoverable');
    if (stale.status === 'unrecoverable') {
      expect(stale.reason).toBe('SCHEMA_VERSION');
      expect(stale.foundSchemaVersion).toBe(99);
    }

    await driver.write(posScopeKey(scope), ['not', 'a', 'record']);
    const corrupt = await readPosState(driver, scope);
    expect(corrupt.status).toBe('unrecoverable');
    if (corrupt.status === 'unrecoverable') expect(corrupt.reason).toBe('CORRUPT');
  });

  it('reports an unreadable store as unrecoverable rather than throwing at the caller', async () => {
    const driver: PosStorageDriver = {
      read: async () => {
        throw new Error('QuotaExceededError');
      },
      write: async () => undefined,
      remove: async () => undefined,
      close: () => undefined,
    };
    const read = await readPosState(driver, scope);
    expect(read.status).toBe('unrecoverable');
    if (read.status === 'unrecoverable') expect(read.reason).toBe('CORRUPT');
  });

  it('reads empty after a purge', async () => {
    const driver = createMemoryDriver();
    await writePosState(driver, { ...emptyPosState(scope), catalog: snapshotOf() });
    await purgePosScope(driver, scope);
    expect((await readPosState(driver, scope)).status).toBe('empty');
  });

  it('refuses to persist a foreign schema version', async () => {
    const driver = createMemoryDriver();
    await expect(
      writePosState(driver, { ...emptyPosState(scope), schemaVersion: 2 })
    ).rejects.toBeInstanceOf(PosStorageError);
  });
});

// ── Refresh policy ───────────────────────────────────────────────────────────

describe('catalog refresh policy (criterion 5)', () => {
  const base = { nowMs: 1_000_000, lastAttemptAtMs: 1_000_000, hasCatalog: true } as const;

  it('always refreshes on unlock, reconnect, online, visibility and manual', () => {
    for (const trigger of ['UNLOCK', 'RECONNECT', 'ONLINE', 'VISIBILITY', 'MANUAL'] as const) {
      expect(shouldRefreshCatalog({ ...base, trigger }), trigger).toBe(true);
    }
  });

  it('throttles the periodic tick to the 30-second cadence', () => {
    expect(shouldRefreshCatalog({ ...base, trigger: 'INTERVAL' })).toBe(false);
    expect(
      shouldRefreshCatalog({
        ...base,
        trigger: 'INTERVAL',
        nowMs: base.lastAttemptAtMs + CATALOG_REFRESH_INTERVAL_MS - 1,
      })
    ).toBe(false);
    expect(
      shouldRefreshCatalog({
        ...base,
        trigger: 'INTERVAL',
        nowMs: base.lastAttemptAtMs + CATALOG_REFRESH_INTERVAL_MS,
      })
    ).toBe(true);
  });

  it('always refreshes a terminal that holds no catalog at all', () => {
    expect(shouldRefreshCatalog({ ...base, trigger: 'INTERVAL', hasCatalog: false })).toBe(true);
    expect(shouldRefreshCatalog({ ...base, trigger: 'INTERVAL', lastAttemptAtMs: null })).toBe(
      true
    );
  });
});

// ── The native IndexedDB driver ──────────────────────────────────────────────

describe('native IndexedDB driver', () => {
  it('atomically allows only one concurrent compare-and-swap', async () => {
    const fake = createFakeIndexedDb();
    const first = createIndexedDbDriver(fake.factory);
    const second = createIndexedDbDriver(fake.factory);
    const key = posScopeKey(scope);
    const initial = { version: 1 };
    await first.write(key, initial);

    const results = await Promise.all([
      first.compareAndSwap(key, initial, { version: 2, writer: 'first' }),
      second.compareAndSwap(key, initial, { version: 2, writer: 'second' }),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(await first.read(key)).toMatchObject({ version: 2 });
    first.close();
    second.close();
  });

  it('round-trips, overwrites and removes a document through real IDB calls', async () => {
    const fake = createFakeIndexedDb();
    const driver = createIndexedDbDriver(fake.factory);

    expect(await driver.read(posScopeKey(scope))).toBeUndefined();

    await writePosState(driver, { ...emptyPosState(scope), catalog: snapshotOf() });
    const first = await readPosState(driver, scope);
    expect(first.status).toBe('ok');
    if (first.status === 'ok') expect(first.state.catalog?.version).toBe('v1:aaaa');

    await writePosState(driver, {
      ...emptyPosState(scope),
      catalog: snapshotOf({ price: '500.00' }, 'v1:bbbb'),
    });
    const second = await readPosState(driver, scope);
    if (second.status === 'ok') expect(second.state.catalog?.version).toBe('v1:bbbb');

    // The store holds exactly one document for this scope — no key sprawl.
    expect(fake.data.get(POS_STORE_OBJECT_STORE)?.size).toBe(1);

    await purgePosScope(driver, scope);
    expect((await readPosState(driver, scope)).status).toBe('empty');
    driver.close();
  });

  it('opens the database once and reuses it across operations', async () => {
    const fake = createFakeIndexedDb();
    const driver = createIndexedDbDriver(fake.factory);
    await driver.write('a', { schemaVersion: POS_STORE_SCHEMA_VERSION });
    await driver.read('a');
    await driver.remove('a');
    expect(fake.openCount()).toBe(1);
    driver.close();
  });

  it('refuses to construct where the browser exposes no IndexedDB', () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(isPosStoreSupported()).toBe(false);
    expect(() => createIndexedDbDriver(null)).toThrow(PosStorageError);
    try {
      createIndexedDbDriver(null);
    } catch (err) {
      expect((err as PosStorageError).reason).toBe('UNSUPPORTED_ENVIRONMENT');
    }
    vi.unstubAllGlobals();
  });
});
