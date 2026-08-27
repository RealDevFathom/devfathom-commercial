/**
 * M9-L1 — the POS terminal's client-side persistence seam.
 *
 * This module is CLIENT-SAFE on purpose: it never imports `server-only`, Prisma or
 * any terminal/auth helper, so bundling it into the POS page cannot drag a server
 * module across the boundary. It owns three things and nothing else:
 *
 *  1. **A native IndexedDB seam.** One tiny driver interface (`PosStorageDriver`)
 *     with a native `indexedDB` implementation and an in-memory implementation for
 *     tests/SSR. No service worker, PWA runtime, sync library or second database
 *     (M9 §3.4, §3.10) — jsdom ships no IndexedDB, so the seam is how the battery
 *     runs without adding a dependency.
 *  2. **A schema-versioned, scope-partitioned record.** Exactly one document per
 *     `organization + branch + device` (criterion 2). Catalog, drafts and queue live
 *     in that single document, so every write is one `put` inside one IndexedDB
 *     transaction — catalog/draft/queue writes are atomic by construction. An
 *     unknown schema version or a corrupt/foreign document FAILS CLOSED: the read
 *     reports `unrecoverable` and the caller shows recovery UI instead of guessing.
 *  3. **Storage minimization, enforced not documented.** Every write is walked by
 *     `assertPersistSafe`, which throws on a forbidden key (device/enrollment
 *     secrets, session tokens, operator/manager PINs, customer or loyalty fields,
 *     tender/payment/card values) and on any non-JSON value. The catalog is stored
 *     through an ALLOWLIST projection, so an added server field cannot leak in by
 *     default. Denylist + allowlist together are the audit proof for criterion 2.
 *
 * Client-origin time is persisted as metadata only; server time stays authoritative
 * and queue ordering uses a persisted sequence, never a clock (M9 amendment §2.3).
 */

/** Bump when the persisted document shape changes; an older/newer record fails closed. */
export const POS_STORE_SCHEMA_VERSION = 1;

export const POS_STORE_DATABASE_NAME = 'devfathom-pos';
export const POS_STORE_OBJECT_STORE = 'scope-state';

/** The catalog refresh cadence while the terminal is active (M9 §3.6). */
export const CATALOG_REFRESH_INTERVAL_MS = 30_000;

// ── Errors ───────────────────────────────────────────────────────────────────

export type PosStorageErrorReason =
  | 'FORBIDDEN_FIELD'
  | 'UNSUPPORTED_VALUE'
  | 'CYCLE'
  | 'INVALID_SCOPE'
  | 'SCOPE_MISMATCH'
  | 'SCHEMA_VERSION'
  | 'MALFORMED_CATALOG'
  | 'UNSUPPORTED_ENVIRONMENT';

/** A refused or impossible persistence attempt. Never carries the offending value —
 * only the key path — so an error report cannot itself leak a secret. */
export class PosStorageError extends Error {
  readonly reason: PosStorageErrorReason;
  readonly path: string | null;

  constructor(reason: PosStorageErrorReason, message: string, path: string | null = null) {
    super(message);
    this.name = 'PosStorageError';
    this.reason = reason;
    this.path = path;
  }
}

// ── Scope partitioning ───────────────────────────────────────────────────────

export type PosScope = {
  organizationId: string;
  branchId: string;
  deviceId: string;
};

const SCOPE_SEPARATOR = '::';

/**
 * The IndexedDB key for one terminal's document. Partitioning by organization,
 * branch AND device is what makes a re-enrolled or re-branched terminal read as
 * "empty" rather than inheriting another scope's catalog and drafts (criterion 2).
 */
export function posScopeKey(scope: PosScope): string {
  for (const [field, value] of Object.entries(scope)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new PosStorageError('INVALID_SCOPE', `Scope field ${field} must be a non-empty id.`);
    }
    if (value.includes(SCOPE_SEPARATOR)) {
      throw new PosStorageError(
        'INVALID_SCOPE',
        `Scope field ${field} must not contain "${SCOPE_SEPARATOR}".`
      );
    }
  }
  return [scope.organizationId, scope.branchId, scope.deviceId].join(SCOPE_SEPARATOR);
}

export function sameScope(a: PosScope, b: PosScope): boolean {
  return (
    a.organizationId === b.organizationId && a.branchId === b.branchId && a.deviceId === b.deviceId
  );
}

// ── Storage minimization (criterion 2) ───────────────────────────────────────

