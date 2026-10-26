/**
 * The RETAIL TERMINAL seam (PRD §11): one enrolled counter's client-side local
 * store, shared by the Restaurant POS and the Pharmacy counter.
 *
 * This module is an EXTRACTION, not a new design. Every rule below already
 * governed `src/lib/restaurant/pos-client-store.ts` and is reproduced verbatim;
 * that module now re-exports these symbols under its original names, so the
 * Restaurant behaviour is unchanged and there is exactly one implementation.
 *
 * Only the pieces whose invariant is IDENTICAL across the two verticals live
 * here. What stayed behind in each vertical is the part that is not: the
 * catalogue projection (a menu is not a medicine catalogue), the command shapes
 * and the replay routes.
 *
 * The three properties this seam owns:
 *
 *  1. **A native IndexedDB seam.** One tiny driver interface with a native
 *     implementation and an in-memory implementation for tests/SSR. No service
 *     worker, PWA runtime, sync library or second database — jsdom ships no
 *     IndexedDB, so the seam is how the batteries run without a dependency.
 *  2. **A schema-versioned, scope-partitioned record.** Exactly one document per
 *     `organization + branch + device`. Catalog, drafts and queue live in that
 *     single document, so every write is one `put` inside one IndexedDB
 *     transaction. An unknown schema version or a corrupt/foreign document FAILS
 *     CLOSED: the read reports `unrecoverable` and the caller shows recovery UI
 *     instead of guessing.
 *  3. **Storage minimization, enforced not documented.** Every write is walked by
 *     `assertPersistSafe`, which throws on a forbidden key (device/enrollment
 *     secrets, session tokens, operator/manager PINs, customer or loyalty fields,
 *     tender/payment/card values) and on any non-JSON value. Each vertical stores
 *     its catalogue through its own ALLOWLIST projection, so an added server
 *     field cannot leak in by default.
 *
 * Client-origin time is persisted as metadata only; server time stays
 * authoritative and queue ordering uses a persisted sequence, never a clock.
 *
 * CLIENT-SAFE: it never imports `server-only`, Prisma or any auth helper, so
 * bundling it into a terminal page cannot drag a server module across the
 * boundary.
 */

// ── Errors ───────────────────────────────────────────────────────────────────

export type TerminalStorageErrorReason =
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
export class TerminalStorageError extends Error {
  readonly reason: TerminalStorageErrorReason;
  readonly path: string | null;

  constructor(reason: TerminalStorageErrorReason, message: string, path: string | null = null) {
    super(message);
    this.name = 'TerminalStorageError';
    this.reason = reason;
    this.path = path;
  }
}

// ── Scope partitioning ───────────────────────────────────────────────────────

export type TerminalScope = {
  organizationId: string;
  branchId: string;
  deviceId: string;
};

const SCOPE_SEPARATOR = '::';

/**
 * The IndexedDB key for one terminal's document. Partitioning by organization,
 * branch AND device is what makes a re-enrolled or re-branched terminal read as
 * "empty" rather than inheriting another scope's catalog and drafts.
 */
export function terminalScopeKey(scope: TerminalScope): string {
  for (const [field, value] of Object.entries(scope)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TerminalStorageError(
        'INVALID_SCOPE',
        `Scope field ${field} must be a non-empty id.`
      );
    }
    if (value.includes(SCOPE_SEPARATOR)) {
      throw new TerminalStorageError(
        'INVALID_SCOPE',
        `Scope field ${field} must not contain "${SCOPE_SEPARATOR}".`
      );
    }
  }
  return [scope.organizationId, scope.branchId, scope.deviceId].join(SCOPE_SEPARATOR);
}

export function sameTerminalScope(a: TerminalScope, b: TerminalScope): boolean {
  return (
    a.organizationId === b.organizationId && a.branchId === b.branchId && a.deviceId === b.deviceId
  );
}

