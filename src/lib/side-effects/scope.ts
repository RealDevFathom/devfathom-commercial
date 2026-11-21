import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Tracks work that must commit with the current tenant transaction (an outbox
 * row) and run only after that transaction commits (SMTP, outbound HTTP).
 * Absent outside `withTenantDb`, so unit tests and one-off calls keep the
 * immediate path.
 */
export type SideEffectScope = {
  pending: Promise<unknown>[];
  enqueued: boolean;
  afterTransaction: (() => void)[];
  afterCommit: (() => Promise<void>)[];
  flush: () => Promise<void>;
  settle: () => Promise<void>;
};

const storage = new AsyncLocalStorage<SideEffectScope>();

export function inSideEffectScope(): boolean {
  return storage.getStore() !== undefined;
}

/** Register persistence that has to finish before the transaction commits. */
export function trackSideEffect(work: Promise<unknown>): void {
  const scope = storage.getStore();
  if (!scope) return;
  scope.pending.push(work);
  scope.enqueued = true;
}

/** Keep transaction-local work alive without scheduling an outbox drain. */
export function trackTransactionWork(work: Promise<unknown>): void {
  const scope = storage.getStore();
  if (scope) scope.pending.push(work);
}

/** A separately scoped write must wait for the tenant transaction to commit. */
export async function afterTenantCommit(work: () => Promise<void>): Promise<void> {
  const scope = storage.getStore();
  if (scope) scope.afterCommit.push(work);
  else await work();
}

/** Defer independent work until the owning transaction releases its connection. */
export function afterTenantTransaction(work: () => void): void {
  const scope = storage.getStore();
  if (scope) scope.afterTransaction.push(work);
  else work();
}

/**
 * Wait until every registered piece of work has finished, including work that
 * is registered while an earlier piece is still in flight. A single
 * `Promise.all(pending)` only sees the array as it was when called, so an
 * activity insert registered from a continuation would be left running after
 * the transaction closed and be rejected with P2028.
 */
async function waitForAll(
  pending: Promise<unknown>[],
  wait: (batch: Promise<unknown>[]) => Promise<unknown>
): Promise<void> {
  let waited = 0;
  while (waited < pending.length) {
    const batch = pending.slice(waited);
    waited = pending.length;
    await wait(batch);
  }
}

export function bindSideEffects<T>(run: (scope: SideEffectScope) => Promise<T>): Promise<T> {
  const pending: Promise<unknown>[] = [];
  const scope: SideEffectScope = {
    pending,
    enqueued: false,
    afterTransaction: [],
    afterCommit: [],
    flush: () => waitForAll(pending, (batch) => Promise.all(batch)),
    settle: () => waitForAll(pending, (batch) => Promise.allSettled(batch)),
  };
  return storage.run(scope, () => run(scope));
}