/**
 * Key stems that may never appear anywhere in a persisted document. Matched against
 * the key with case and separators removed, so `device_secret`, `deviceSecret` and
 * `DEVICE-SECRET` are all refused. Substring stems cover families (anything holding
 * a secret/token/credential, any customer or loyalty field, any card/tender/payment
 * value); the exact set covers short words that would false-positive as substrings.
 */
export const FORBIDDEN_PERSIST_KEY_STEMS: readonly string[] = [
  'secret',
  'token',
  'password',
  'passcode',
  'credential',
  'authorization',
  'customer',
  'loyalty',
  'cardholder',
  'cardnumber',
  'creditcard',
  'tender',
  'payment',
  'refund',
];

export const FORBIDDEN_PERSIST_KEYS: readonly string[] = [
  'pin',
  'pinhash',
  'pincode',
  'pan',
  'cvv',
  'cvc',
  'email',
  'phone',
  'phonenumber',
  'dob',
  'dateofbirth',
  'address',
  'points',
  'pointsbalance',
  'nationalid',
  'cnic',
  'taxid',
];

const forbiddenExact = new Set(FORBIDDEN_PERSIST_KEYS);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when this object key is refused by the persistence denylist. "PIN" is matched
 * as a SUFFIX (`pin`, `managerPin`, `operator_pin`) rather than a substring, because
 * a bare `pin` substring would false-positive on ordinary words.
 */
export function isForbiddenPersistKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (forbiddenExact.has(normalized)) return true;
  if (normalized.endsWith('pin') || normalized.includes('pinhash')) return true;
  return FORBIDDEN_PERSIST_KEY_STEMS.some((stem) => normalized.includes(stem));
}

/**
 * Walk a candidate document and refuse it if any key is denylisted or any value is
 * not plain JSON. Returns the offending key path (never the value) or null when the
 * document is safe to persist.
 */
export function findForbiddenPersistPath(value: unknown): { reason: string; path: string } | null {
  // Ancestors only, so a value legitimately referenced twice in a tree is fine and
  // only a genuine cycle is refused.
  const ancestors = new Set<object>();

  const walk = (node: unknown, path: string): { reason: string; path: string } | null => {
    if (node === null) return null;
    const type = typeof node;
    if (type === 'string' || type === 'number' || type === 'boolean') return null;
    if (type !== 'object') return { reason: 'UNSUPPORTED_VALUE', path };
    if (ancestors.has(node as object)) return { reason: 'CYCLE', path };

    const prototype = Object.getPrototypeOf(node);
    if (!Array.isArray(node) && prototype !== Object.prototype && prototype !== null) {
      // Dates, Maps, class instances and host objects are all refused: only plain
      // JSON survives a schema version bump and a structured-clone round trip.
      return { reason: 'UNSUPPORTED_VALUE', path };
    }

    ancestors.add(node as object);
    try {
      if (Array.isArray(node)) {
        for (let index = 0; index < node.length; index += 1) {
          const found = walk(node[index], `${path}[${index}]`);
          if (found) return found;
        }
        return null;
      }
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const childPath = path.length > 0 ? `${path}.${key}` : key;
        if (isForbiddenPersistKey(key)) return { reason: 'FORBIDDEN_FIELD', path: childPath };
        if (child === undefined) continue;
        const found = walk(child, childPath);
        if (found) return found;
      }
      return null;
    } finally {
      ancestors.delete(node as object);
    }
  };

  return walk(value, '');
}

/** Fail-closed guard run on every write. */
export function assertPersistSafe(value: unknown): void {
  const found = findForbiddenPersistPath(value);
  if (!found) return;
  if (found.reason === 'FORBIDDEN_FIELD') {
    throw new PosStorageError(
      'FORBIDDEN_FIELD',
      `Refused to persist a forbidden field at "${found.path}".`,
      found.path
    );
  }
  if (found.reason === 'CYCLE') {
    throw new PosStorageError('CYCLE', `Refused to persist a cyclic value at "${found.path}".`);
  }
  throw new PosStorageError(
    'UNSUPPORTED_VALUE',
    `Refused to persist a non-JSON value at "${found.path || '<root>'}".`,
    found.path
  );
}

// ── Versioned catalog snapshot (criteria 2 and 5) ────────────────────────────

export type PosOrderChannel = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';