// ── Storage minimization ─────────────────────────────────────────────────────

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
  'wallet',
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
    throw new TerminalStorageError(
      'FORBIDDEN_FIELD',
      `Refused to persist a forbidden field at "${found.path}".`,
      found.path
    );
  }
  if (found.reason === 'CYCLE') {
    throw new TerminalStorageError(
      'CYCLE',
      `Refused to persist a cyclic value at "${found.path}".`
    );
  }
  throw new TerminalStorageError(
    'UNSUPPORTED_VALUE',
    `Refused to persist a non-JSON value at "${found.path || '<root>'}".`,
    found.path
  );
}

// ── The IndexedDB seam ───────────────────────────────────────────────────────

/**
 * The whole browser-storage surface a terminal is allowed to use. One document per
 * scope key, read/written/removed whole — which is exactly why a catalog + draft +
 * queue update is atomic.
 */
export interface TerminalStorageDriver {
  read(scopeKey: string): Promise<unknown>;
  write(scopeKey: string, record: unknown): Promise<void>;
  /** Atomically replace a record only when it still equals the value last read. */
  compareAndSwap(scopeKey: string, expected: unknown, record: unknown): Promise<boolean>;
  remove(scopeKey: string): Promise<void>;
  close(): void;
}

/**
 * Which IndexedDB database a vertical's terminal writes to. Two verticals never
 * share a database name, so a device enrolled in both cannot read the other's
 * documents even before the scope check runs.
 */
export type TerminalStoreDatabase = {
  databaseName: string;
  objectStoreName: string;
  schemaVersion: number;
};

/** The ambient IndexedDB factory, or null where there is none (SSR, jsdom). */
export function resolveIndexedDbFactory(): IDBFactory | null {
  const candidate = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  return candidate ?? null;
}

