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
  afterTransaction: (() => void | Promise<void>)[];
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

/** Defer independent work until the owning transaction releases its connection. */
export function afterTenantTransaction(work: () => void | Promise<void>): void | Promise<void> {
  const scope = storage.getStore();
  if (scope) scope.afterTransaction.push(work);
  else return work();
}

export function bindSideEffects<T>(run: (scope: SideEffectScope) => Promise<T>): Promise<T> {
  const pending: Promise<unknown>[] = [];
  const scope: SideEffectScope = {
    pending,
    enqueued: false,
    afterTransaction: [],
    flush: () => Promise.all(pending).then(() => undefined),
    settle: () => Promise.allSettled(pending).then(() => undefined),
  };
  return storage.run(scope, () => run(scope));
}
