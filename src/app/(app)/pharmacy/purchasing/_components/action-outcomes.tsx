'use client';

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';

export type PurchasingOperation = {
  resource: string;
  action: string;
  affectedResources?: string[];
};

/** Both allocation presentations address the same live credit/debit pair.
 * Amount changes do not constitute a fresh attempt for a completed pair in this
 * page lifetime. Server money parsing and validation remain authoritative.
 */
export function allocationOperation(form: FormData): PurchasingOperation {
  const value = (name: string) => String(form.get(name) ?? '').trim();
  const branch = value('branchId');
  const credit = value('supplierCreditId');
  const debit = value('debitNoteId');
  return {
    resource: JSON.stringify(['allocation', branch, credit, debit]),
    action: 'allocate',
    affectedResources: [
      ...(credit ? [JSON.stringify(['credit', branch, credit])] : []),
      ...(debit ? [JSON.stringify(['debit-note', branch, debit])] : []),
    ],
  };
}
type Attempt = PurchasingOperation &
  (
    | { phase: 'pending' }
    | { phase: 'uncertain' }
    | { phase: 'committed'; message: string; href: string; refreshFailed?: boolean }
    | { phase: 'rejected'; message: string; field: string | null }
  );
const emptyAttempts: ReadonlyMap<string, Attempt> = new Map();
const serverSnapshot = () => emptyAttempts;
export const operationKey = (operation: PurchasingOperation) =>
  JSON.stringify([operation.resource, operation.action]);

function blocked(attempts: ReadonlyMap<string, Attempt>, operation: PurchasingOperation) {
  const current = attempts.get(operationKey(operation));
  if (current && current.phase !== 'rejected') return true;
  // A new control is not evidence that an earlier uncertain write is safe.
  return [...attempts.values()].some(
    (attempt) =>
      (attempt.resource === operation.resource ||
        attempt.affectedResources?.some((resource) =>
          operation.affectedResources?.includes(resource)
        )) &&
      (attempt.phase === 'pending' || attempt.phase === 'uncertain')
  );
}

function createOutcomes() {
  let attempts = emptyAttempts;
  const listeners = new Set<() => void>();
  function publish(operation: PurchasingOperation, attempt: Attempt) {
    attempts = new Map(attempts).set(operationKey(operation), attempt);
    listeners.forEach((listener) => listener());
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => attempts,
    begin(operation: PurchasingOperation) {
      if (blocked(attempts, operation)) return false;
      publish(operation, { ...operation, phase: 'pending' });
      return true;
    },
    reject(operation: PurchasingOperation, message: string, field: string | null) {
      publish(operation, { ...operation, phase: 'rejected', message, field });
    },
    commit(operation: PurchasingOperation, message: string, href: string) {
      publish(operation, { ...operation, phase: 'committed', message, href });
    },
    fail(operation: PurchasingOperation) {
      const previous = attempts.get(operationKey(operation));
      publish(
        operation,
        previous?.phase === 'committed'
          ? { ...previous, refreshFailed: true }
          : { ...operation, phase: 'uncertain' }
      );
    },
  };
}

const OutcomeContext = createContext<ReturnType<typeof createOutcomes> | null>(null);

/** Page lifetime, not conditional form lifetime. No global or cross-tenant storage. */
export function PurchasingOutcomeScope({ children }: { children: ReactNode }) {
  const [store] = useState(createOutcomes);
  return (
    <OutcomeContext.Provider value={store}>
      <div className="min-w-0 space-y-6">{children}</div>
    </OutcomeContext.Provider>
  );
}

export function usePurchasingOutcome(operation: PurchasingOperation) {
  const shared = useContext(OutcomeContext);
  const [local] = useState(createOutcomes);
  const store = shared ?? local;
  const attempts = useSyncExternalStore(store.subscribe, store.snapshot, serverSnapshot);
  return {
    store,
    shared: shared !== null,
    attempt: attempts.get(operationKey(operation)),
    blocked: blocked(attempts, operation),
  };
}

export function PurchasingOutcomes() {
  const store = useContext(OutcomeContext);
  if (!store) throw new Error('PurchasingOutcomes requires its page scope');
  return <OutcomeList store={store} />;
}

function OutcomeList({ store }: { store: ReturnType<typeof createOutcomes> }) {
  const attempts = useSyncExternalStore(store.subscribe, store.snapshot, serverSnapshot);
  return (
    <>
      {[...attempts].map(([key, attempt]) => (
        <PurchasingOutcome key={key} attempt={attempt} />
      ))}
    </>
  );
}

export function PurchasingOutcome({ attempt }: { attempt: Attempt | undefined }) {
  if (!attempt || attempt.phase === 'rejected') return null;
  if (attempt.phase === 'pending') return <p role="status">Saving and loading the outcome…</p>;
  if (attempt.phase === 'uncertain')
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not confirm the outcome. Reload this page and check the record before retrying.
      </p>
    );
  return (
    <div className="space-y-2">
      <p role="status" className="text-sm text-success">
        {attempt.message} Check the updated record before starting another change.
      </p>
      <a
        href={attempt.href}
        className="inline-flex min-h-11 items-center rounded-[var(--radius-sm)] text-sm font-medium text-primary underline underline-offset-4 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
      >
        View saved record
      </a>
      <p className="text-xs text-text-muted">
        Opening the record leaves this page. Save unrelated drafts first.
      </p>
      {attempt.refreshFailed ? (
        <p role="alert" className="text-sm text-destructive">
          The change was saved, but the records could not be refreshed. Check the record before
          retrying.
        </p>
      ) : null}
    </div>
  );
}