export function isTerminalStoreSupported(): boolean {
  return resolveIndexedDbFactory() !== null;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/**
 * The native driver. Opens (and upgrades to) the database's schema version, then
 * runs every operation in its own transaction. `write` is a single `put` of the
 * whole document, so a torn catalog/queue pair is not representable.
 */
export function createTerminalIndexedDbDriver(
  database: TerminalStoreDatabase,
  factory: IDBFactory | null = null
): TerminalStorageDriver {
  const idb = factory ?? resolveIndexedDbFactory();
  if (!idb) {
    throw new TerminalStorageError(
      'UNSUPPORTED_ENVIRONMENT',
      'This browser exposes no IndexedDB; terminal local state is unavailable.'
    );
  }

  let open: Promise<IDBDatabase> | null = null;

  const connection = (): Promise<IDBDatabase> => {
    open ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.open(database.databaseName, database.schemaVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(database.objectStoreName)) {
          db.createObjectStore(database.objectStoreName);
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
    const db = await connection();
    const tx = db.transaction(database.objectStoreName, mode);
    const request = run(tx.objectStore(database.objectStoreName));
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
    compareAndSwap: async (scopeKey, expected, record) => {
      const db = await connection();
      const tx = db.transaction(database.objectStoreName, 'readwrite');
      const settled = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
      });
      const store = tx.objectStore(database.objectStoreName);
      const current = await requestToPromise(store.get(scopeKey));
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        // Let the read-only transaction finish normally. Resolving only after
        // completion keeps the CAS contract durable for both outcomes and
        // avoids surfacing an intentional mismatch as an abort error.
        await settled;
        return false;
      }
      await requestToPromise(store.put(record, scopeKey));
      await settled;
      return true;
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
 * An in-memory driver with the same contract. Used by the unit batteries (jsdom has
 * no IndexedDB and neither vertical authorizes a new dependency) and as the honest
 * degraded mode on a browser or private-mode session that refuses persistent
 * storage: local state still works for the tab, it just does not survive a reload.
 */
export function createMemoryDriver(
  seed?: Iterable<readonly [string, unknown]>
): TerminalStorageDriver {
  const rows = new Map<string, string>();
  let mutationTail: Promise<void> = Promise.resolve();
  for (const [key, value] of seed ?? []) rows.set(key, JSON.stringify(value));
  return {
    read: async (scopeKey) => {
      const raw = rows.get(scopeKey);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    write: async (scopeKey, record) => {
      rows.set(scopeKey, JSON.stringify(record));
    },
    compareAndSwap: (scopeKey, expected, record) => {
      const operation = mutationTail.then(() => {
        const current = rows.get(scopeKey);
        const expectedJson = expected === undefined ? undefined : JSON.stringify(expected);
        if (current !== expectedJson) return false;
        rows.set(scopeKey, JSON.stringify(record));
        return true;
      });
      mutationTail = operation.then(
        () => undefined,
        () => undefined
      );
      return operation;
    },
    remove: async (scopeKey) => {
      rows.delete(scopeKey);
    },
    close: () => undefined,
  };
}

// ── The persisted document ───────────────────────────────────────────────────

/**
 * One terminal's whole local state. `Q` is the queue snapshot and `C` the cached
 * catalogue projection, both owned by the vertical; keeping them generic means the
 * vertical depends on this seam and never the reverse.
 */
export type PersistedTerminalState<Q = unknown, C = unknown> = {
  schemaVersion: number;
  scope: TerminalScope;
  catalog: C | null;
  queue: Q | null;
};

export function emptyTerminalState<Q, C>(
  scope: TerminalScope,
  schemaVersion: number
): PersistedTerminalState<Q, C> {
  return { schemaVersion, scope, catalog: null, queue: null };
}

// ── Read / write / purge ─────────────────────────────────────────────────────

export type TerminalStoreReadResult<Q, C> =
  | { status: 'ok'; state: PersistedTerminalState<Q, C> }
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
 * (discard local state and re-sync).
 */
export async function readTerminalState<Q, C>(
  driver: TerminalStorageDriver,
  scope: TerminalScope,
  schemaVersion: number
): Promise<TerminalStoreReadResult<Q, C>> {
  const key = terminalScopeKey(scope);
  let raw: unknown;
  try {
    raw = await driver.read(key);
  } catch {
    return {
      status: 'unrecoverable',
      reason: 'CORRUPT',
      foundSchemaVersion: null,
      message: 'Local terminal storage could not be read. Discard local state and re-sync.',
    };
  }
  if (raw === undefined || raw === null) return { status: 'empty' };

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      status: 'unrecoverable',
      reason: 'CORRUPT',
      foundSchemaVersion: null,
      message:
        'Local terminal storage holds an unreadable record. Discard local state and re-sync.',
    };
  }
  const record = raw as Partial<PersistedTerminalState<Q, C>>;
  const found = typeof record.schemaVersion === 'number' ? record.schemaVersion : null;
  if (found !== schemaVersion) {
    return {
      status: 'unrecoverable',
      reason: 'SCHEMA_VERSION',
      foundSchemaVersion: found,
      message:
        'Local terminal storage was written by a different app version. Re-sync to continue.',
    };
  }
  const storedScope = record.scope;
  if (
    typeof storedScope !== 'object' ||
    storedScope === null ||
    !sameTerminalScope(storedScope as TerminalScope, scope)
  ) {
    return {
      status: 'unrecoverable',
      reason: 'SCOPE_MISMATCH',
      foundSchemaVersion: found,
      message: 'Local terminal storage belongs to a different terminal. Re-sync to continue.',
    };
  }
  return {
    status: 'ok',
    state: {
      schemaVersion,
      scope: { ...scope },
      catalog: (record.catalog ?? null) as C | null,
      queue: (record.queue ?? null) as Q | null,
    },
  };
}

/**
 * Persist this scope's whole document in one atomic write, after the minimization
 * guard. A forbidden field throws BEFORE anything reaches the browser.
 */
export async function writeTerminalState<Q, C>(
  driver: TerminalStorageDriver,
  state: PersistedTerminalState<Q, C>,
  schemaVersion: number
): Promise<void> {
  if (state.schemaVersion !== schemaVersion) {
    throw new TerminalStorageError(
      'SCHEMA_VERSION',
      'Refused to persist a foreign schema version.'
    );
  }
  assertPersistSafe(state);
  await driver.write(terminalScopeKey(state.scope), state);
}

/**
 * Drop this terminal's whole document. This is the confirmed-revocation purge path
 * and the recovery path for an unrecoverable read.
 */
export async function purgeTerminalScope(
  driver: TerminalStorageDriver,
  scope: TerminalScope
): Promise<void> {
  await driver.remove(terminalScopeKey(scope));
}
