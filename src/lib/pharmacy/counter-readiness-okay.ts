/**
 * DEV-970: the "Okay" a cashier gave the counter's ready-to-sell panel.
 *
 * Display only: the server still refuses every bill it refused before. What is kept is the
 * list of reasons the person acknowledged, for this person, branch and computer, in
 * `sessionStorage`, so it survives a reload but not the browser session. A reason the
 * person has not acknowledged brings the panel back in full; a reason that was fixed simply
 * drops out. Sign-out (and a session that ended) clears every entry, so a new sign-in sees
 * the panel in full again.
 *
 * Storage can be blocked or full; then the Okay holds for this page only and nothing throws.
 */

const PREFIX = 'devfathom.pharmacy.counter.readiness-okay.v1:';

export type CounterReadinessOkayScope = {
  organizationId: string;
  accountId: string;
  branchId: string;
  /** `null` before the counter has its device id (server render, blocked storage). */
  deviceId: string | null;
};

/** Holds an Okay only when `sessionStorage` refused to keep it. */
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function counterReadinessOkayKey(scope: CounterReadinessOkayScope): string {
  return `${PREFIX}${JSON.stringify([
    scope.organizationId,
    scope.accountId,
    scope.branchId,
    scope.deviceId ?? '',
  ])}`;
}

export function subscribeCounterReadinessOkay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The stored value as a string, so it is a stable `useSyncExternalStore` snapshot. */
export function readCounterReadinessOkay(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

/** The reason codes the stored value acknowledges; `null` for none or anything unreadable. */
export function acknowledgedReadinessReasons(raw: string | null): readonly string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((code) => typeof code === 'string')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Records an Okay for exactly these reasons, or (`null`) takes it back. */
export function writeCounterReadinessOkay(key: string, reasons: readonly string[] | null): void {
  const raw = reasons === null ? null : JSON.stringify([...new Set(reasons)].sort());
  try {
    if (raw === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, raw);
    memory.delete(key);
  } catch {
    if (raw === null) memory.delete(key);
    else memory.set(key, raw);
  }
  notify();
}

/** Forgets every Okay in this browser tab. Never throws. */
export function clearCounterReadinessOkay(): void {
  memory.clear();
  try {
    const storage = window.sessionStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Nothing stored then: the in-memory fallback above is already empty.
  }
  notify();
}
