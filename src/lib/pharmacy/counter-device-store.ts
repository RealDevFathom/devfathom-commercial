/**
 * DEV-957 phase 1: what this browser remembers about being an enrolled counter.
 *
 * Two places, both free of the device secret:
 *
 *  - an IndexedDB database of its own (`devfathom-pharmacy-counter-device`,
 *    object store `device-keys`), separate from the offline scope document,
 *    holding the enrolment (organization, branch, device id, name) and the
 *    NON-EXTRACTABLE WebCrypto signing key imported from the secret at
 *    enrolment. IndexedDB stores a CryptoKey by structured clone, and a
 *    non-extractable key stays non-extractable there: no script can read the
 *    secret back out of it;
 *  - a localStorage mirror of the enrolment WITHOUT the key, so the counter can
 *    pick the enrolled device id for its drawer synchronously on render.
 *
 * The raw secret goes to the server once more, to be set as the httpOnly device
 * cookie (`/api/pharmacy/counter/bind`), and is then dropped. Every write here
 * refuses a record that carries anything shaped like a device secret.
 */

export const COUNTER_DEVICE_DATABASE = 'devfathom-pharmacy-counter-device';
export const COUNTER_DEVICE_STORE = 'device-keys';
export const COUNTER_ENROLMENT_MIRROR_KEY = 'devfathom.pharmacy.counter.enrolled';
/** Fired on window when this browser's enrolment changes, for same-tab readers. */
export const COUNTER_ENROLMENT_EVENT = 'devfathom:pharmacy-counter-enrolment';

export type CounterEnrolment = {
  organizationId: string;
  branchId: string;
  deviceId: string;
  name: string;
  enrolledAt: string;
};

export type StoredCounterEnrolment = CounterEnrolment & { signingKey: CryptoKey };

/** The minimal key-value seam, so tests can run without a browser. */
export interface CounterDeviceKeyBackend {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const SECRET_SHAPE = /pcd_[A-Za-z0-9_-]{20,}/;

/** Throws when a value (deeply) carries a device secret or a secret-named field. */
export function assertNoDeviceSecret(value: unknown, path = 'record'): void {
  if (typeof value === 'string') {
    if (SECRET_SHAPE.test(value)) throw new Error(`Refused to store a device secret at ${path}.`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) return;
  for (const [key, child] of Object.entries(value)) {
    if (/secret|token|password|credential|^pin$/i.test(key))
      throw new Error(`Refused to store a field named "${key}" at ${path}.`);
    assertNoDeviceSecret(child, `${path}.${key}`);
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/** The browser backend. Each call resolves only after its transaction committed. */
export function indexedDbDeviceKeyBackend(
  factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB
): CounterDeviceKeyBackend {
  if (!factory) throw new Error('This browser has no IndexedDB; it cannot be an offline counter.');
  let open: Promise<IDBDatabase> | null = null;
  const connection = () => {
    open ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(COUNTER_DEVICE_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(COUNTER_DEVICE_STORE))
          request.result.createObjectStore(COUNTER_DEVICE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
      request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'));
    });
    return open;
  };
  const write = async (run: (store: IDBObjectStore) => IDBRequest) => {
    const db = await connection();
    const tx = db.transaction(COUNTER_DEVICE_STORE, 'readwrite');
    run(tx.objectStore(COUNTER_DEVICE_STORE));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    });
  };
  return {
    get: async (key) => {
      const db = await connection();
      return requestResult(
        db.transaction(COUNTER_DEVICE_STORE, 'readonly').objectStore(COUNTER_DEVICE_STORE).get(key)
      );
    },
    put: (key, value) => write((store) => store.put(value, key)),
    delete: (key) => write((store) => store.delete(key)),
  };
}

/** For tests: keeps values by reference, as structured clone keeps a CryptoKey. */
export function memoryDeviceKeyBackend(): CounterDeviceKeyBackend & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async (key) => rows.get(key),
    put: async (key, value) => {
      rows.set(key, value);
    },
    delete: async (key) => {
      rows.delete(key);
    },
  };
}

function isEnrolment(value: unknown): value is CounterEnrolment {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['organizationId', 'branchId', 'deviceId', 'name', 'enrolledAt'].every(
    (field) => typeof row[field] === 'string' && (row[field] as string).length > 0
  );
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function announce() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(COUNTER_ENROLMENT_EVENT));
}

/** The enrolment mirror, read synchronously. Never carries the key or the secret. */
export function readCounterEnrolmentMirror(): CounterEnrolment | null {
  try {
    const raw = storage()?.getItem(COUNTER_ENROLMENT_MIRROR_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isEnrolment(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveCounterEnrolment(
  backend: CounterDeviceKeyBackend,
  record: StoredCounterEnrolment
): Promise<void> {
  if (!isEnrolment(record)) throw new Error('A counter enrolment needs its branch and device.');
  if (record.signingKey.extractable)
    throw new Error('Refused to store an extractable counter signing key.');
  const enrolment: CounterEnrolment = {
    organizationId: record.organizationId,
    branchId: record.branchId,
    deviceId: record.deviceId,
    name: record.name,
    enrolledAt: record.enrolledAt,
  };
  assertNoDeviceSecret(enrolment);
  await backend.put(record.organizationId, { ...enrolment, signingKey: record.signingKey });
  storage()?.setItem(COUNTER_ENROLMENT_MIRROR_KEY, JSON.stringify(enrolment));
  announce();
}

export async function readCounterEnrolment(
  backend: CounterDeviceKeyBackend,
  organizationId: string
): Promise<StoredCounterEnrolment | null> {
  const value = await backend.get(organizationId);
  if (!isEnrolment(value) || value.organizationId !== organizationId) return null;
  const key = (value as { signingKey?: unknown }).signingKey;
  if (typeof CryptoKey === 'undefined' || !(key instanceof CryptoKey)) return null;
  return { ...value, signingKey: key };
}

export async function forgetCounterEnrolment(
  backend: CounterDeviceKeyBackend,
  organizationId: string
): Promise<void> {
  await backend.delete(organizationId);
  const mirror = readCounterEnrolmentMirror();
  if (!mirror || mirror.organizationId === organizationId)
    storage()?.removeItem(COUNTER_ENROLMENT_MIRROR_KEY);
  announce();
}

/** The enrolled device id for this organization and branch, or null. Synchronous. */
export function enrolledCounterDeviceId(scope: {
  organizationId: string;
  branchId: string;
}): string | null {
  const mirror = readCounterEnrolmentMirror();
  return mirror &&
    mirror.organizationId === scope.organizationId &&
    mirror.branchId === scope.branchId
    ? mirror.deviceId
    : null;
}

/** For useSyncExternalStore: this tab's enrolment changes and other tabs' (storage). */
export function subscribeCounterEnrolment(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === COUNTER_ENROLMENT_MIRROR_KEY) onChange();
  };
  window.addEventListener(COUNTER_ENROLMENT_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(COUNTER_ENROLMENT_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** The raw mirror string, a stable snapshot for useSyncExternalStore. */
export function readCounterEnrolmentMirrorRaw(): string | null {
  try {
    return storage()?.getItem(COUNTER_ENROLMENT_MIRROR_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Parse a raw mirror string as `readCounterEnrolmentMirror` does. */
export function parseCounterEnrolmentMirror(raw: string | null): CounterEnrolment | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isEnrolment(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