export type PosCatalogItem = {
  menuItemId: string;
  productId: string;
  variantId: string | null;
  name: string;
  sortOrder: number;
  /** Server-authored Decimal string, or null when the item has no effective price. */
  price: string | null;
  priceSource: 'OVERRIDE' | 'PUBLICATION_LIST' | 'BASE_LIST' | 'NONE';
  available: boolean;
};

export type PosCatalogSection = {
  sectionId: string;
  name: string;
  sortOrder: number;
  items: PosCatalogItem[];
};

export type PosCatalogSnapshot = {
  /** The server's deterministic effective-menu version (its ETag payload). */
  version: string;
  branchId: string;
  channel: PosOrderChannel;
  publicationId: string;
  channelOpen: boolean;
  menuId: string;
  menuName: string;
  sections: PosCatalogSection[];
  /** Client-origin UTC instant, metadata only — never an ordering or pricing input. */
  fetchedAtClient: string;
};

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PosStorageError('MALFORMED_CATALOG', `Effective menu field ${path} is missing.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PosStorageError('MALFORMED_CATALOG', `Effective menu field ${path} is missing.`);
  }
  return value;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PosStorageError(
      'MALFORMED_CATALOG',
      `Effective menu field ${path} is not an object.`
    );
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new PosStorageError('MALFORMED_CATALOG', `Effective menu field ${path} is not a list.`);
  }
  return value;
}

/**
 * Project the effective-menu response onto the ALLOWLIST the terminal is permitted
 * to keep. Everything not named here is dropped — including the localized name
 * blobs, which are free-form JSON the store has no reason to hold (D20 ships no
 * localized claim). A field added to the server payload later cannot leak into
 * browser storage without a deliberate edit here.
 */
export function sanitizeCatalogSnapshot(
  payload: unknown,
  meta: { version: string; fetchedAtClient: string }
): PosCatalogSnapshot {
  const root = asRecord(payload, 'response');
  const menu = asRecord(root.menu, 'menu');
  const channel = requireString(root.channel, 'channel');
  if (channel !== 'DINE_IN' && channel !== 'TAKEAWAY' && channel !== 'DELIVERY') {
    throw new PosStorageError('MALFORMED_CATALOG', 'Effective menu channel is not a POS channel.');
  }

  const snapshot: PosCatalogSnapshot = {
    version: requireString(meta.version, 'version'),
    branchId: requireString(root.branchId, 'branchId'),
    channel,
    publicationId: requireString(root.publicationId, 'publicationId'),
    channelOpen: root.channelOpen === true,
    menuId: requireString(menu.id, 'menu.id'),
    menuName: requireString(menu.name, 'menu.name'),
    fetchedAtClient: requireString(meta.fetchedAtClient, 'fetchedAtClient'),
    sections: asArray(root.sections, 'sections').map((rawSection, sectionIndex) => {
      const section = asRecord(rawSection, `sections[${sectionIndex}]`);
      return {
        sectionId: requireString(section.id, `sections[${sectionIndex}].id`),
        name: requireString(section.name, `sections[${sectionIndex}].name`),
        sortOrder: requireNumber(section.sortOrder, `sections[${sectionIndex}].sortOrder`),
        items: asArray(section.items, `sections[${sectionIndex}].items`).map(
          (rawItem, itemIndex) => {
            const at = `sections[${sectionIndex}].items[${itemIndex}]`;
            const item = asRecord(rawItem, at);
            const product = asRecord(item.product, `${at}.product`);
            const source = requireString(item.priceSource, `${at}.priceSource`);
            if (
              source !== 'OVERRIDE' &&
              source !== 'PUBLICATION_LIST' &&
              source !== 'BASE_LIST' &&
              source !== 'NONE'
            ) {
              throw new PosStorageError('MALFORMED_CATALOG', `${at}.priceSource is unknown.`);
            }
            return {
              menuItemId: requireString(item.id, `${at}.id`),
              productId: requireString(item.productId, `${at}.productId`),
              variantId: optionalString(item.variantId),
              name: optionalString(item.displayName) ?? requireString(product.name, `${at}.name`),
              sortOrder: requireNumber(item.sortOrder, `${at}.sortOrder`),
              price: optionalString(item.price),
              priceSource: source,
              available: item.available === true,
            } satisfies PosCatalogItem;
          }
        ),
      } satisfies PosCatalogSection;
    }),
  };

  // Belt and braces: the allowlist above already drops unknown fields, but a future
  // edit that widens it still cannot get a denylisted key past this call.
  assertPersistSafe(snapshot);
  return snapshot;
}

/** Look one item up in the cached catalog (an item tap must not need a fetch). */
export function findCatalogItem(
  catalog: PosCatalogSnapshot,
  menuItemId: string
): PosCatalogItem | null {
  for (const section of catalog.sections) {
    for (const item of section.items) {
      if (item.menuItemId === menuItemId) return item;
    }
  }
  return null;
}

export type CatalogRefreshTrigger =
  'UNLOCK' | 'RECONNECT' | 'ONLINE' | 'VISIBILITY' | 'INTERVAL' | 'MANUAL';

/**
 * The refresh policy from M9 §3.6, kept here as a pure decision so the POS surface
 * (L3) only has to wire it to `online`, `visibilitychange`, unlock and a timer.
 * Recovery-shaped triggers always refresh; the periodic tick refreshes at most once
 * per `CATALOG_REFRESH_INTERVAL_MS`, and a terminal with no catalog always refreshes.
 */
export function shouldRefreshCatalog(input: {
  trigger: CatalogRefreshTrigger;
  nowMs: number;
  lastAttemptAtMs: number | null;
  hasCatalog: boolean;
}): boolean {
  if (!input.hasCatalog) return true;
  if (input.trigger !== 'INTERVAL') return true;
  if (input.lastAttemptAtMs === null) return true;
  return input.nowMs - input.lastAttemptAtMs >= CATALOG_REFRESH_INTERVAL_MS;
}

// ── The persisted document ───────────────────────────────────────────────────

/**
 * One terminal's whole local state. `Q` is the queue snapshot owned by
 * `pos-command-queue.ts`; keeping it generic means the queue depends on the store
 * and never the reverse.
 */
export type PosPersistedState<Q = unknown> = {
  schemaVersion: number;
  scope: PosScope;
  catalog: PosCatalogSnapshot | null;
  queue: Q | null;
};

export function emptyPosState<Q>(scope: PosScope): PosPersistedState<Q> {
  return { schemaVersion: POS_STORE_SCHEMA_VERSION, scope, catalog: null, queue: null };
}

// ── The IndexedDB seam ───────────────────────────────────────────────────────

/**
 * The whole browser-storage surface the POS is allowed to use. One document per
 * scope key, read/written/removed whole — which is exactly why a catalog + draft +
 * queue update is atomic (criterion 2).
 */
export interface PosStorageDriver {
  read(scopeKey: string): Promise<unknown>;
  write(scopeKey: string, record: unknown): Promise<void>;
  remove(scopeKey: string): Promise<void>;
  close(): void;
}

/** The ambient IndexedDB factory, or null where there is none (SSR, jsdom). */
export function resolveIndexedDbFactory(): IDBFactory | null {
  const candidate = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  return candidate ?? null;
}

export function isPosStoreSupported(): boolean {
  return resolveIndexedDbFactory() !== null;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/**
 * The native driver. Opens (and upgrades to) `POS_STORE_SCHEMA_VERSION`, then runs
 * every operation in its own transaction. `write` is a single `put` of the whole
 * document, so a torn catalog/queue pair is not representable.
 */
export function createIndexedDbDriver(factory: IDBFactory | null = null): PosStorageDriver {
  const idb = factory ?? resolveIndexedDbFactory();
  if (!idb) {
    throw new PosStorageError(
      'UNSUPPORTED_ENVIRONMENT',
      'This browser exposes no IndexedDB; POS local state is unavailable.'
    );
  }

  let open: Promise<IDBDatabase> | null = null;

  const database = (): Promise<IDBDatabase> => {
    open ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.open(POS_STORE_DATABASE_NAME, POS_STORE_SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(POS_STORE_OBJECT_STORE)) {
          db.createObjectStore(POS_STORE_OBJECT_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another tab.'));
    });
    return open;
  };

  /** Run one request and resolve only once its transaction has actually committed —
   * a resolved `write` therefore means the document is durable, not merely queued. */
  const transact = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> => {
    const db = await database();
    const tx = db.transaction(POS_STORE_OBJECT_STORE, mode);
    const request = run(tx.objectStore(POS_STORE_OBJECT_STORE));
    const value = await requestToPromise(request);
    if (mode === 'readonly') return value;
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    });
    return value;
  };

  return {
    read: (scopeKey) => transact('readonly', (store) => store.get(scopeKey)),
    write: async (scopeKey, record) => {
      await transact('readwrite', (store) => store.put(record, scopeKey));
    },
    remove: async (scopeKey) => {
      await transact('readwrite', (store) => store.delete(scopeKey));
    },
    close: () => {
      const opened = open;
      open = null;
      void opened?.then((db) => db.close()).catch(() => undefined);
    },
  };
}

/**
 * An in-memory driver with the same contract. Used by the L1 battery (jsdom has no
 * IndexedDB and M9 authorizes no new dependency) and as the honest degraded mode on
 * a browser or private-mode session that refuses persistent storage: local state
 * still works for the tab, it just does not survive a reload.
 */
export function createMemoryDriver(seed?: Iterable<readonly [string, unknown]>): PosStorageDriver {
  const rows = new Map<string, string>();
  for (const [key, value] of seed ?? []) rows.set(key, JSON.stringify(value));
  return {
    read: async (scopeKey) => {
      const raw = rows.get(scopeKey);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    write: async (scopeKey, record) => {
      rows.set(scopeKey, JSON.stringify(record));
    },
    remove: async (scopeKey) => {
      rows.delete(scopeKey);
    },
    close: () => undefined,
  };
}

// ── Read / write / purge ─────────────────────────────────────────────────────

export type PosStoreReadResult<Q> =
  | { status: 'ok'; state: PosPersistedState<Q> }
  | { status: 'empty' }
  | {
      status: 'unrecoverable';
      reason: 'SCHEMA_VERSION' | 'CORRUPT' | 'SCOPE_MISMATCH';
      foundSchemaVersion: number | null;
      message: string;
    };

/**
 * Read this scope's document. A missing document is `empty` (a fresh terminal); a
 * document written by another schema version, another scope, or a corrupt one is
 * `unrecoverable` — the caller must NOT guess at it, it must offer recovery
 * (discard local state and re-sync) as criterion 2 requires.
 */
export async function readPosState<Q>(
  driver: PosStorageDriver,
  scope: PosScope
): Promise<PosStoreReadResult<Q>> {
  const key = posScopeKey(scope);
  let raw: unknown;
  try {
    raw = await driver.read(key);
  } catch {
    return {
      status: 'unrecoverable',
      reason: 'CORRUPT',
      foundSchemaVersion: null,
      message: 'Local POS storage could not be read. Discard local state and re-sync.',
    };
  }
  if (raw === undefined || raw === null) return { status: 'empty' };

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      status: 'unrecoverable',
      reason: 'CORRUPT',
      foundSchemaVersion: null,
      message: 'Local POS storage holds an unreadable record. Discard local state and re-sync.',
    };
  }
  const record = raw as Partial<PosPersistedState<Q>>;
  const found = typeof record.schemaVersion === 'number' ? record.schemaVersion : null;
  if (found !== POS_STORE_SCHEMA_VERSION) {
    return {
      status: 'unrecoverable',
      reason: 'SCHEMA_VERSION',
      foundSchemaVersion: found,
      message: 'Local POS storage was written by a different app version. Re-sync to continue.',
    };
  }
  const storedScope = record.scope;
  if (
    typeof storedScope !== 'object' ||
    storedScope === null ||
    !sameScope(storedScope as PosScope, scope)
  ) {
    return {
      status: 'unrecoverable',
      reason: 'SCOPE_MISMATCH',
      foundSchemaVersion: found,
      message: 'Local POS storage belongs to a different terminal. Re-sync to continue.',
    };
  }
  return {
    status: 'ok',
    state: {
      schemaVersion: POS_STORE_SCHEMA_VERSION,
      scope: { ...scope },
      catalog: (record.catalog ?? null) as PosCatalogSnapshot | null,
      queue: (record.queue ?? null) as Q | null,
    },
  };
}

/**
 * Persist this scope's whole document in one atomic write, after the minimization
 * guard. A forbidden field throws BEFORE anything reaches the browser.
 */
export async function writePosState<Q>(
  driver: PosStorageDriver,
  state: PosPersistedState<Q>
): Promise<void> {
  if (state.schemaVersion !== POS_STORE_SCHEMA_VERSION) {
    throw new PosStorageError('SCHEMA_VERSION', 'Refused to persist a foreign schema version.');
  }
  assertPersistSafe(state);
  await driver.write(posScopeKey(state.scope), state);
}

/**
 * Drop this terminal's whole document. This is the confirmed-revocation purge path
 * (M9 amendment §2.2 / criterion 4) and the recovery path for an unrecoverable read.
 */
export async function purgePosScope(driver: PosStorageDriver, scope: PosScope): Promise<void> {
  await driver.remove(posScopeKey(scope));
}
